import { DurableObject } from "cloudflare:workers";
import { blocked, charge, getUser, refund, refundStatement } from "./db";
import { hasContact } from "./privacy";
import { sessionAction, type Escrow } from "./session";
import { profile, TelegramError, tell } from "./telegram";
import {
  DAY,
  FREE_FILTERS,
  menu,
  UserError,
  type ChatRequest,
  type Env,
  type Filters,
  type User,
} from "./types";

interface Entry {
  id: number;
  filters: Filters;
  key: string;
  joined: number;
  cost: number;
}
interface Pair {
  id: string;
  a: number;
  b: number;
  escrows: Escrow[];
  requestId?: string;
}
export function filtered(f: Filters): boolean {
  return f.gender !== "ANY" || f.minAge !== 18 || f.maxAge !== 99 || f.location !== "ANY";
}
export function accepts(f: Filters, seeker: User, candidate: User): boolean {
  return (
    (f.gender === "ANY" || f.gender === candidate.gender) &&
    candidate.age >= f.minAge &&
    candidate.age <= f.maxAge &&
    (f.location === "ANY" ||
      (f.location === "CITY"
        ? seeker.location_label === candidate.location_label
        : seeker.geohash.slice(0, 3) === candidate.geohash.slice(0, 3)))
  );
}
export function savedFilters(user: User): Filters {
  return {
    gender: user.filter_gender,
    minAge: user.filter_min_age,
    maxAge: user.filter_max_age,
    location: user.filter_location,
  };
}

export class MatchmakerDO extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private queue = new Map<number, Entry>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const entries = (await ctx.storage.get<Entry[]>("queue")) ?? [];
      this.queue = new Map(entries.map((e) => [e.id, e]));
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  private async persist(): Promise<void> {
    await this.ctx.storage.put("queue", [...this.queue.values()]);
    const next = Math.min(
      ...[...this.queue.values()].map((e) => e.joined + (filtered(e.filters) ? 10_000 : 600_000)),
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
    else await this.ctx.storage.deleteAlarm();
  }
  private async user(id: number): Promise<User> {
    const user = await getUser(this.env, id);
    if (!user || user.is_banned || user.state === "INACTIVE")
      throw new UserError("This account is unavailable. Send /start to return.");
    return user;
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        await this.recoverPair();
        const input = (await request.json()) as {
          userId: number;
          filters?: Filters;
          key: string;
          target?: number;
          kind?: ChatRequest["kind"];
          icebreaker?: string;
          requestId?: string;
        };
        const user = await this.user(input.userId);
        switch (new URL(request.url).pathname) {
          case "/join":
            await this.join(user, input.filters ?? FREE_FILTERS, input.key);
            break;
          case "/leave":
            await this.leave(user.telegram_id);
            break;
          case "/request":
            await this.request(
              user,
              input.target!,
              input.kind ?? "STANDARD",
              input.key,
              input.icebreaker,
            );
            break;
          case "/accept":
            await this.acceptRequest(user, input.requestId!);
            break;
          case "/decline":
            await this.env.DB.prepare(
              "UPDATE chat_requests SET status = 'DECLINED' WHERE id = ? AND recipient_id = ? AND status = 'PENDING'",
            )
              .bind(input.requestId, user.telegram_id)
              .run();
            break;
          default:
            throw new UserError("Unknown matchmaking action.");
        }
        return Response.json({ ok: true });
      } catch (error) {
        if (error instanceof UserError)
          return Response.json({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
    });
  }
  private async leave(id: number): Promise<void> {
    const entry = this.queue.get(id);
    if (entry) {
      await refund(this.env, id, entry.key);
      this.queue.delete(id);
    }
    await this.env.DB.prepare(
      "UPDATE users SET state = 'IDLE' WHERE telegram_id = ? AND state = 'QUEUED'",
    )
      .bind(id)
      .run();
    await this.persist();
  }
  private async join(user: User, filters: Filters, key: string): Promise<void> {
    if (user.active_session_id) throw new UserError("You are in a chat. Use /next or /stop first.");
    if (this.queue.has(user.telegram_id))
      throw new UserError("You are already searching. /stop cancels the search.");
    if (
      !["ANY", "M", "F", "O"].includes(filters.gender) ||
      !["ANY", "CITY", "NEARBY"].includes(filters.location) ||
      !Number.isInteger(filters.minAge) ||
      !Number.isInteger(filters.maxAge) ||
      filters.minAge < 18 ||
      filters.maxAge > 99 ||
      filters.minAge > filters.maxAge
    )
      throw new UserError("Invalid search filters.");
    const entry: Entry = {
      id: user.telegram_id,
      filters,
      key: `escrow:${user.telegram_id}:${key}`,
      joined: Date.now(),
      cost: 0,
    };
    // Journal first so an interrupted reservation can always be refunded on recovery.
    this.queue.set(user.telegram_id, entry);
    await this.persist();
    try {
      if (filtered(filters))
        entry.cost = await charge(this.env, user, 5, entry.key, "FILTER_ESCROW");
      await this.env.DB.prepare(
        "UPDATE users SET state = 'QUEUED' WHERE telegram_id = ? AND active_session_id IS NULL",
      )
        .bind(user.telegram_id)
        .run();
      await this.persist();
    } catch (error) {
      await this.leave(user.telegram_id);
      throw error;
    }
    for (const other of [...this.queue.values()]) {
      if (other.id === user.telegram_id) continue;
      const candidate = await getUser(this.env, other.id);
      if (
        !candidate ||
        candidate.state !== "QUEUED" ||
        candidate.is_banned ||
        Date.now() - candidate.last_active_at > 600_000
      ) {
        await this.leave(other.id);
        continue;
      }
      if (
        user.last_partner_id === candidate.telegram_id ||
        candidate.last_partner_id === user.telegram_id
      )
        continue;
      if (
        !accepts(filters, user, candidate) ||
        !accepts(other.filters, candidate, user) ||
        (await blocked(this.env, user.telegram_id, candidate.telegram_id))
      )
        continue;
      await this.startPair({
        id: crypto.randomUUID(),
        a: user.telegram_id,
        b: candidate.telegram_id,
        escrows: [entry, other]
          .filter((e) => filtered(e.filters))
          .map((e) => ({ userId: e.id, key: e.key, cost: e.cost, settled: false })),
      });
      return;
    }
    try {
      await tell(
        this.env,
        user.telegram_id,
        filtered(filters)
          ? "Searching with your filters. 5 credits are held in escrow (free with VIP). If no match is found within 10 seconds, they are returned. /stop to cancel."
          : "Searching for a random partner… /stop to cancel.",
        { reply_markup: { keyboard: [[{ text: "/stop" }]], resize_keyboard: true } },
      );
    } catch (error) {
      if (error instanceof TelegramError && error.code === 403) await this.leave(user.telegram_id);
      else throw error;
    }
  }
  private async startPair(pair: Pair): Promise<void> {
    await this.ctx.storage.put("pair", pair);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    await this.recoverPair();
  }
  private async recoverPair(): Promise<void> {
    const pair = await this.ctx.storage.get<Pair>("pair");
    if (!pair) return;
    // Initialization commits the D1 reservation once, and resumes notifications after a restart.
    await sessionAction(this.env, pair.id, "init", pair);
    this.queue.delete(pair.a);
    this.queue.delete(pair.b);
    await this.persist();
    await this.ctx.storage.delete("pair");
  }
  private async request(
    sender: User,
    target: number,
    kind: ChatRequest["kind"],
    key: string,
    icebreaker?: string,
  ): Promise<void> {
    if (sender.active_session_id)
      throw new UserError("Finish your current chat before sending a request.");
    const recipient = await this.user(target);
    if (sender.telegram_id === target || (await blocked(this.env, sender.telegram_id, target)))
      throw new UserError("This profile is unavailable.");
    if (kind === "RECONNECT" && sender.last_partner_id !== target)
      throw new UserError("Only your most recent partner can be invited to reconnect.");
    if (Date.now() - recipient.last_active_at > 3 * DAY)
      throw new UserError("This person is no longer active. Try another profile.");
    if (kind === "SUPER" && (!icebreaker || icebreaker.length > 200 || hasContact(icebreaker)))
      throw new UserError(
        "Write an icebreaker of 1–200 characters, without links or contact details.",
      );
    const recent = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chat_requests WHERE sender_id = ? AND created_at > ?",
    )
      .bind(sender.telegram_id, Date.now() - 3_600_000)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= 20)
      throw new UserError("You have sent enough requests for now. Try again in an hour.");
    const requestId = `${sender.public_id.slice(0, 8)}-${key}`;
    const existing = await this.env.DB.prepare("SELECT * FROM chat_requests WHERE id = ?")
      .bind(requestId)
      .first<ChatRequest>();
    if (existing && (existing.status !== "PENDING" || existing.delivered_at !== null)) return;
    const now = Date.now();
    const resetAt = (Math.floor(now / DAY) + 1) * DAY;
    if (!existing) {
      try {
        await this.env.DB.batch([
          this.env.DB.prepare(
            "UPDATE chat_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?",
          ).bind(now),
          this.env.DB.prepare(
            "UPDATE users SET daily_free_waves = 3, waves_reset_at = ? WHERE telegram_id = ? AND waves_reset_at <= ?",
          ).bind(resetAt, sender.telegram_id, now),
          this.env.DB.prepare(
            `INSERT INTO chat_requests (id,sender_id,recipient_id,icebreaker_text,is_super_wave,kind,cost,uses_free,created_at,expires_at)
          SELECT ?,telegram_id,?,?,?,?,
            CASE WHEN vip_until > ? THEN 0 WHEN ? = 'SUPER' THEN 10 WHEN ? = 'RECONNECT' THEN 15 WHEN daily_free_waves > 0 THEN 0 ELSE 2 END,
            CASE WHEN ? = 'STANDARD' AND daily_free_waves > 0 AND vip_until <= ? THEN 1 ELSE 0 END,?,?
          FROM users WHERE telegram_id = ?`,
          ).bind(
            requestId,
            target,
            icebreaker ?? null,
            kind === "SUPER" ? 1 : 0,
            kind,
            now,
            kind,
            kind,
            kind,
            now,
            now,
            now + DAY,
            sender.telegram_id,
          ),
        ]);
      } catch (error) {
        if (String(error).includes("INSUFFICIENT_CREDITS"))
          throw new UserError("Not enough credits. Open /shop to top up.");
        if (String(error).includes("UNIQUE"))
          throw new UserError("You already have a pending request to this person.");
        throw error;
      }
    }
    try {
      if (!existing || existing.delivery_phase === 0) {
        await profile(this.env, recipient, sender, { disable_notification: true });
        await this.env.DB.prepare("UPDATE chat_requests SET delivery_phase=1 WHERE id=?")
          .bind(requestId)
          .run();
      }
      await tell(
        this.env,
        target,
        `${kind === "SUPER" ? "🌟 Super Wave" : kind === "RECONNECT" ? "↩️ Reconnect invitation" : "💬 Chat request"} from ${sender.display_name}${icebreaker ? `\n\n${icebreaker}` : ""}\nExpires in 24 hours. Accepting ends any roulette search.`,
        {
          disable_notification: kind === "STANDARD",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Accept chat", callback_data: `accept:${requestId}` },
                { text: "Decline", callback_data: `decline:${requestId}` },
              ],
            ],
          },
        },
      );
      await this.env.DB.prepare(
        "UPDATE chat_requests SET delivery_phase=2,delivered_at=? WHERE id=?",
      )
        .bind(Date.now(), requestId)
        .run();
    } catch (error) {
      await this.env.DB.batch([
        refundStatement(this.env, sender.telegram_id, `request:${requestId}`),
        this.env.DB.prepare("UPDATE chat_requests SET status = 'FAILED' WHERE id = ?").bind(
          requestId,
        ),
        this.env.DB.prepare(
          "UPDATE users SET daily_free_waves = daily_free_waves + (SELECT uses_free FROM chat_requests WHERE id = ?) WHERE telegram_id = ? AND waves_reset_at = ?",
        ).bind(
          requestId,
          sender.telegram_id,
          existing ? (Math.floor(existing.created_at / DAY) + 1) * DAY : resetAt,
        ),
      ]);
      if (error instanceof TelegramError)
        throw new UserError(
          "This request could not be delivered. Your credits or free request were returned.",
        );
      throw error;
    }
    await tell(this.env, sender.telegram_id, "Request sent. We’ll notify you if they accept.");
  }
  private async acceptRequest(recipient: User, id: string): Promise<void> {
    const request = await this.env.DB.prepare(
      "SELECT * FROM chat_requests WHERE id = ? AND recipient_id = ?",
    )
      .bind(id, recipient.telegram_id)
      .first<ChatRequest>();
    if (!request || request.status !== "PENDING" || request.expires_at <= Date.now())
      throw new UserError("This request is no longer available.");
    const sender = await this.user(request.sender_id);
    if (sender.active_session_id || recipient.active_session_id)
      throw new UserError("One of you is in a chat. Try again when you are both available.");
    if (await blocked(this.env, sender.telegram_id, recipient.telegram_id))
      throw new UserError("This request is unavailable.");
    await this.leave(sender.telegram_id);
    await this.leave(recipient.telegram_id);
    await this.startPair({
      id: crypto.randomUUID(),
      a: sender.telegram_id,
      b: recipient.telegram_id,
      escrows: [],
      requestId: id,
    });
  }
  async alarm(): Promise<void> {
    return this.serial(async () => {
      await this.recoverPair();
      const now = Date.now();
      for (const entry of [...this.queue.values()]) {
        const user = await getUser(this.env, entry.id);
        if (!user || user.state !== "QUEUED" || user.is_banned) {
          await this.leave(entry.id);
          continue;
        }
        if (entry.joined + (filtered(entry.filters) ? 10_000 : 600_000) > now) continue;
        await this.leave(entry.id);
        try {
          await tell(
            this.env,
            entry.id,
            filtered(entry.filters)
              ? "No compatible partner yet. Your held credits have been returned. Expand the location scope or try a free random match."
              : "The queue is quiet. Your search has stopped; try /random again shortly.",
            {
              reply_markup: filtered(entry.filters)
                ? {
                    inline_keyboard: [
                      [{ text: "Expand location", callback_data: "fallback:expand" }],
                      [{ text: "Free random match", callback_data: "fallback:random" }],
                    ],
                  }
                : menu,
            },
          );
        } catch (error) {
          if (!(error instanceof TelegramError && error.code === 403)) throw error;
        }
      }
      await this.persist();
    });
  }
}

export async function matchAction(env: Env, action: string, input: object): Promise<void> {
  const response = await env.MATCHMAKER.getByName("global").fetch(`https://internal/${action}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) throw new UserError(result.error ?? "Matchmaking is unavailable.");
}

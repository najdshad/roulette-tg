import { DurableObject } from "cloudflare:workers";
import type { Message } from "grammy/types";
import { charge, getUser, refund } from "./db";
import { hasUrl } from "./privacy";
import { call, profile, TelegramError, tell } from "./telegram";
import { chatMenu, DAY, menu, UserError, type Env } from "./types";

export interface Escrow {
  userId: number;
  key: string;
  cost: number;
  settled: boolean;
}
interface ViewPhoto {
  id: string;
  owner: number;
  recipient: number;
  file?: string;
  notice?: number;
  expires: number;
  revealed: boolean;
  key: string;
  source: number;
}
interface State {
  id: string;
  a: number;
  b: number;
  started: number;
  lastActivity: number;
  closed: boolean;
  escrows: Escrow[];
  unlocked: number[];
  viewMode: number[];
  consents: Record<string, string>;
  views: ViewPhoto[];
  initialized: boolean;
  profileSent: number[];
  greeted: number[];
  released: boolean;
  feedback: number[];
}
type Ephemeral = {
  id: number;
  target_chat_id: number;
  target_msg_id: number;
  source_chat_id: number | null;
  source_msg_id: number | null;
  delete_at: number;
};
export interface RelayInput {
  userId: number;
  messageId: number;
  replyTo?: number;
  text?: string;
  file?: string;
  caption?: string;
  hasUrlEntity?: boolean;
  key: string;
}

export class ChatSessionDO extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL,
      started_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ephemeral_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_chat_id INTEGER NOT NULL,
      source_chat_id INTEGER, source_msg_id INTEGER, target_msg_id INTEGER NOT NULL,
      delete_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(target_chat_id, target_msg_id));
      CREATE INDEX IF NOT EXISTS idx_ephemeral_delete_at ON ephemeral_messages(is_deleted, delete_at);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY);`);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  private load(): State | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM session_state LIMIT 1")
      .toArray()[0];
    return row ? (JSON.parse(row.data) as State) : null;
  }
  private save(s: State): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO session_state VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data",
      s.id,
      s.a,
      s.b,
      s.started,
      JSON.stringify(s),
    );
  }
  private remember(
    chat: number,
    message: number,
    sourceChat?: number,
    sourceMessage?: number,
    expires = Date.now() + DAY,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ephemeral_messages (target_chat_id, source_chat_id, source_msg_id, target_msg_id, delete_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(target_chat_id, target_msg_id) DO UPDATE SET
      delete_at = MIN(delete_at, excluded.delete_at), source_chat_id = COALESCE(excluded.source_chat_id, source_chat_id),
      source_msg_id = COALESCE(excluded.source_msg_id, source_msg_id)`,
      chat,
      sourceChat ?? null,
      sourceMessage ?? null,
      message,
      expires,
    );
  }
  private async notice(s: State, id: number, text: string, extra: object = {}): Promise<Message> {
    const message = await tell(this.env, id, text, extra);
    this.remember(id, message.message_id);
    await this.schedule(s);
    return message;
  }
  private async schedule(s: State): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(delete_at) AS at FROM ephemeral_messages WHERE is_deleted = 0",
      )
      .toArray()[0];
    const deadlines = [row?.at ?? Infinity, ...s.views.map((v) => v.expires)];
    if (!s.closed) {
      deadlines.push(s.lastActivity + DAY);
      if (s.escrows.some((e) => !e.settled)) deadlines.push(s.started + 15_000);
    }
    if (s.closed && (!s.released || s.feedback.length < 2)) deadlines.push(Date.now() + 30_000);
    const next = Math.min(...deadlines);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
    else if (s.closed) {
      this.ctx.storage.sql.exec(
        "DELETE FROM session_state; DELETE FROM operations; DELETE FROM ephemeral_messages;",
      );
      await this.ctx.storage.deleteAlarm();
    }
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      try {
        const path = new URL(request.url).pathname;
        const input = (await request.json()) as Record<string, unknown>;
        if (path === "/init") {
          let s = this.load();
          if (s?.closed) return Response.json({ ok: true });
          s ??= {
            id: String(input.id),
            a: Number(input.a),
            b: Number(input.b),
            started: Date.now(),
            lastActivity: Date.now(),
            closed: false,
            escrows: input.escrows as Escrow[],
            unlocked: [],
            viewMode: [],
            consents: {},
            views: [],
            initialized: false,
            profileSent: [],
            greeted: [],
            released: false,
            feedback: [],
          };
          this.save(s);
          await this.schedule(s);
          if (!s.initialized) {
            await this.env.DB.batch([
              this.env.DB.prepare(
                "UPDATE users SET state = 'IN_CHAT', active_session_id = ? WHERE telegram_id IN (?, ?)",
              ).bind(s.id, s.a, s.b),
              ...(input.requestId
                ? [
                    this.env.DB.prepare(
                      "UPDATE chat_requests SET status = 'ACCEPTED' WHERE id = ?",
                    ).bind(String(input.requestId)),
                  ]
                : []),
            ]);
            s.initialized = true;
            this.save(s);
          }
          for (const [viewerId, subjectId] of [
            [s.a, s.b],
            [s.b, s.a],
          ] as const) {
            const viewer = await getUser(this.env, viewerId),
              subject = await getUser(this.env, subjectId);
            if (!viewer || !subject) throw new Error("Missing session user");
            if (!s.profileSent.includes(viewerId)) {
              const messages = await profile(this.env, viewer, subject);
              for (const message of messages) this.remember(viewerId, message.message_id);
              s.profileSent.push(viewerId);
              this.save(s);
            }
            if (!s.greeted.includes(viewerId)) {
              await this.notice(
                s,
                viewerId,
                "You’re connected. Say hello!\nText is free. Photos: 2 credits each or /photos for a 4-credit session pass. /viewonce: 5 credits.\nMessages disappear after 24 hours. /next · /stop · /reveal",
                { reply_markup: chatMenu },
              );
              s.greeted.push(viewerId);
              this.save(s);
            }
          }
          await this.schedule(s);
          return Response.json({ ok: true });
        }
        const s = this.load();
        const id = Number(input.userId);
        if (!s || (id !== s.a && id !== s.b))
          throw new UserError("This chat is no longer available.");
        if (path === "/close") {
          await this.close(
            s,
            input.unavailable ? "Your partner is unavailable." : "Chat ended.",
            input.unavailable === true,
          );
          return Response.json({ ok: true });
        }
        if (s.closed) throw new UserError("This chat has ended. Choose /random for a new partner.");
        const key = String(input.key ?? "");
        if (
          key &&
          this.ctx.storage.sql.exec("SELECT 1 FROM operations WHERE id = ?", key).toArray().length
        )
          return Response.json({ ok: true });
        if (path === "/relay") await this.relay(s, input as unknown as RelayInput);
        else if (path === "/reveal-photo") await this.revealPhoto(s, id, String(input.viewId));
        else if (path === "/view-mode") {
          if (!s.viewMode.includes(id)) s.viewMode.push(id);
          this.save(s);
          await this.notice(
            s,
            id,
            "Your next compressed photo will be View-Once (5 credits). Your partner taps to reveal it, then it is deleted after 10 seconds. Protection cannot prevent every screenshot or a photo taken with another device. Use /cancel to switch back.",
          );
        } else if (path === "/cancel-view") {
          s.viewMode = s.viewMode.filter((v) => v !== id);
          this.save(s);
        } else if (path === "/unlock") {
          const user = await getUser(this.env, id);
          if (!user || user.photo_suspended_until > Date.now())
            throw new UserError("Photo privileges are temporarily suspended.");
          if (!s.unlocked.includes(id)) {
            await charge(this.env, user, 4, `photos:${s.id}:${id}`, "SESSION_PHOTOS");
            s.unlocked.push(id);
            this.save(s);
          }
          await this.notice(
            s,
            id,
            "Your standard photos are unlocked for this session. View-Once photos still cost 5 credits.",
          );
        } else if (path === "/consent") await this.consent(s, id, String(input.username ?? ""));
        else throw new UserError("Unknown chat action.");
        if (key) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO operations VALUES (?)", key);
        await this.schedule(s);
        return Response.json({ ok: true });
      } catch (error) {
        if (error instanceof TelegramError && error.code === 403) {
          const s = this.load();
          if (s) await this.close(s, "Your partner is unavailable.", true);
          return Response.json(
            { ok: false, error: "Your partner is unavailable. This chat has ended." },
            { status: 400 },
          );
        }
        if (error instanceof UserError)
          return Response.json({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
    });
  }
  private replyTarget(id: number, partner: number, reply: number | undefined): number | undefined {
    if (!reply) return undefined;
    const sent = this.ctx.storage.sql
      .exec<{ target_msg_id: number }>(
        `SELECT target_msg_id FROM ephemeral_messages WHERE source_chat_id = ? AND source_msg_id = ? AND target_chat_id = ? AND is_deleted = 0 AND delete_at > ? LIMIT 1`,
        id,
        reply,
        partner,
        Date.now(),
      )
      .toArray()[0];
    if (sent) return sent.target_msg_id;
    return this.ctx.storage.sql
      .exec<{ source_msg_id: number }>(
        `SELECT source_msg_id FROM ephemeral_messages WHERE target_chat_id = ? AND target_msg_id = ? AND source_chat_id = ? AND is_deleted = 0 AND delete_at > ? LIMIT 1`,
        id,
        reply,
        partner,
        Date.now(),
      )
      .toArray()[0]?.source_msg_id;
  }
  private async relay(s: State, input: RelayInput): Promise<void> {
    const { userId: id, messageId, key } = input;
    const partner = id === s.a ? s.b : s.a;
    const previous = this.ctx.storage.sql
      .exec<{ delete_at: number }>(
        "SELECT delete_at FROM ephemeral_messages WHERE source_chat_id=? AND source_msg_id=? AND target_chat_id=? LIMIT 1",
        id,
        messageId,
        partner,
      )
      .toArray()[0];
    if (previous) {
      for (const escrow of s.escrows) if (escrow.userId !== id) escrow.settled = true;
      s.lastActivity = Math.max(s.lastActivity, previous.delete_at - DAY);
      this.save(s);
      return;
    }
    const user = await getUser(this.env, id);
    if (!user || user.is_banned) throw new UserError("Your account is unavailable.");
    const other = await getUser(this.env, partner);
    if (!other || other.is_banned || other.state === "INACTIVE") {
      await this.close(s, "Your partner is unavailable.", true);
      throw new UserError("Your partner is unavailable.");
    }
    this.remember(id, messageId);
    await this.schedule(s);
    const content = input.text ?? input.caption ?? "";
    if (
      (!input.file && (!content.length || content.length > 4096)) ||
      (input.file && content.length > 1024)
    )
      throw new UserError(
        "Text must be 1–4,096 characters; photo captions can contain up to 1,024.",
      );
    if (Date.now() - s.started < 300_000 && (hasUrl(content) || input.hasUrlEntity))
      throw new UserError("External links are blocked during the first 5 minutes of a chat.");
    if (input.file && user.photo_suspended_until > Date.now())
      throw new UserError("Photo privileges are temporarily suspended pending review.");
    const viewOnce = !!input.file && s.viewMode.includes(id);
    const chargeKey = `relay:${s.id}:${key}`;
    if (input.file)
      await charge(
        this.env,
        user,
        viewOnce ? 5 : s.unlocked.includes(id) ? 0 : 2,
        chargeKey,
        viewOnce ? "VIEW_ONCE" : "PHOTO",
      );
    try {
      await call(this.env, "sendChatAction", {
        chat_id: partner,
        action: input.file ? "upload_photo" : "typing",
      });
      const reply = this.replyTarget(id, partner, input.replyTo);
      const reply_parameters = reply
        ? { message_id: reply, allow_sending_without_reply: true }
        : undefined;
      if (viewOnce) {
        const view: ViewPhoto = {
          id: crypto.randomUUID().slice(0, 8),
          owner: id,
          recipient: partner,
          file: input.file,
          expires: Date.now() + DAY,
          revealed: false,
          key: chargeKey,
          source: messageId,
        };
        s.views.push(view);
        this.save(s);
        await this.schedule(s);
        const notice = await this.notice(
          s,
          partner,
          `🔒 View-Once photo\nTap to receive a protected photo. It disappears 10 seconds after delivery; tap Telegram’s spoiler to view it.${input.caption ? `\n\n${input.caption}` : ""}`,
          {
            reply_parameters,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Reveal · 10 seconds", callback_data: `view:${s.id}:${view.id}` }],
              ],
            },
          },
        );
        view.notice = notice.message_id;
        this.remember(partner, notice.message_id, id, messageId);
        s.viewMode = s.viewMode.filter((v) => v !== id);
      } else {
        const delivered = input.file
          ? await call(this.env, "sendPhoto", {
              chat_id: partner,
              photo: input.file,
              caption: input.caption,
              protect_content: true,
              reply_parameters,
            })
          : await tell(this.env, partner, input.text!, { reply_parameters, protect_content: true });
        this.remember(partner, delivered.message_id, id, messageId);
      }
    } catch (error) {
      if (input.file) await refund(this.env, id, chargeKey);
      // A failed placeholder must not retain an orphaned Telegram file reference.
      s.views = s.views.filter((v) => v.key !== chargeKey || v.notice !== undefined);
      this.save(s);
      throw error;
    }
    // Only the other person's activity qualifies the paying user's escrow.
    for (const escrow of s.escrows) if (escrow.userId !== id) escrow.settled = true;
    s.lastActivity = Date.now();
    this.save(s);
  }
  private async revealPhoto(s: State, id: number, viewId: string): Promise<void> {
    const view = s.views.find((v) => v.id === viewId && v.recipient === id);
    if (!view || view.revealed || view.expires <= Date.now() || !view.file)
      throw new UserError("This photo has expired or was already revealed.");
    const owner = await getUser(this.env, view.owner);
    if (!owner || owner.is_banned || owner.photo_suspended_until > Date.now()) {
      delete view.file;
      view.expires = Date.now();
      this.save(s);
      await this.schedule(s);
      await refund(this.env, view.owner, view.key);
      throw new UserError("This photo is no longer available.");
    }
    const file = view.file;
    view.revealed = true;
    delete view.file;
    view.expires = Date.now() + 10_000;
    this.save(s);
    await this.schedule(s);
    try {
      const sent = await call(this.env, "sendPhoto", {
        chat_id: id,
        photo: file,
        has_spoiler: true,
        protect_content: true,
      });
      // Start the ten-second period on delivery, rather than on button press.
      view.expires = Date.now() + 10_000;
      this.remember(id, sent.message_id, view.owner, view.source, view.expires);
      this.save(s);
      await this.schedule(s);
    } catch (error) {
      await refund(this.env, view.owner, view.key);
      view.expires = Date.now();
      this.save(s);
      throw error;
    }
  }
  private async consent(s: State, id: number, username: string): Promise<void> {
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(username))
      throw new UserError(
        "Set a public Telegram username in Telegram settings before using /reveal.",
      );
    s.consents[String(id)] = username;
    this.save(s);
    const partner = id === s.a ? s.b : s.a;
    if (s.consents[String(partner)]) {
      await this.notice(s, s.a, `You both consented. Your partner is @${s.consents[String(s.b)]}.`);
      await this.notice(s, s.b, `You both consented. Your partner is @${s.consents[String(s.a)]}.`);
    } else {
      await this.notice(
        s,
        id,
        "Your consent is recorded. Your username is shared only when your partner also consents.",
      );
      await this.notice(
        s,
        partner,
        "Your partner would like to exchange usernames. Tap only if you agree to share your own.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Agree to share my @username", callback_data: `consent:${s.id}` }],
            ],
          },
        },
      );
    }
  }
  private async close(s: State, reason: string, unavailable = false): Promise<void> {
    if (!s.closed) {
      for (const escrow of s.escrows) {
        if (!escrow.settled && (unavailable || Date.now() - s.started < 15_000))
          await refund(this.env, escrow.userId, escrow.key);
        escrow.settled = true;
      }
      s.closed = true;
      s.consents = {};
      for (const view of s.views) {
        delete view.file;
        if (!view.revealed) view.expires = Date.now();
      }
      this.save(s);
    }
    await this.schedule(s);
    if (!s.released) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE users SET state = CASE WHEN state = 'INACTIVE' THEN state ELSE 'IDLE' END, active_session_id = NULL, last_partner_id = ? WHERE telegram_id = ? AND active_session_id = ?",
        ).bind(s.b, s.a, s.id),
        this.env.DB.prepare(
          "UPDATE users SET state = CASE WHEN state = 'INACTIVE' THEN state ELSE 'IDLE' END, active_session_id = NULL, last_partner_id = ? WHERE telegram_id = ? AND active_session_id = ?",
        ).bind(s.a, s.b, s.id),
      ]);
      s.released = true;
      this.save(s);
    }
    await this.schedule(s);
    for (const [id, partner] of [
      [s.a, s.b],
      [s.b, s.a],
    ]) {
      if (s.feedback.includes(id!)) continue;
      try {
        const recipient = await getUser(this.env, id!);
        if (!recipient || recipient.active_session_id || recipient.state === "INACTIVE") {
          s.feedback.push(id!);
          this.save(s);
          continue;
        }
        const subject = await getUser(this.env, partner!);
        await this.notice(
          s,
          id!,
          `${reason}\nUnqualified filtered-search fees are refunded automatically. Messages still expire on their original schedule.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Reconnect · 15 credits",
                    callback_data: `reconnect:${subject!.public_id}`,
                  },
                ],
                [
                  { text: "Block", callback_data: `block:${subject!.public_id}` },
                  { text: "Report", callback_data: `report:${subject!.public_id}` },
                ],
              ],
            },
          },
        );
        await this.notice(s, id!, "Choose your next step.", { reply_markup: menu });
      } catch (error) {
        if (!(error instanceof TelegramError && error.code === 403)) throw error;
      }
      s.feedback.push(id!);
      this.save(s);
    }
    await this.schedule(s);
  }
  async alarm(): Promise<void> {
    return this.serial(async () => {
      const s = this.load();
      if (!s) return;
      const now = Date.now();
      if (s.closed && (!s.released || s.feedback.length < 2)) await this.close(s, "Chat ended.");
      if (!s.closed && now >= s.lastActivity + DAY)
        await this.close(s, "Chat expired after 24 hours of inactivity.");
      if (!s.closed && now >= s.started + 15_000) {
        for (const escrow of s.escrows) escrow.settled = true;
        this.save(s);
      }
      let retry = false;
      const due = this.ctx.storage.sql
        .exec<Ephemeral>(
          "SELECT * FROM ephemeral_messages WHERE is_deleted = 0 AND delete_at <= ? ORDER BY delete_at LIMIT 500",
          now,
        )
        .toArray();
      const chats = new Map<number, Ephemeral[]>();
      for (const row of due)
        chats.set(row.target_chat_id, [...(chats.get(row.target_chat_id) ?? []), row]);
      for (const [id, rows] of chats)
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          try {
            await call(this.env, "deleteMessages", {
              chat_id: id,
              message_ids: batch.map((r) => r.target_msg_id),
            });
          } catch (error) {
            if (!(error instanceof TelegramError) || ![400, 403].includes(error.code)) {
              retry = true;
              continue;
            }
            if (error.code === 403 && !s.closed)
              await this.close(s, "Your partner is unavailable.", true);
            if (error.code === 400) {
              // A bad ID must not prevent deleting the rest of the batch.
              for (const row of batch) {
                try {
                  await call(this.env, "deleteMessage", {
                    chat_id: id,
                    message_id: row.target_msg_id,
                  });
                } catch (single) {
                  if (!(single instanceof TelegramError && [400, 403].includes(single.code))) {
                    retry = true;
                    continue;
                  }
                }
                this.ctx.storage.sql.exec("DELETE FROM ephemeral_messages WHERE id = ?", row.id);
              }
              continue;
            }
          }
          for (const row of batch)
            this.ctx.storage.sql.exec("DELETE FROM ephemeral_messages WHERE id = ?", row.id);
        }
      for (const view of s.views.filter((v) => v.expires <= now)) {
        if (view.notice) {
          try {
            await call(this.env, "editMessageText", {
              chat_id: view.recipient,
              message_id: view.notice,
              text: "🔒 Photo expired.",
              reply_markup: { inline_keyboard: [] },
            });
          } catch (error) {
            if (!(error instanceof TelegramError && [400, 403].includes(error.code))) {
              retry = true;
              continue;
            }
          }
        }
        s.views = s.views.filter((v) => v.id !== view.id);
      }
      this.save(s);
      if (retry) await this.ctx.storage.setAlarm(Date.now() + 30_000);
      else await this.schedule(s);
    });
  }
}

export async function sessionAction(
  env: Env,
  sessionId: string,
  action: string,
  input: object,
): Promise<void> {
  const response = await env.SESSIONS.getByName(sessionId).fetch(`https://internal/${action}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) throw new UserError(result.error ?? "Chat is unavailable.");
}

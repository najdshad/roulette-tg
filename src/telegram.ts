import { DurableObject } from "cloudflare:workers";
import { Api } from "grammy/web";
import type { Message } from "grammy/types";
import { distanceBucket, geohash, locate } from "./privacy";
import { DAY, UserError, type Env, type Location, type User } from "./types";

export interface TelegramResult<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}
export class TelegramError extends Error {
  constructor(
    public code: number,
    public description: string,
  ) {
    super(`Telegram API ${code}: ${description}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One small gateway enforces the bot-wide limit across Worker isolates. It stores no message content.
export class TelegramDO extends DurableObject<Env> {
  private sends = new Map<string, { tail: Promise<unknown>; pending: number }>();
  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/location") {
      const input = (await request.json()) as { latitude: number; longitude: number } | string;
      const normalized =
        typeof input === "string"
          ? input.trim().normalize("NFKC").toLowerCase()
          : geohash(input.latitude, input.longitude);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${this.env.GEOCODER_URL ?? ""}:${typeof input}:${normalized}`),
      );
      const key =
        "location-cache:" +
        [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const cached = await this.ctx.storage.get<{ location: Location; expires: number }>(key);
      if (cached && cached.expires > Date.now())
        return Response.json({ ok: true, result: cached.location });
      const wait = await this.ctx.blockConcurrencyWhile(async () => {
        const next = Math.max(
          Date.now(),
          (await this.ctx.storage.get<number>("geocode-next")) ?? 0,
        );
        await this.ctx.storage.put("geocode-next", next + 1100);
        return next - Date.now();
      });
      if (wait > 0) await sleep(wait);
      try {
        const location = await locate(this.env.GEOCODER_USER_AGENT, input, this.env.GEOCODER_URL);
        const expires = Date.now() + 7 * DAY;
        await this.ctx.storage.put(key, { location, expires });
        await this.ensureAlarm(expires);
        return Response.json({ ok: true, result: location });
      } catch (error) {
        if (error instanceof UserError) return Response.json({ ok: false, error: error.message });
        throw error;
      }
    }
    const { method, payload } = (await request.json()) as {
      method: string;
      payload: Record<string, unknown>;
    };
    const allowed = [
      "sendMessage",
      "sendPhoto",
      "sendMediaGroup",
      "sendChatAction",
      "deleteMessage",
      "deleteMessages",
      "editMessageText",
      "editMessageReplyMarkup",
      "answerCallbackQuery",
      "answerPreCheckoutQuery",
      "sendInvoice",
    ];
    if (!allowed.includes(method))
      return Response.json({ ok: false, error_code: 400, description: "Unsupported method" });
    const paced = method.startsWith("send") && method !== "sendChatAction";
    if (!paced) return this.execute(method, payload, false);
    const key = String(payload.chat_id);
    const queue = this.sends.get(key) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 20)
      return Response.json({
        ok: false,
        error_code: 429,
        description: "This chat is busy; try again shortly",
      });
    queue.pending++;
    const task = queue.tail.then(() => this.execute(method, payload, true));
    queue.tail = task.catch(() => {});
    this.sends.set(key, queue);
    try {
      return await task;
    } finally {
      if (--queue.pending === 0) this.sends.delete(key);
    }
  }
  private async reserve(payload: Record<string, unknown>, paced: boolean): Promise<number> {
    const chatKey = `chat:${String(payload.chat_id)}`;
    if (paced) {
      const chatSlot = (await this.ctx.storage.get<number>(chatKey)) ?? 0;
      if (chatSlot > Date.now()) await sleep(chatSlot - Date.now());
    }
    const wait = await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const globalSlot = (await this.ctx.storage.get<number>("next")) ?? 0;
      const slot = Math.max(now, globalSlot);
      // Do not let bursts create an unbounded sleeping request queue.
      if (slot - now > 20_000) return -1;
      await this.ctx.storage.put("next", slot + 36);
      if (paced) await this.ctx.storage.put(chatKey, slot + 1000);
      await this.ensureAlarm(now + 60_000);
      return slot - now;
    });
    return wait;
  }
  private async execute(
    method: string,
    payload: Record<string, unknown>,
    paced: boolean,
  ): Promise<Response> {
    const acknowledgement = method === "answerPreCheckoutQuery" || method === "answerCallbackQuery";
    const wait = acknowledgement ? 0 : await this.reserve(payload, paced);
    if (wait < 0)
      return Response.json({
        ok: false,
        error_code: 429,
        description: "Bot is busy; try again shortly",
        parameters: { retry_after: 2 },
      });
    if (wait) await sleep(wait);
    const api = new Api(this.env.BOT_TOKEN, { timeoutSeconds: acknowledgement ? 7 : 15 });
    // grammY API transformer retries rate-limit responses, respecting Telegram's retry_after.
    api.config.use(async (previous, name, body, signal) => {
      for (let attempt = 0; ; attempt++) {
        const result = await previous(name, body, signal);
        if (
          result.ok ||
          result.error_code !== 429 ||
          acknowledgement ||
          attempt >= 3 ||
          (result.parameters?.retry_after ?? 1) > 20
        )
          return result;
        await sleep((result.parameters?.retry_after ?? 1) * 1000);
        const retryWait = await this.reserve(payload, paced);
        if (retryWait < 0) return result;
        if (retryWait) await sleep(retryWait);
      }
    });
    try {
      const raw = api.raw as unknown as Record<
        string,
        (p: Record<string, unknown>) => Promise<unknown>
      >;
      const result = await raw[method]!(payload);
      return Response.json({ ok: true, result });
    } catch (error) {
      // Never log API errors: grammY errors can include the original text and token-bearing URL.
      const e = error as { error_code?: number; description?: string };
      if (e.error_code === 403 && typeof payload.chat_id === "number") {
        const user = await this.env.DB.prepare(
          "UPDATE users SET state = 'INACTIVE', last_active_at = 0 WHERE telegram_id = ? RETURNING active_session_id",
        )
          .bind(payload.chat_id)
          .first<{ active_session_id: string | null }>();
        if (user?.active_session_id) {
          // Do not await a session which may itself be waiting for this gateway response.
          this.ctx.waitUntil(
            this.env.SESSIONS.getByName(user.active_session_id)
              .fetch("https://internal/close", {
                method: "POST",
                body: JSON.stringify({ userId: payload.chat_id, unavailable: true }),
              })
              .then(() => {})
              .catch(() => {
                console.error(JSON.stringify({ event: "session_close_retry_needed" }));
              }),
          );
        }
      }
      return Response.json({
        ok: false,
        error_code: e.error_code ?? 503,
        description: e.description ?? "Telegram temporarily unavailable",
      });
    }
  }
  async alarm(): Promise<void> {
    const values = await this.ctx.storage.list<number>({ prefix: "chat:" });
    const expired = [...values].filter(([, at]) => at < Date.now()).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
    const locations = await this.ctx.storage.list<{ expires: number }>({
      prefix: "location-cache:",
    });
    const stale = [...locations]
      .filter(([, entry]) => entry.expires <= Date.now())
      .map(([key]) => key);
    if (stale.length) await this.ctx.storage.delete(stale);
    const next = Math.min(
      values.size > expired.length ? Date.now() + 60_000 : Infinity,
      ...[...locations.values()].filter((v) => v.expires > Date.now()).map((v) => v.expires),
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
}

export async function lookupLocation(
  env: Env,
  input: { latitude: number; longitude: number } | string,
): Promise<Location> {
  const response = await env.TELEGRAM.getByName("global").fetch("https://internal/location", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const data = (await response.json()) as { ok: boolean; result?: Location; error?: string };
  if (!data.ok) throw new UserError(data.error ?? "Location lookup unavailable.");
  return data.result!;
}

export async function call<T = Message>(env: Env, method: string, payload: object): Promise<T> {
  const response = await env.TELEGRAM.getByName("global").fetch("https://internal/call", {
    method: "POST",
    body: JSON.stringify({ method, payload }),
  });
  const data = (await response.json()) as TelegramResult<T>;
  if (!data.ok)
    throw new TelegramError(data.error_code ?? 503, data.description ?? "Telegram unavailable");
  return data.result!;
}
export async function tell(
  env: Env,
  id: number,
  text: string,
  extra: object = {},
): Promise<Message> {
  return call(env, "sendMessage", {
    chat_id: id,
    text,
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}
export async function profile(
  env: Env,
  viewer: User,
  subject: User,
  extra: object = {},
): Promise<Message[]> {
  const gender = { M: "Male", F: "Female", O: "Non-binary / Other" }[subject.gender];
  const caption = `${subject.display_name}, ${subject.age} · ${gender}\n${subject.location_label}\n${distanceBucket(viewer, subject)}`;
  const photos = JSON.parse(subject.photo_files) as string[];
  if (subject.photo_suspended_until > Date.now() || !photos.length)
    return [await tell(env, viewer.telegram_id, caption, extra)];
  let messages: Message[];
  try {
    messages =
      photos.length === 1
        ? [
            await call(env, "sendPhoto", {
              chat_id: viewer.telegram_id,
              photo: photos[0],
              caption,
              protect_content: true,
              ...extra,
            }),
          ]
        : await call<Message[]>(env, "sendMediaGroup", {
            chat_id: viewer.telegram_id,
            protect_content: true,
            disable_notification:
              "disable_notification" in extra ? extra.disable_notification : undefined,
            media: photos.map((photo, i) => ({
              type: "photo",
              media: photo,
              ...(i === 0 ? { caption } : {}),
            })),
          });
  } catch (error) {
    // A stale Telegram file reference must not break the profile entirely.
    if (!(error instanceof TelegramError) || error.code !== 400) throw error;
    return [await tell(env, viewer.telegram_id, caption, extra)];
  }
  if ("reply_markup" in extra)
    messages.push(await tell(env, viewer.telegram_id, "Choose an action below.", extra));
  return messages;
}

import type { Update } from "grammy/types";
import { createBot } from "./bot";
import { DAY, type Env } from "./types";
export { MatchmakerDO } from "./matchmaker";
export { ChatSessionDO } from "./session";
export { TelegramDO } from "./telegram";

async function secretMatches(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const first = new Uint8Array(a),
    second = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < first.length; i++) diff |= first[i]! ^ second[i]!;
  return diff === 0;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return Response.json({ ok: true, service: "roulette-tg" });
    if (path !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN)
      return new Response("Not configured", { status: 503 });
    if (
      !(await secretMatches(
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
        env.WEBHOOK_SECRET,
      ))
    )
      return new Response("Unauthorized", { status: 401 });
    if (Number(request.headers.get("Content-Length")) > 131072)
      return new Response("Too large", { status: 413 });
    let update: Update;
    try {
      const body = await request.text();
      if (body.length > 131072) return new Response("Too large", { status: 413 });
      update = JSON.parse(body) as Update;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
        throw new Error("Invalid update");
    } catch {
      return new Response("Invalid update", { status: 400 });
    }
    const now = Date.now();
    const claim = await env.DB.prepare(
      `INSERT INTO update_receipts VALUES (?, 'PROCESSING', ?, ?)
      ON CONFLICT(update_id) DO UPDATE SET lease_until=excluded.lease_until
      WHERE update_receipts.status='PROCESSING' AND update_receipts.lease_until <= ? RETURNING update_id`,
    )
      .bind(update.update_id, now + 120_000, now, now)
      .first();
    if (!claim) {
      const row = await env.DB.prepare("SELECT status FROM update_receipts WHERE update_id=?")
        .bind(update.update_id)
        .first<{ status: string }>();
      return new Response(row?.status === "DONE" ? "OK" : "Retry later", {
        status: row?.status === "DONE" ? 200 : 503,
      });
    }
    try {
      await createBot(env).handleUpdate(update);
      await env.DB.prepare("UPDATE update_receipts SET status='DONE' WHERE update_id=?")
        .bind(update.update_id)
        .run();
      return new Response("OK");
    } catch {
      // Never log an Update or grammY error; either may contain chat content or raw GPS data.
      console.error(JSON.stringify({ event: "update_failed", update_id: update.update_id }));
      await env.DB.prepare("DELETE FROM update_receipts WHERE update_id=? AND status='PROCESSING'")
        .bind(update.update_id)
        .run();
      return new Response("Retry later", { status: 503 });
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE chat_requests SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?",
      ).bind(now),
      env.DB.prepare("UPDATE chat_requests SET icebreaker_text=NULL WHERE expires_at<=?").bind(now),
      env.DB.prepare("DELETE FROM chat_requests WHERE status!='PENDING' AND expires_at<?").bind(
        now - 3 * DAY,
      ),
      env.DB.prepare("DELETE FROM drafts WHERE updated_at<?").bind(now - DAY),
      env.DB.prepare("DELETE FROM update_receipts WHERE created_at<?").bind(now - 7 * DAY),
    ]);
  },
} satisfies ExportedHandler<Env>;

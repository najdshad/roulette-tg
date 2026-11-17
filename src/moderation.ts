import { suspendIfReported } from "./db";
import { matchAction } from "./matchmaker";
import { sessionAction } from "./session";
import { tell } from "./telegram";
import { UserError, type Env, type User } from "./types";

export async function blockUser(
  env: Env,
  user: User,
  target: User,
  reason?: string,
): Promise<void> {
  if (user.telegram_id === target.telegram_id) throw new UserError("You cannot block yourself.");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO blocks (blocker_id,blocked_id,is_report,reason,created_at,reported_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(blocker_id,blocked_id) DO UPDATE SET is_report = MAX(blocks.is_report,excluded.is_report),
      reason = COALESCE(excluded.reason,blocks.reason), reported_at = COALESCE(excluded.reported_at,blocks.reported_at)`,
    ).bind(
      user.telegram_id,
      target.telegram_id,
      reason ? 1 : 0,
      reason ?? null,
      now,
      reason ? now : null,
    ),
    env.DB.prepare(
      "UPDATE chat_requests SET status = 'DECLINED' WHERE status = 'PENDING' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))",
    ).bind(user.telegram_id, target.telegram_id, target.telegram_id, user.telegram_id),
  ]);
  if (user.active_session_id && user.active_session_id === target.active_session_id)
    await sessionAction(env, user.active_session_id, "close", { userId: user.telegram_id });
  if (user.state === "QUEUED") await matchAction(env, "leave", { userId: user.telegram_id });
  if (reason && (await suspendIfReported(env, target.telegram_id))) {
    if (env.ADMIN_CHAT_ID)
      await tell(
        env,
        Number(env.ADMIN_CHAT_ID),
        `Photo privileges suspended for 24 hours.\nUser: ${target.telegram_id}\nProfile reference: ${target.public_id}\nAt least 3 unique reports in the last 24 hours. Review with the documented D1 queries.`,
      );
  }
  await tell(
    env,
    user.telegram_id,
    reason
      ? "Report recorded. This profile is also blocked."
      : "Profile blocked. You will not be paired or receive requests from this person.",
  );
}

import { DAY, UserError, type Draft, type Env, type User } from "./types";

export async function getUser(env: Env, id: number): Promise<User | null> {
  return env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(id).first<User>();
}

export async function getDraft(env: Env, id: number): Promise<Draft | null> {
  const row = await env.DB.prepare("SELECT data FROM drafts WHERE telegram_id = ?")
    .bind(id)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as Draft) : null;
}
export async function putDraft(env: Env, id: number, draft: Draft): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO drafts VALUES (?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  )
    .bind(id, JSON.stringify(draft), Date.now())
    .run();
}
export async function clearDraft(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM drafts WHERE telegram_id = ?").bind(id).run();
}

export async function changeCredits(
  env: Env,
  id: number,
  delta: number,
  key: string,
  reason: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO credit_ledger SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE id = ?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(key, id, delta, reason, Date.now(), key)
      .run();
  } catch (error) {
    if (String(error).includes("INSUFFICIENT_CREDITS"))
      throw new UserError("Not enough credits. Open /shop to top up.");
    throw error;
  }
}
export async function charge(
  env: Env,
  user: User,
  cost: number,
  key: string,
  reason: string,
): Promise<number> {
  if (
    await env.DB.prepare("SELECT 1 FROM credit_ledger WHERE id = ?").bind(`refund:${key}`).first()
  )
    throw new UserError("That action was cancelled and refunded. Please try again.");
  const actual = user.vip_until > Date.now() ? 0 : cost;
  await changeCredits(env, user.telegram_id, -actual, key, reason);
  // Return the original amount on retries, even if VIP status has since changed.
  const row = await env.DB.prepare("SELECT delta FROM credit_ledger WHERE id = ?")
    .bind(key)
    .first<{ delta: number }>();
  return -(row?.delta ?? 0);
}
export function refundStatement(env: Env, id: number, chargeKey: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO credit_ledger (id, telegram_id, delta, reason, created_at)
    SELECT 'refund:' || id, telegram_id, -delta, 'REFUND', ? FROM credit_ledger
    WHERE id = ? AND telegram_id = ? AND delta <= 0 ON CONFLICT(id) DO NOTHING`,
  ).bind(Date.now(), chargeKey, id);
}
export async function refund(env: Env, id: number, chargeKey: string): Promise<void> {
  await refundStatement(env, id, chargeKey).run();
}

export async function blocked(env: Env, a: number, b: number): Promise<boolean> {
  return !!(await env.DB.prepare(
    "SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
  )
    .bind(a, b, b, a)
    .first());
}
export async function suspendIfReported(env: Env, id: number): Promise<boolean> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM blocks WHERE blocked_id = ? AND is_report = 1 AND reported_at >= ?",
  )
    .bind(id, Date.now() - DAY)
    .first<{ n: number }>();
  if ((count?.n ?? 0) < 3) return false;
  const result = await env.DB.prepare(
    "UPDATE users SET photo_suspended_until = ?, reports_count = ? WHERE telegram_id = ? AND photo_suspended_until < ?",
  )
    .bind(Date.now() + DAY, count!.n, id, Date.now())
    .run();
  return result.meta.changes > 0;
}

import { DAY, UserError, type Env, type User } from "./types";
import { profile, tell } from "./telegram";

export async function nearby(env: Env, user: User, index = 0): Promise<void> {
  let people: User[] = [];
  for (const prefix of [5, 4, 3]) {
    const result = await env.DB.prepare(
      `SELECT u.* FROM users u WHERE u.telegram_id != ? AND u.is_banned = 0
      AND u.state != 'INACTIVE' AND u.last_active_at >= ? AND u.geohash LIKE ?
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.telegram_id) OR (b.blocker_id = u.telegram_id AND b.blocked_id = ?))
      ORDER BY u.last_active_at DESC, u.telegram_id LIMIT 50`,
    )
      .bind(
        user.telegram_id,
        Date.now() - 3 * DAY,
        `${user.geohash.slice(0, prefix)}%`,
        user.telegram_id,
        user.telegram_id,
      )
      .all<User>();
    people = result.results;
    if (people.length >= 10) break;
  }
  if (!people.length) {
    await tell(
      env,
      user.telegram_id,
      "No nearby profiles active in the past 72 hours yet. Try a free /random chat or come back later.",
    );
    return;
  }
  const offset = Math.max(0, Math.min(people.length - 1, index));
  const subject = people[offset]!;
  await profile(env, user, subject);
  await tell(
    env,
    user.telegram_id,
    `📍 People nearby · ${offset + 1}/${people.length}\n3 free chat requests per day (UTC), then 2 credits each. Super Wave: 10 credits.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "← Previous", callback_data: `nearby:${Math.max(0, offset - 1)}` },
            { text: "Next →", callback_data: `nearby:${Math.min(people.length - 1, offset + 1)}` },
          ],
          [{ text: "Send chat request", callback_data: `request:${subject.public_id}` }],
          [{ text: "🌟 Super Wave · 10 credits", callback_data: `wave:${subject.public_id}` }],
          [
            { text: "Block", callback_data: `block:${subject.public_id}` },
            { text: "Report", callback_data: `report:${subject.public_id}` },
          ],
        ],
      },
    },
  );
}
export async function publicUser(env: Env, publicId: string): Promise<User> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE public_id = ? AND is_banned = 0")
    .bind(publicId)
    .first<User>();
  if (!user) throw new UserError("This profile is no longer available.");
  return user;
}

import type { SuccessfulPayment } from "grammy/types";
import { getUser } from "./db";
import { call, tell } from "./telegram";
import { UserError, type Env } from "./types";

export const PACKAGES = {
  starter: { title: "Starter Pack", stars: 50, credits: 50, days: 0 },
  popular: { title: "Popular Pack", stars: 150, credits: 175, days: 0 },
  pro: { title: "Pro Pack", stars: 400, credits: 500, days: 0 },
  vip: { title: "7-Day VIP Pass", stars: 250, credits: 50, days: 7 },
} as const;
export type PackageId = keyof typeof PACKAGES;
export function packageFromPayload(payload: string, id: number) {
  const [version, owner, key] = payload.split(":");
  if (version !== "v1" || owner !== String(id) || !key || !Object.hasOwn(PACKAGES, key))
    return null;
  return { id: key as PackageId, ...PACKAGES[key as PackageId] };
}
export async function shop(env: Env, id: number): Promise<void> {
  await tell(
    env,
    id,
    "⭐ Credit shop\nStarter: 50 credits / 50 Stars\nPopular: 175 credits / 150 Stars\nPro: 500 credits / 400 Stars\nVIP: 7 days of unlimited paid features + 50 credits / 250 Stars\n\nVIP starts immediately and additional passes extend it. Purchases are one-time, with no auto-renewal. /terms · /paysupport",
    {
      reply_markup: {
        inline_keyboard: Object.entries(PACKAGES).map(([key, p]) => [
          { text: `${p.title} · ${p.stars} ⭐`, callback_data: `buy:${key}` },
        ]),
      },
    },
  );
}
export async function invoice(env: Env, id: number, key: string): Promise<void> {
  if (!Object.hasOwn(PACKAGES, key)) throw new UserError("Unknown package. Open /shop again.");
  const pack = PACKAGES[key as PackageId];
  await call(env, "sendInvoice", {
    chat_id: id,
    title: pack.title,
    description: `${pack.credits} credits${pack.days ? " + 7 days of unlimited paid features" : ""}. One-time purchase. Support: /paysupport.`,
    payload: `v1:${id}:${key}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: pack.title, amount: pack.stars }],
  });
}
export async function canPay(
  env: Env,
  id: number,
  payload: string,
  currency: string,
  total: number,
): Promise<boolean> {
  const pack = packageFromPayload(payload, id);
  const user = await getUser(env, id);
  return !!pack && !!user && !user.is_banned && currency === "XTR" && pack.stars === total;
}
export async function successfulPayment(
  env: Env,
  id: number,
  payment: SuccessfulPayment,
): Promise<void> {
  const pack = packageFromPayload(payment.invoice_payload, id);
  const amount =
    Number.isInteger(payment.total_amount) && payment.total_amount > 0 ? payment.total_amount : 0;
  // Record first: a webhook that throws is retried forever, and the Stars are already captured.
  await env.DB.prepare(
    `INSERT INTO star_transactions
    (charge_id, telegram_id, package_id, stars_paid, credits_granted, vip_days, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(charge_id) DO NOTHING`,
  )
    .bind(
      payment.telegram_payment_charge_id,
      id,
      pack?.id ?? payment.invoice_payload,
      amount,
      pack?.credits ?? 0,
      pack?.days ?? 0,
      Date.now(),
    )
    .run();
  if (!pack || payment.currency !== "XTR" || amount !== pack.stars) {
    // A valid payload still grants; only an unknown owner is refused. Alert a human either way.
    try {
      if (env.ADMIN_CHAT_ID)
        await tell(
          env,
          Number(env.ADMIN_CHAT_ID),
          `⚠️ Payment mismatch\nUser: ${id}\nPayload: ${payment.invoice_payload}\nCurrency: ${payment.currency}\nAmount: ${payment.total_amount}\nCharge: ${payment.telegram_payment_charge_id}`,
        );
    } catch {
      // The receipt is already stored; a failed alert must not trigger a Telegram retry.
    }
    return;
  }
  const user = await getUser(env, id);
  await tell(
    env,
    id,
    `Payment received. Balance: ${user?.credits ?? 0} credits.${pack.days ? "\nVIP is active. Check /balance for the expiry date." : ""}`,
  );
}

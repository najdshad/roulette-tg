const { BOT_TOKEN, WEBHOOK_SECRET, WEBHOOK_URL } = process.env;
if (!BOT_TOKEN || !/^\d+:[\w-]+$/.test(BOT_TOKEN)) throw new Error("Set BOT_TOKEN from BotFather.");
if (!WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{32,256}$/.test(WEBHOOK_SECRET))
  throw new Error("Set WEBHOOK_SECRET to 32–256 random letters, digits, underscores or hyphens.");
const url = new URL(WEBHOOK_URL ?? "");
if (url.protocol !== "https:" || url.pathname !== "/webhook")
  throw new Error("Set WEBHOOK_URL to your deployed HTTPS /webhook endpoint.");
async function api(method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`Telegram ${method} could not be reached. Check network access.`);
  }
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed (${result.error_code}).`);
  return result.result;
}
await api("setMyCommands", {
  commands: [
    { command: "start", description: "Create a profile or open the menu" },
    { command: "random", description: "Start a free random chat" },
    { command: "nearby", description: "Browse people active nearby" },
    { command: "filters", description: "Set gender, age and location preferences" },
    { command: "search", description: "Search with saved filters (5-credit escrow)" },
    { command: "profile", description: "Preview or edit your profile" },
    { command: "next", description: "End chat and find a free random partner" },
    { command: "stop", description: "End chat or cancel a search" },
    { command: "photos", description: "Unlock standard photos for this session" },
    { command: "viewonce", description: "Send your next photo with a 10-second timer" },
    { command: "reveal", description: "Exchange usernames with mutual consent" },
    { command: "balance", description: "See credits and VIP expiry" },
    { command: "shop", description: "Buy credits or VIP with Telegram Stars" },
    { command: "cancel", description: "Cancel pending input or View-Once mode" },
    { command: "help", description: "Commands and prices" },
    { command: "privacy", description: "Data retention and privacy limits" },
    { command: "terms", description: "Community and purchase terms" },
    { command: "paysupport", description: "Payment help and refund requests" },
  ],
});
// Sequential webhook delivery keeps onboarding albums and profile input ordered.
// Pairing and session correctness are independently protected by Durable Objects.
await api("setWebhook", {
  url: url.toString(),
  secret_token: WEBHOOK_SECRET,
  max_connections: 1,
  allowed_updates: ["message", "callback_query", "pre_checkout_query"],
  drop_pending_updates: false,
});
const info = await api("getWebhookInfo", {});
console.log(
  JSON.stringify(
    {
      url: info.url,
      pending_update_count: info.pending_update_count,
      max_connections: info.max_connections,
    },
    null,
    2,
  ),
);

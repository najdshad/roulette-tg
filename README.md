# Roulette Telegram bot

Native Telegram anonymous roulette and nearby discovery, implemented from [MVP.md](MVP.md). No web app, Mini App, object storage, or media downloads.

[Verification checklist and remaining production checks](docs/MVP-CHECKLIST.md).

The bot supports adult onboarding and editable photo profiles; free or mutually filtered roulette; credit escrow; anonymous text/photo relay with reply threading; protected View-Once photos; mutual username exchange; nearby profile browsing; asynchronous requests, Super Waves and reconnect invitations; blocks, photo quarantine, Stars packages and a 7-day VIP pass.

## Run locally

Use Node.js 22.12 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Edit .dev.vars with a development bot token and a random webhook secret.
# Set BOT_USERNAME, operator contact and GEOCODER_USER_AGENT in wrangler.jsonc.
npm run db:local
npm run dev
```

Telegram needs a public HTTPS endpoint to deliver webhooks. Point a development HTTPS tunnel at Wrangler's local port, then run:

```sh
WEBHOOK_URL=https://your-development-host/webhook npm run telegram:setup
```

Use a separate development bot. Running webhook setup changes that bot's delivery endpoint. It registers the native command menu, verifies the webhook secret format, preserves pending updates, and sets one webhook connection to preserve input order, including photo albums.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

Vitest runs inside Cloudflare's Workers runtime with D1 and SQLite-backed Durable Objects. Integration scenarios exercise webhook authentication and replay handling, onboarding/editing, atomic balances and Stars receipts, concurrent matching, filters and blocks, escrow outcomes, fallback and object eviction, relay/replies, photo pricing, View-Once authorization and alarms, both-history deletion, nearby expansion, request quotas and refunds, moderation, consent, and outbound rate limiting. Telegram and the geocoder are mocked; tests never send real notifications or spend Stars.

If a restricted environment cannot bind localhost ports, the same integration scenarios also run without a listening socket:

```sh
npm run test:runtime
```

This runner invokes `workerd test` with the application's actual Durable Objects, SQLite storage, and Cloudflare's D1 wrapper and Miniflare database implementation. Its inspection routes exist only in the test bundle. It uses temporary storage, which is removed afterward. This command depends on the pinned development packages' bundled test services.

## Deploy

1. Create a bot with BotFather and disable adding it to groups. Set `BOT_USERNAME` to the actual bot username without `@`.
2. Set a real operator contact in `SUPPORT_CONTACT`, a contact-bearing `GEOCODER_USER_AGENT`, and the optional private moderation channel ID. Add the bot to that channel with permission to post.
3. Authenticate Wrangler and create D1:

   ```sh
   npx wrangler login
   npx wrangler d1 create roulette-tg
   ```

   Copy the returned database ID into `wrangler.jsonc`.

4. Configure secrets and apply migrations:

   ```sh
   npx wrangler secret put BOT_TOKEN
   # Generate a random 32+ character value, e.g. openssl rand -hex 32.
   npx wrangler secret put WEBHOOK_SECRET
   npx wrangler secret put ADMIN_CHAT_ID
   npm run db:remote
   npm run deploy
   ```

   `ADMIN_CHAT_ID` is optional during development but required for the specified private moderation alerts. Store it as a secret or set it in local `.dev.vars`.

5. Set the same bot token and secret in local `.dev.vars` or the shell environment, then register the deployed endpoint:

   ```sh
   WEBHOOK_URL=https://roulette-tg.YOUR-SUBDOMAIN.workers.dev/webhook npm run telegram:setup
   ```

6. With two adult test accounts, complete profiles, match, test a reply and a protected photo, stop, and accept a nearby request. Test Stars using Telegram's test environment before taking live payments. Check `/paysupport` points to the operator. Confirm a delivered View-Once photo is deleted after 10 seconds and a normal message after 24 hours. Cloudflare's deployed alarms and real Telegram delivery require this live check; local mocks cannot prove them.

`GET /health` reports process liveness. It exposes no secrets or user data. The only public mutation endpoint is `POST /webhook`, protected by Telegram's secret header. Durable Object methods are accessible only through Worker bindings. Do not expose the internal test bundle.

## Storage and failure handling

- **D1:** profiles contain a five-character geohash and a city label, plus up to three Telegram `file_id` strings. No GPS pin or image bytes are saved. The ledger uses unique operation IDs and SQLite triggers so balance changes and receipts commit together. Successful-payment charge IDs are unique, and VIP purchases extend the existing expiry. Credit reservations reduce the available balance until settlement or refund.
- **MatchmakerDO:** a singleton atomically pairs compatible queue entries, with bidirectional block and last-partner checks. The in-memory queue is journaled in durable storage. A pending-pair journal resumes session creation after interruption. Paid searches time out after 10 seconds and refund their reservation; free searches expire after 10 minutes of inactivity.
- **ChatSessionDO:** one SQLite-backed object per pair serializes relay and session actions. It holds message ID mappings, escrow status, photo entitlements, username consents, and pending View-Once file references. Every relayed message and its original are scheduled for deletion 24 hours after delivery. Closing a session preserves deletion work. Revealed photos are protected, spoilered, and deleted 10 seconds after delivery; their stored file reference is removed immediately. An idle session closes after 24 hours, and completed state is purged once deletion work finishes. Transient deletion failures retain state and retry.
- **TelegramDO:** a small singleton gateway coordinates the bot-wide outbound limit across isolates and per-chat sends, and uses a grammY API transformer to retry 429 responses. It stores scheduling timestamps and coarse location cache entries, never message payloads or GPS pins. Geocoding is cached for seven days and limited to one lookup per 1.1 seconds across the bot. Checkout acknowledgements bypass message throttling.
- **Maintenance:** the hourly cron expires requests and clears expired icebreakers, removes old request records, deletes abandoned onboarding drafts after a day, and prunes webhook receipt IDs after seven days. Profiles, financial receipts and moderation records persist for the operator to manage.

Standard requests use three free daily allowances, resetting at midnight UTC, then cost two credits. Super Waves cost ten and include an icebreaker; reconnect invitations cost fifteen and require the most recent partner. Costs are consumed on delivery, including when a request is declined or expires; failed deliveries refund the credit charge or daily allowance. VIP waives feature charges for its active duration. Photo quarantine lasts 24 hours after the third unique recent report and alerts the private review channel.

Telegram does not offer exactly-once sends: an API timeout can occur after delivery but before the response reaches the bot. Update receipts and operation IDs prevent ordinary replay duplicates and duplicate charges, but cannot eliminate that external ambiguity. Secrets, update bodies, GPS pins, text and Telegram error payloads are never logged by this app; only a failed update ID is logged. Keep infrastructure request-body logging disabled as well.

## Telegram and privacy limits

Telegram bots cannot receive users' live typing activity; this bot emits `typing` / `upload_photo` while it relays supported content. `protect_content` blocks normal forwarding and saving, and View-Once uses a spoiler, but no bot can guarantee screenshot prevention across clients or prevent photography with another device. The ten-second timer begins on photo delivery, not on opening Telegram's spoiler, because Telegram supplies no spoiler-open event.

Deletion is scheduled for 24 hours, within Telegram's 48-hour deletion window. Telegram outages, a blocked bot, lost deletion permissions, or independent recipient copies can prevent complete erasure. This is disclosed in `/privacy` and `/terms`; do not advertise cryptographic secrecy or guaranteed erasure. The native GPS message is deleted during onboarding. Location lookup sends the pin to OpenStreetMap's Nominatim service on a cache miss; manual city entry avoids sharing a pin. No individual coordinates are persisted, and profile distances use coarse buckets rather than calculated exact values. Public Nominatim is suitable only for modest MVP traffic: follow its [usage policy](https://operations.osmfoundation.org/policies/nominatim/), including a maximum of one request per second for the whole application, an identifying User-Agent, caching, and attribution. Configure a compliant operator identity; `GEOCODER_URL` can switch to another Nominatim-compatible service without a code change.

## Moderation and support operations

Inspect recent reports in D1; no chat transcript is stored:

```sql
SELECT blocker_id, blocked_id, reason, reported_at
FROM blocks WHERE is_report = 1 ORDER BY reported_at DESC LIMIT 100;

-- Suspend an account after reviewing reports (replace the example ID).
UPDATE users SET is_banned = 1 WHERE telegram_id = 123456789;

-- Restore photo access after review.
UPDATE users SET photo_suspended_until = 0 WHERE telegram_id = 123456789;

SELECT charge_id, telegram_id, package_id, stars_paid, created_at
FROM star_transactions WHERE telegram_id = 123456789 ORDER BY created_at DESC;
```

Payment support is handled by the operator identified in `/paysupport`. Telegram refunds use `refundStarPayment` with the payer's Telegram ID and the original charge ID; verify receipts and reconcile the credit ledger before issuing refunds. Financial receipts are kept for reconciliation; do not erase them as part of chat cleanup. To remove a profile on request, suspend the account, end any active session through `/stop`, and remove identifying profile fields and photo references under the operator's retention policy.

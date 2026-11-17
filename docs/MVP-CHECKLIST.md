# MVP verification

Local verification on November 17, 2026:

- `npm run typecheck` passed, including application code, integration tests and test configuration.
- `npm run format:check` passed.
- `npm run build` passed: Wrangler produced the Worker bundle and resolved all D1 and Durable Object bindings.
- `npm test` passed all 27 tests: the 25 scenarios in `test/scenarios.ts` plus the privacy tests, against Cloudflare's D1 and SQLite Durable Objects.
- `npm run test:runtime` passed the same 25 scenarios using workerd and temporary storage. The View-Once scenario waited for the actual ten-second alarm to delete the photo.
- Manifest/lockfile consistency, script syntax, and Git whitespace checks passed.

Production status on November 17, 2026:

- The `roulette-tg` Worker is deployed at `https://roulette-tg.alirezanajdshad28.workers.dev`; `GET /health` returns `ok`.
- The D1 migration is applied remotely, and the `BOT_TOKEN`, `WEBHOOK_SECRET` and `ADMIN_CHAT_ID` Worker secrets are set.
- The webhook is registered with its secret token, ten connections and the message, callback and checkout update types.
- The GitHub Actions `check` and `deploy` jobs passed on `main`.
- One live account has completed onboarding. No live match, chat request, report or Stars payment has been made yet.

| MVP requirement                                                               | Implementation and local evidence                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Telegram interface; no web app                                         | Commands, reply keyboards and inline callbacks in `src/bot.ts`; webhook and onboarding scenarios                                                 |
| Adult onboarding, safe name, gender, location, 1–3 photos; editable preview   | `src/onboarding.ts`; profile validation and full onboarding/edit scenarios, including retention of a spent welcome balance                       |
| Compressed photos only; highest-resolution file reference; no object storage  | `highestPhoto`, onboarding and relay validation; photo and unsupported-media scenarios; no media download path or storage binding                |
| Coarse GPS/city location and distance labels                                  | Geohash validation, manual geocoding, native GPS deletion and draft inspection scenarios; geocoder cache contains only derived locations         |
| Atomic mutual roulette matching; blocks and last partner checks               | Concurrent pairing, incompatible filters, block and `/next` scenarios in `MatchmakerDO`                                                          |
| Paid-search 10-second fallback with preserved credits                         | Alarm deadline, forced deadline handling, refund, fallback buttons and queue reconstruction after eviction                                       |
| Escrow settles on a partner message or 15 seconds, refunds instant skips      | Separate payer-only, partner-reply, elapsed-time, cancellation and forbidden-recipient cases                                                     |
| Anonymous text/photo relay; early link blocking; replies; activity indicators | Relay, URL/entity rejection, quote mapping, standard photo pricing and unsupported-media scenarios                                               |
| `/stop`, `/next`, mutual `/reveal`; feedback/reconnect                        | Command/callback scenarios; two-party consent and most-recent-partner invitation checks                                                          |
| Both chat histories delete after 24 hours; backend state purges               | Inspection of source and delivered IDs/deadlines, close, deletion alarm, transient retry and complete state-purge scenarios                      |
| Protected View-Once reveal; one reveal; ten-second expiry                     | Recipient authorization, placeholder, spoiler/protection flags, file-reference removal, actual scheduled deletion and expired notice scenario    |
| Nearby deck, expanding prefixes, 72-hour activity, previous/next and privacy  | D1 deck queries and callback handlers; geohash expansion, inactive/block exclusion, coarse cards and opaque profile identifiers                  |
| Three daily free requests, paid extras, Super Waves and reconnect             | Quota/reset, per-action costs, notification/acceptance, failed delivery, free-quota restoration and interrupted-delivery recovery scenarios      |
| XTR invoices, checkout response, receipt-first ledger, packages and VIP       | Invoice payload/currency/provider token, fast checkout, duplicate payment, mismatch recording, atomic grants and cumulative VIP expiry scenarios |
| Per-chat/global outbound limits, 429 retry and 403 cleanup                    | Singleton gateway, per-chat pacing/retry case, unavailable-recipient session closure and escrow refund case                                      |
| Three unique recent reports quarantine photos and alert private admins        | Repeated-reporter exclusion, threshold, blocked requests, photo rejection and admin notification scenario                                        |
| Worker, D1, SQLite Durable Objects, migrations, alarms and cron               | Wrangler build; real local D1/DO runtime; scheduled cleanup scenario; deployment and webhook registration scripts                                |

Telegram does not expose incoming typing or spoiler-open events to bots, and protected content cannot guarantee screenshot prevention on every client. The implementation sends relay activity indicators and starts the photo timer on delivery. `/privacy`, `/terms` and the README disclose these limits and the possibility of failed deletion during Telegram outages or after bot blocking.

## Unverified production work

The implementation is deployed, but these live checks remain:

- Confirm `SUPPORT_CONTACT` (@nnajduu) and the contact-bearing `GEOCODER_USER_AGENT` in `wrangler.jsonc` are live after the next deploy.
- With two adult test accounts, complete onboarding, match, exchange text and photos, reply, use `/reveal`, `/next` and `/stop`, and accept a nearby request and a Super Wave.
- Make a Stars purchase in Telegram's test environment, then confirm credits, the VIP expiry and `/paysupport`.
- Observe a delivered View-Once photo deleted after 10 seconds and an ordinary message after 24 hours.
- Confirm the bot can post to the private `ADMIN_CHAT_ID`, including the three-report alert and the payment-mismatch alert.
- Confirm the hourly cron runs.

Local mocks cannot prove real Telegram delivery or Cloudflare's deployed alarms. Follow the README deployment instructions when these checks are possible.

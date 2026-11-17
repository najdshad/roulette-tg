# MVP verification

Local verification on November 17, 2026:

- `npm run typecheck` passed, including application code, integration tests and test configuration.
- `npm run format:check` passed.
- `npm run build` passed: Wrangler produced the Worker bundle and resolved all D1 and Durable Object bindings.
- `npm run test:runtime` passed all 25 scenarios in `test/scenarios.ts`, using workerd, SQLite Durable Objects and Cloudflare's D1 implementation. The View-Once scenario waited for the actual ten-second alarm to delete the photo.
- Manifest/lockfile consistency, script syntax, and Git whitespace checks passed.
- The standard `npm test` entrypoint could not start in this sandbox because localhost listeners are denied (`listen EPERM`). Its integration scenarios are shared with the passing socket-free runner. CI now runs both `npm test` and `npm run test:runtime`; that CI run has not been observed.

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

The full objective remains open until deployment and live validation are possible:

- Configure the actual bot token, webhook secret, bot username, Cloudflare account and D1 database ID, support contact, geocoder identity, and private review channel.
- Apply the D1 migration remotely and deploy the Worker and SQLite Durable Object migrations.
- Register the real HTTPS webhook and native command menu.
- Verify onboarding, matching, relay, requests, moderation delivery and Stars payments with real test accounts.
- Observe the deployed ten-second and 24-hour deletion alarms in Telegram.

No project bot secrets or local `.dev.vars` are configured in this checkout, and the D1 database ID is still a placeholder. A cached Wrangler OAuth login exists outside the repository; its access token expired on November 3, 2026, and refreshing it requires network access. Outbound connections, including the supplied proxy at `172.25.144.1:10808`, are denied by the current sandbox. No production deployment, webhook mutation, real notification, or live payment was performed. Follow the README deployment instructions once account access and networking are available.

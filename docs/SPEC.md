# Telegram Anonymous Roulette Chat Bot — MVP Specification & Architecture

Finalized product requirements and technical specification, incorporating all seven approved architectural decisions.

## 1. Executive Summary & Product Scope

This specification defines the Minimum Viable Product (MVP) requirements, user flows, monetization economy, and serverless architecture for an anonymous roulette and nearby-discovery chat platform built natively as a Telegram Bot on Cloudflare Workers.

* **Platform Interface:** 100% native Telegram Bot UI using Commands, Reply Keyboards, and Inline Keyboards, with no external web app or Telegram Mini App required for the MVP.


* **Profile Creation:** Simple, fast user onboarding capturing Name, Gender, 18+ Age, Coarse/City Location, and up to 3 compressed photos.


* **Matchmaking & Discovery:** Real-time Random Roulette pairing (unfiltered or filtered by Gender, Age, and Location) alongside an asynchronous "People Nearby" profile browsing deck with direct chat requests and notifying waves.


* **Ephemeral Chat & Media:** Anonymous 1-on-1 chat relay supporting text, compressed photos, protected self-destructing ("View-Once") photos, and automated 24-hour message and media deletion from both backend state and users' Telegram chat histories.


* **Monetization & Stack:** In-bot credit economy powered natively by Telegram Stars (XTR) running on a lean serverless edge stack using Cloudflare Workers, grammY, Cloudflare D1, and Cloudflare Durable Objects.



## 2. Finalized Architectural Decisions (Approved 1.1 – 1.7)

* **1.1 Zero-Storage Media Handling:** The platform uses no external object storage (no Cloudflare R2 or AWS S3). Only compressed Telegram photos are accepted, while uncompressed documents, videos, voice notes, and stickers are rejected. The bot extracts the highest-resolution Telegram photo reference string from the uploaded photo array and stores only that string in D1 for profiles or relays it directly via `sendPhoto` and `sendMediaGroup` during chats.


* **1.2 True 24-Hour Ephemerality:** Because deleting database rows leaves messages visible in users' Telegram apps, the active chat session records the recipient chat and delivered message references for every relayed text and photo. Using Cloudflare Durable Object Alarms, the bot calls Telegram's `deleteMessages` method 24 hours after delivery (within Telegram's 48-hour deletion window) and purges the session state.


* **1.3 Two-Step Protected Self-Destructing Photos:** When User A sends a View-Once photo, User B receives a locked placeholder card with an inline reveal button. When User B taps the button, the bot delivers the photo with `has_spoiler: true` and `protect_content: true` (blocking forwarding, saving, and mobile screenshots) and schedules a Durable Object Alarm for 10 seconds later to call `deleteMessage` and replace the notice with an expired status.


* **1.4 Coarse Distance Buckets & Geohash Privacy:** Users can share their GPS pin via Telegram's native location button or manually choose a city and country. Raw GPS coordinates are never stored or exposed; instead, coordinates are reverse-geocoded to a city/country label and encoded into a fuzzed 5-character Geohash (~5 km grid cell) in D1. Distances on profile cards and in the Nearby deck are always shown in coarse buckets (`< 2 km away`, `~5 km away`, `~15 km away`, or `Same City`).


* **1.5 Atomic Matchmaking & Session State with Durable Objects:** A strongly consistent `MatchmakerDO` manages the live matchmaking queue in memory to pair compatible users atomically without race conditions. Each matched pair is assigned a dedicated `ChatSessionDO` instance to manage message relay, reply quoting, credit escrow settlement, View-Once timers, and 24-hour deletion alarms.


* **1.6 Cold-Start Liquidity & Asynchronous Nearby Requests:** If a paid filtered search finds no compatible partner within 10 seconds, the bot prompts the user to expand their search radius or match randomly while keeping their credits. In the "People Nearby" deck, users browse profiles active within the last 72 hours and send asynchronous Chat Requests or Super Waves via push notifications.


* **1.7 Escrow Protection Against Instant-Skip Loss:** When a user initiates a filtered roulette match, the 5-credit fee is placed in escrow rather than deducted immediately. Credits are only finalized once the matched partner either sends at least 1 message or remains connected for at least 15 seconds; otherwise, the escrowed credits are refunded automatically.



## 3. Functional Requirements & User Flows

### 3.1 Onboarding & Profile Creation

1. **Age Verification:** User confirms 18+ eligibility and enters an integer age between 18 and 99.


2. **Display Name:** User enters a 2–24 character name (URLs, `@` handles, and phone numbers are stripped or blocked).


3. **Gender Selection:** User selects Male, Female, or Non-Binary / Other via inline buttons.


4. **Location Setup:** User chooses either native GPS sharing (converted to a city/country label and 5-character Geohash) or manual country/city selection (mapped to a city-center Geohash).


5. **Profile Photos:** User uploads 1 to 3 compressed photos stored as a JSON array in D1, and can run `/profile` anytime to preview or edit their profile card.



### 3.2 Random Roulette & People Nearby Discovery

* **Random Roulette Matchmaking:** Users queue for an unfiltered match (free) or apply paid filters for Gender, Age Range, and Location Scope. `MatchmakerDO` verifies mutual filter compatibility, checks the block list and last skipped partner, transitions both users to `IN_CHAT`, and sends each user their partner's profile card.


* **People Nearby Deck:** Queries D1 for non-banned users matching the user's Geohash prefix (starting at 5 characters and expanding to 4 or 3 characters if fewer than 10 profiles match), sorted by recent activity within 72 hours. Users navigate cards with Previous/Next buttons and can send a standard Chat Request (3 free per day) or a 10-credit Super Wave with an icebreaker message.



### 3.3 Active Anonymous Chat Session

* **Message & Media Relay:** Relays text messages (1–4,096 characters, blocking external URLs during the first 5 minutes), standard compressed photos, and View-Once photos. Forwards `typing` and `upload_photo` indicators via `sendChatAction` and preserves reply threading across both chat threads.


* **In-Chat Commands:** Supports `/next` (ends session, settles or refunds escrowed credits, and re-queues), `/stop` (ends session and returns to the main menu), and `/reveal` (shares Telegram `@username` handles only after both users tap to consent).


* **Post-Chat Feedback Bar:** Displays inline options to Reconnect (15 credits), Block, or Report when a session ends.



## 4. Monetization & Credit Economy (Telegram Stars XTR)

### 4.1 Free Tier vs. Credit Sinks

| Feature or Action | Credit Cost | Access Rule |
| --- | --- | --- |
| Welcome Balance | +10 Free | Granted once after onboarding |
| Unfiltered Roulette | Free | Unlimited matches and text |
| Receive Photos | Free | Standard and View-Once |
| Nearby Chat Request | 3 Free / Day | 2 Credits per extra request |
| Filtered Roulette | 5 Credits | Escrowed for 15s or 1st reply |
| Standard Photo | 2 or 4 Credits | 2 per photo or 4 per session |
| Self-Destruct Photo | 5 Credits | Protected + 10s reveal timer |
| Super Wave | 10 Credits | Notification + icebreaker |
| Reconnect Partner | 15 Credits | Invites last skipped partner |

All credit rules above are enforced atomically between D1 and the active session Durable Object.

### 4.2 Prepaid Credit Packages

| Package Name | Base Credits | Bonus Credits | Total Value | Price (XTR) |
| --- | --- | --- | --- | --- |
| Starter Pack | 50 | 0 | 50 Credits | 50 Stars |
| Popular Pack | 150 | +25 | 175 Credits | 150 Stars |
| Pro Pack | 400 | +100 | 500 Credits | 400 Stars |
| 7-Day VIP Pass | Unlimited | +50 | 7 Days + 50 | 250 Stars |

When a user selects a package in `/shop`, the bot calls `sendInvoice` with `currency: "XTR"` and `provider_token: ""`, answers `pre_checkout_query` within 10 seconds, and logs `successful_payment` in D1 before incrementing the user's balance.

## 5. Serverless Architecture & Database Schemas

### 5.1 Cloudflare D1 Schema

```sql
CREATE TABLE users (
    telegram_id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    gender TEXT CHECK(gender IN ('M', 'F', 'O')) NOT NULL,
    age INTEGER CHECK(age >= 18 AND age <= 99) NOT NULL,
    location_mode TEXT CHECK(location_mode IN ('EXACT_COARSE', 'CITY')) NOT NULL,
    location_label TEXT NOT NULL,
    geohash TEXT NOT NULL,
    photo_files TEXT NOT NULL,
    credits INTEGER DEFAULT 10 NOT NULL,
    vip_until INTEGER DEFAULT 0 NOT NULL,
    daily_free_waves INTEGER DEFAULT 3 NOT NULL,
    waves_reset_at INTEGER NOT NULL,
    state TEXT DEFAULT 'ONBOARDING' NOT NULL,
    active_session_id TEXT,
    last_partner_id INTEGER,
    filter_gender TEXT DEFAULT 'ANY' NOT NULL,
    filter_min_age INTEGER DEFAULT 18 NOT NULL,
    filter_max_age INTEGER DEFAULT 99 NOT NULL,
    filter_location TEXT DEFAULT 'ANY' NOT NULL,
    reports_count INTEGER DEFAULT 0 NOT NULL,
    is_banned INTEGER DEFAULT 0 NOT NULL,
    last_active_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_users_nearby ON users(geohash, is_banned, last_active_at DESC);

CREATE TABLE blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    is_report INTEGER DEFAULT 0 NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE chat_requests (
    id TEXT PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    icebreaker_text TEXT,
    is_super_wave INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'PENDING' NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE star_transactions (
    charge_id TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    stars_paid INTEGER NOT NULL,
    credits_granted INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

```

### 5.2 ChatSessionDO Internal SQLite Schema

```sql
CREATE TABLE session_state (
    session_id TEXT PRIMARY KEY,
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    escrow_user_id INTEGER,
    escrow_credits INTEGER DEFAULT 0,
    escrow_settled INTEGER DEFAULT 0,
    photos_unlocked_a INTEGER DEFAULT 0,
    photos_unlocked_b INTEGER DEFAULT 0,
    reveal_consent_a INTEGER DEFAULT 0,
    reveal_consent_b INTEGER DEFAULT 0
);

CREATE TABLE ephemeral_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_chat_id INTEGER NOT NULL,
    source_msg_id INTEGER,
    target_msg_id INTEGER NOT NULL,
    delete_at INTEGER NOT NULL,
    is_deleted INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX idx_ephemeral_delete_at ON ephemeral_messages(is_deleted, delete_at ASC);

```

## 6. Moderation, Rate Limits & Implementation Roadmap

* **Safety & Rate Controls:** Per-chat outbound messages are throttled to at most 1 message per second inside `ChatSessionDO`, global outbound limits (~30 messages/second) use grammY auto-retry on `429 Too Many Requests`, and `403 Forbidden` responses immediately close the session, refund unsettled escrow, and mark the user inactive. Accumulating 3 unique reports within 24 hours automatically suspends a user's photo privileges and alerts a private Admin Review channel.


* **Milestone 1 (Days 1–3):** Set up Cloudflare Worker, grammY, D1 schema migrations, webhook secret validation, and the 5-step onboarding state machine with Geohash encoding.


* **Milestone 2 (Days 4–8):** Implement `MatchmakerDO` (atomic pairing + 10s fallback) and `ChatSessionDO` (message relay, 15s credit escrow, `/next`, `/stop`, `/reveal`, and 24-hour deletion alarms).


* **Milestone 3 (Days 9–12):** Build the two-step protected View-Once photo reveal with 10-second alarms, the Geohash Nearby deck, and async Chat Request / Super Wave notifications.


* **Milestone 4 (Days 13–15):** Integrate Telegram Stars (`XTR`) billing, block/report quarantine logic, and production edge deployment.



# PHASE 5 AUDIT — 📢 Channel Engine (Atabak Gold)

Written **before** any Phase 5 code, against the repository state at the Phase 4 commit.
Scope: audit (STEP 1) + scope map (STEP 2) + architecture decision (STEP 3).

---

## 1. What the repository actually contains (verified by reading the code)

| Area | Reality in the repo |
| --- | --- |
| Framework | NestJS 11, TypeScript strict, `@nestjs/schedule` for cron, `@nestjs/axios` for HTTP |
| **Publishing flow (pre-Phase 5)** | `BotService.runPublication()` → `PriceService.fetchRawPayload()` → `MarketEngineService.evaluateCycle()` → `PriceMessageBuilder.build()` **or** `PosterService.generatePricePoster()` → `BaleService.sendMessage()` |
| Cron jobs | `price-update-half-hourly` (`0 0,30 8-21 * * *`), `price-update-daily-closing` (`0 0 22 * * *`), `poster-report` (`15 12,16,19 * * *`) — all `Asia/Tehran` |
| Overlap control | A single in-memory `publishing: string \| null` guard in `BotService` — **overlap control exists but is a label, not a job identity** |
| Delivery | `BaleService.sendMessage()` → `DeliveryResult[]` (per platform, `success: boolean`, sanitized error). It posts to **one channel id per platform**, has no message id and no failure classification |
| Platform transport | `BotApiClient` (transport-only, token-safe, per-call timeout) — `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates`. **No media method** |
| Platform UX abstraction | `PlatformRegistry` → `PlatformAdapter` (capabilities, poll, render, acknowledge); `UpdatePollerService` → `BotUxService.handleUpdate()` |
| Market truth | `MarketStateService` (single holder) + `MarketEngineService` (parse → normalize → sanity → state → publish/reject) + `MarketUpdateListener` hook for downstream consumers |
| Daily statistics | inside `MarketStateService.commit()`; `SymbolMarketState.daily = {open, high, low, current, change}` |
| Phase 4 | `MarketIntelligenceService.build(now)` → read-only snapshot (`open/current/high/low`, daily change, movement, freshness, availability) |
| Persistence | JSON documents with **atomic tmp+rename** writes, tolerant load, versioned payloads: `MarketStateStore` (Phase 1), `UserStore` (Phase 2), `AlertStore` (Phase 3, incl. a synchronous critical-section transaction API). No database, no migrations |
| Config | `env.validation.ts` (defaults + required checks at boot) + typed `AppConfigService` getters. `ANOMALY_ALERT_CHAT_ID` is the only existing "admin destination" concept |
| Admin concept | **None** beyond the operational alert chat id. No admin user ids, no admin UI, no HTTP admin route |
| Tests | Jest unit/integration (42 suites / 639 tests) + e2e (4 suites / 25 tests, real app boot, `test/setup-env.ts`); strong existing doubles in `src/testing/test-doubles.ts` |
| Docker | 3-stage `Dockerfile`, `docker-compose.yml`, data volume on `/app/data` |

### Answers to the audit questions the phase asks for

* **Publication entry points:** `BotService` (three cron handlers) and — for user alerts — `AlertNotificationService` (out of scope for this phase, must stay untouched).
* **Active scheduled jobs:** the three crons above. **No duplicate cron registration** was found.
* **Delivery-result handling:** per platform, truthful (`success: false` never reported as success), but **not persisted** — there is no publication history.
* **Are failures swallowed?** No. `BaleService` returns structured failures; `BotService.reportDelivery` logs them truthfully.
* **Independent Telegram/Bale results?** Yes at the call level (`DeliveryResult[]`), but nothing tracks them per publication.
* **Timestamps/time zones:** `common/tehran-time.ts` is the single source (`tehranDayKey` = `Asia/Tehran`); stored timestamps are ISO/UTC.
* **Restart survival:** market state, users, alerts — yes. **Scheduled publications — nothing exists yet**, so nothing survives.
* **Duplicate publication possible?** Within one process the label guard prevents overlap, but a restart mid-publication, or a re-run of a cron, has no persisted record to prevent a repeat. **This is the main Phase 5 gap.**
* **Is the poster implementation used?** Yes — 12:15/16:15/19:15 cron.
* **Dead/obsolete publication code?** None found; `PriceMessageBuilder` and `PosterService` are both live.

## 2. Scope map for the seven message types (STEP 2)

| Message type | Source of truth | Formatter | Schedule | Destinations | Eligibility policy |
| --- | --- | --- | --- | --- | --- |
| `PRICE_UPDATE` | Phase 1 `PublishableMarketUpdate` (already the only publishable object) | **reuse** `PriceMessageBuilder` (variant `full`) / `PosterService` (variant `poster`) | existing crons (unchanged) | bale (+telegram if configured) | `update.publishable` + non-empty payload |
| `MARKET_MOVEMENT` | Phase 4 snapshot (`movement`, `movementPercent`, `movementDirection`, per-symbol `previousPrice`) | new (Phase 5) | after each price cycle, threshold-driven | same | per-symbol threshold + cooldown + re-arm; never from rejected/stale data |
| `DAILY_RANGE` | Phase 4 snapshot (`high`, `low`, `dailyChange`) | new | configurable cron (default **off**, preset 21:00 Tehran) + optional event-driven | same | needs `high`/`low` for ≥1 symbol; partial markets reported as partial |
| `DAILY_REPORT` | Phase 4 snapshot (description only) | new | configurable cron (default **off**, preset 23:00 Tehran) | same | `snapshot.hasData`; stale/partial explicitly labelled |
| `EDUCATIONAL` | `ContentItem` (manual, pillar **گنجینه طلایی اتابک**) | new (editorial) + brand footer | approved + scheduled by an admin | same | approval re-checked at execution |
| `BRANDED` | `ContentItem` (manual, brand pillar) | new (editorial) | approved + scheduled | same | approval re-checked at execution |
| `NIGHTLY_ANALYSIS` | `ContentItem` (manual, pillar **نگاه طلای اتابک**) + validated market block from Phase 4 | new (editorial + data appendix) | approved + scheduled | same | approval re-checked; reporting date must match the Tehran day |

## 3. Architecture decision (STEP 3)

New module `src/channel/`. Reuse-maximising, smallest-reliable design:

* **Reused:** `BotApiClient` (transport), `AppConfigService`, `MarketEngineService` (market gate), `MarketIntelligenceService` (all descriptive market numbers), `PriceMessageBuilder`/`PosterService` (price-update rendering), `common/*` (money, html, tehran-time, log-safety, branding), the JSON-store pattern with atomic writes (`AlertStore` style).
* **Added:** message-type registry, publication store (content items + jobs + deliveries + event state), eligibility policy (market gate, movement events, range events), channel publisher adapter (per-destination results, failure classification), channel engine (job creation, idempotency, execution, bounded retry, recovery), admin surface for editorial content (bot commands, admin-gated), Phase-5 additions to `env.validation.ts`/`AppConfigService`.
* **Not added:** no new dependency, no Redis/broker, no HTTP admin API, no second market state, no second freshness policy, no second scheduler.

### Persistence decision

One JSON document (`CHANNEL_DATA_FILE`, default `./data/channel.json`) holding content items, publication jobs, per-platform deliveries and event (movement/range) state — the same atomic-write pattern already proven three times in this repo. Atomicity requirements (§12: "prefer atomic state transitions over an in-memory boolean") are satisfied by a **synchronous critical section** in the store: job creation (`create-if-absent` by idempotency key) and the `PENDING → PUBLISHING` transition happen inside one non-yielding section, so two concurrent in-process invocations cannot both create or both execute the same job. This is explicitly an **in-process** guarantee; the deployment is a single process (documented limitation, §17 of the report).

### Media decision

`BotApiClient` gains `sendPhoto` (both platforms expose the Telegram-compatible method). Content may carry one optional image URL. Delivery rule: text-only message when no media; with media, the text is the photo caption when it fits the platform caption limit, otherwise the text is sent first and the photo is sent as a media-only message. Media outcome is recorded separately from the text outcome, and a media failure never un-delivers the textual payload (§ documented in the report).

### Admin/manageability decision (§19, §7)

The project has **no** admin interface and no authentication system; adding an unauthenticated HTTP admin API would be insecure, and inventing credentials is forbidden. The smallest safe mechanism that fits: **admin-only bot commands** (`/content`) gated by a configured allow-list of platform user ids (`CHANNEL_ADMIN_USER_IDS`), using the existing callback grammar (`v1:c:*`), the existing ownership model (identity is resolved server-side from the platform user), and the existing escaping. When the allow-list is empty the admin surface is **disabled** (no drafting, no approval, no scheduling) — editorial message types then never publish, which is the safe default.

## 4. Gaps Phase 5 must close (found by this audit)

1. No message-type identity, no publication jobs, no publication history.
2. No duplicate prevention across restarts (the current guard is in-memory only).
3. No per-destination delivery records and no bounded retry for channel publication.
4. No failure classification (retryable / permanent / ambiguous).
5. No scheduled editorial content and no approval workflow (`DAILY_REPORT`, `DAILY_RANGE`, editorial types have no path at all).
6. No missed-publication policy (a restart can silently drop a scheduled publication).
7. Media is not supported at all.

All seven are in scope and addressed below; nothing outside the phase scope is touched.

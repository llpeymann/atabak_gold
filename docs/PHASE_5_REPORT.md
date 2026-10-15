# PHASE 5 REPORT — 📢 CHANNEL ENGINE (Atabak Gold)

**PHASE 5 RESULT: COMPLETE — READY FOR PHASE 6**

This report follows the mandatory phase process order of the phase brief: audit (STEP 1) → scope map
(STEP 2) → architecture (STEP 3) → registry (STEP 4) → policies (STEP 5) → content management →
scheduling + idempotency → delivery tracking → integration with the existing flows → tests → quality
commands → diff review. Every number below was produced by a command that was actually executed on the
tree being reported on.

---

## 1. Executive Summary

Phase 5 adds a **content publication engine** to the existing application. It is the only path by which
anything reaches the channel, and it is deliberately *not* a content platform: it is the smallest
mechanism that satisfies the phase requirements — exactly seven typed message types, a typed payload, a
persistent job/delivery record, a per-destination delivery state, a bounded retry, an approval
lifecycle for editorial content and a Tehran-time scheduler.

It **produces no new data**. Prices come from the Phase 1 validated market state, statistics and
intelligence from the Phase 4 read-only layer; editorial content is typed by a human and approved by an
admin before it can exist as a publication. No formatter can fetch a price, mutate market state,
trigger an alert, decide data validity or change an approval state.

Delivered:

* **Message registry** with the seven allowed types (`PRICE_UPDATE`, `MARKET_MOVEMENT`, `DAILY_RANGE`,
  `DAILY_REPORT`, `EDUCATIONAL`, `BRANDED`, `NIGHTLY_ANALYSIS`); any other value is rejected at the
  boundary (`INVALID_MESSAGE_TYPE`), and the registry is the single source of truth for titles, pillars,
  destination scope and authorability.
* **Content entities separated**: a *content item* (editorial drafts) is never a *publication job*, and a
  job is never a *delivery*. One job may target both platforms and each destination keeps its own state
  — a successful Bale send can never conceal a failed Telegram send.
* **Editorial lifecycle** `DRAFT → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED | FAILED | CANCELLED`
  with approval **re-checked at execution time**, material edit ⇒ `revision + 1` ⇒ back to `DRAFT`
  (approval invalidated), cancellation that blocks a scheduled job, and a history that is never silently
  rewritten.
* **Admin surface inside the bot** (`/content …`, admin allow-list from configuration): no public
  unauthenticated admin API exists, and with an empty allow-list the surface is completely disabled.
* **Idempotency by logical identity** (`DAILY_REPORT` = Tehran day + destinations, editorial = content id
  + revision + destinations, market = subject set + slot + day + destinations): retries reuse the
  original identity, restarts never repeat a confirmed success, and an existing job is never duplicated.
* **Real delivery tracking** per destination (`PENDING → SENDING → SENT | FAILED | UNKNOWN`) with
  attempt counts, external message ids, media status kept separate from the text result, and an
  explicit **bounded** retry (default 3 attempts, exponential backoff, centralized configuration).
* **Failure classification**: HTTP 5xx/429 ⇒ `RETRYABLE`; other HTTP / API `ok:false` ⇒ `PERMANENT`; no
  answer at all ⇒ `AMBIGUOUS`, recorded as `UNKNOWN` and **never auto-retried** (a duplicate message is
  worse than a late one). Telegram failure never blocks Bale.
* **Tehran scheduling** with an explicit `Asia/Tehran` zone on a single per-minute tick (no per-time
  cron registration, therefore no overlapping/duplicate registrations), a configurable and documented
  missed-job policy, restart recovery that re-evaluates eligibility before publishing late market
  messages, and expired work recorded as `SKIPPED`/`MISSED_WINDOW` instead of being dropped silently.
* **Nine new specs** (unit + integration) and one e2e suite; the whole Phase 0–4 suite still passes.

Quality results on the tree being reported on (all commands actually executed, §19):

| Gate | Command | Result |
| --- | --- | --- |
| Install | `npm ci --no-audit --no-fund` | ✅ 691 packages, clean |
| Typecheck (all) | `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0 |
| Typecheck (build) | `npx tsc -p tsconfig.build.json --noEmit` | ✅ exit 0 |
| Build | `npm run build` | ✅ |
| Lint | `npx eslint "{src,test}/**/*.ts"` | ✅ **0 problems** |
| Unit + integration | `npm test` | ✅ **51 suites / 781 tests** |
| End-to-end | `npx jest --config test/jest-e2e.json` | ✅ **5 suites / 31 tests** |
| Coverage | `npm run test:cov` | ✅ statements **91.1 %**, branches **81.13 %**, functions **92.44 %**, lines **91.14 %** |
| Container | `sudo docker build -t atabak-gold-p5 .` + run | ✅ image built, container boots, `/health` returns `{"status":"ok"}` |
| Live runtime | rig against a real HTTPS wire + the **real Asia/Tehran tick** | ✅ **27/27 checks passed** (§19.4) |

## 2. Scope Delivered and Explicit Non-Goals

In scope and implemented: the seven message types; content preparation; type-specific formatting;
eligibility policies; destination configuration; scheduling; approval workflow; duplicate prevention;
real delivery tracking; bounded retry; publication history; operational logging; error isolation;
multi-platform delivery; and the full test matrix of §27.

Explicitly **not** implemented, by design: no AI/LLM/prediction/forecast/signal/advice/indicator; no CRM,
lead, referral, campaign, payment, order, inventory, portfolio, premium or dashboard feature; no new
market data provider; no microservice, Redis, Kafka, RabbitMQ, ClickHouse, TimescaleDB or Elasticsearch;
no second market state or second cache; no new database or ORM (persistence stays the project's existing
atomic JSON store pattern); **no new dependency** was added and no existing dependency changed; no
public/unauthenticated admin API; no future-phase (Phase 6) functionality.

Deliberate absences that a reader might expect are listed in §4 so they are not mistaken for gaps.

## 3. Process Compliance: Audit → Scope → Architecture → Registry → Policies → Content → Scheduling → Delivery → Integration → Tests → Quality → Review

* **STEP 1 — Audit.** `docs/PHASE_5_AUDIT.md` was written *before* any Phase 5 code: inventory of what
  already existed (Phase 1 validated state and market engine, Phase 2 UX/router/callback conventions,
  Phase 3 alerts, Phase 4 intelligence, the platform registry and both transport clients), what had to be
  added, what must not be touched (Phase 1 price truth, Phase 4 descriptive layer) and the decisions
  taken; plus the list of gaps found.
* **STEP 2 — Scope map.** The seven types were mapped to their data source, publisher and eligibility
  source **before** implementation, which is what made "no type can invent data" checkable.
* **STEP 3 — Architecture.** One new directory `src/channel/` (types, registry, store, policy, format,
  publisher, engine) plus one small `src/bot/content/` for the admin surface. Providers are registered
  flat in `AppModule` — the project keeps a single flat module tree, and a separate
  `channel.module.ts` was deliberately **not** added.
* **STEP 4 — Registry.** `message-registry.ts` first, so every later layer could be validated against
  the closed set of seven types.
* **STEP 5 — Policies.** `channel-policy.service.ts` implements the market gate, movement selection
  (threshold, cooldown, re-arm) and range-event selection as pure decisions over validated
  state — no publication, no formatting, no I/O.
* **Content management.** `content.service.ts` (domain, all writes through `store.transact`) +
  `content-admin.service.ts` (chat surface, admin allow-list, single acknowledgement per callback).
* **Scheduling + idempotency.** One named cron (`channel-engine-tick`) in Tehran time + persisted
  idempotency keys + an atomic state machine in the store.
* **Delivery tracking.** `channel-publisher.service.ts` (platform payload → per-destination outcome) and
  the delivery state machine inside the engine.
* **Integration.** `BotService` now routes its three existing publication points through the engine, so
  the price-update path kept its behaviour and gained duplicate protection (§17).
* **Tests → Quality → Review.** Specs were written alongside each layer, the gates were run repeatedly,
  and the final `git status` / `git diff` review checked for junk files, debug code and scope creep
  (§20).

## 4. Files Changed

Phase 5 is one commit on top of the Phase 4 commit.

| Area | Files |
| --- | --- |
| Channel domain (new) | `src/channel/channel.types.ts`, `message-registry.ts`, `content.service.ts`, `publication.store.ts`, `channel-policy.service.ts`, `channel-format.ts`, `channel-publisher.service.ts`, `channel-engine.service.ts` |
| Admin content surface (new) | `src/bot/content/content-admin.service.ts` |
| Specs (new) | `src/channel/{message-registry,channel-format,channel-policy,channel-publisher,channel-engine,content-lifecycle,channel-scheduling,publication.store}.spec.ts`, `src/bot/content/content-admin.spec.ts`, `test/channel-engine.e2e-spec.ts` |
| Wiring (changed) | `src/app.module.ts` (flat provider registration), `src/bot/bot.service.ts` (publication points routed through the engine), `src/bot/ux/bot-ux.service.ts` (content branch + admin dispatch), `src/bot/ux/callback-data.ts` (content callback namespace) |
| Transport (changed) | `src/platform/platform.types.ts` (`PlatformPublishResult`, `PlatformFailureKind`), `src/platform/bot-api.client.ts` (publish calls with classified failure kinds, timeouts, redaction) |
| Shared (changed) | `src/common/tehran-time.ts` (`tehranHourMinute`), `src/config/env.validation.ts` (+21 `CHANNEL_*` keys validated at startup), `src/config/app-config.service.ts` (typed getters) |
| Test support (changed) | `src/testing/test-doubles.ts` (platform publish doubles with per-platform failure injection, `createChannelHarness`), `test/setup-env.ts` |
| Docs | `README.md` (§4.5 + env table + cron table + failure/deployment notes), `docs/PHASE_5_AUDIT.md`, `docs/PHASE_5_REPORT.md` (this file) |

Deliberate decisions worth recording, because their absence is intentional:

* **No `src/channel/channel.module.ts`.** All Phase 5 providers live flat in `AppModule`, like every other
  phase in this repository; adding a module wrapper would have been churn without benefit.
* **No new persistence layer.** `PublicationStore` extends the project's existing atomic-JSON store
  pattern (same write discipline as `MarketStateStore`/`AlertStore`/`UserStore`).
* **No new dependency and no `package.json` change.**
* **`SKIPPED` jobs remain re-executable under the same identity.** A skip means *nothing was delivered*
  (no destination can be `SENT` without a real send), so "approve after a failed attempt, then publish"
  works without weakening the duplicate guard for a message that really went out.

## 5. Architecture and Data Flow

```
Phase 1 cron ─▶ validate/normalize ─▶ MarketStateService ─┐
                                                          ├─▶ ChannelPolicyService  (eligibility, thresholds, cooldown)
Phase 4 read-only  MarketIntelligenceService (.build) ────┘            │
                                                                       ▼
                              ChannelEngineService  ── registry (7 types) ── channel-format (render only)
                                       │
                     PublicationStore  (atomic JSON: contents, jobs, deliveries, event state)
                                       │
                              PublicationJob  (1) ── idempotencyKey ──▶ duplicate guard
                                       │
                    PublicationDelivery (n)  per destination: PENDING → SENDING → SENT | FAILED | UNKNOWN
                                       │
                              ChannelPublisher ─▶ BotApiClient ─▶ Bale / Telegram   (text + media, timeouts)

Admin (bot, allow-listed) ─▶ ContentAdminService ─▶ ContentService ─▶ PublicationStore (drafts, revisions, approvals)
                                                            └─▶ engine.publishContent(id)  (approval re-checked at execution)
```

Hard invariants enforced by construction:

1. `ChannelPolicyService` and `channel-format.ts` depend only on validated state / the intelligence
   snapshot — they have no transport, no store write and no clock they could use to invent a value.
2. `ChannelPublisher` is the only component that talks to a platform; business logic never builds URLs,
   never touches tokens and never parses transport errors.
3. A publication exists only as a persisted `PublicationJob`; two concurrent callers cannot both create
   it (creation happens inside a single serialized `store.transact`).
4. A destination that is already `SENT` is never sent again — not by a retry, not by re-running the
   tick, not after a restart.

## 6. Message Type Registry and the Seven Types

`message-registry.ts` defines `MessageTypeSpec` per type: Persian series title, pillar, whether it is
authorable by an admin, whether it carries a market-data block, and the idempotency identity shape.
`assertMessageType`/`isMessageType` reject anything outside the closed set, including values that
bypass TypeScript, so an unknown type cannot reach the engine even as a string.

| Type | Data source | Publication path | Identity |
| --- | --- | --- | --- |
| `PRICE_UPDATE` | Phase 1 validated state | automatic (existing price cron) | variant + Tehran day + `HH:MM` slot + subjects + destinations |
| `MARKET_MOVEMENT` | Phase 1 accepted movement | automatic, threshold + cooldown | subject + day + destinations |
| `DAILY_RANGE` | Phase 1 real daily high/low | scheduled (default off) or new-extreme event | `scheduled`/`event` + day + subjects + destinations |
| `DAILY_REPORT` | Phase 4 statistics | scheduled (default off) | Tehran day + destinations |
| `EDUCATIONAL` («گنجینه طلایی اتابک») | human, approved | manual (immediate or scheduled) | content id + revision + destinations |
| `BRANDED` | human, approved | manual (immediate or scheduled) | content id + revision + destinations |
| `NIGHTLY_ANALYSIS` («نگاه طلای اتابک») | human + optional Phase 4 block | manual, bound to its Tehran day | content id + revision + destinations |

## 7. Content Lifecycle, Approval and the Admin Surface

* States: `DRAFT → APPROVED → SCHEDULED → PUBLISHING → PUBLISHED | FAILED | CANCELLED`.
* A draft is never publishable: `publishContent` on a `DRAFT` returns
  `CONTENT_NOT_APPROVED` — verified end-to-end on the wire (§19.4).
* Approval carries `approvedAt`/`approvedBy` and is **re-checked when the job actually executes**, not
  only when it was scheduled; revision is checked *before* the draft check so that "approved once, then
  edited" is refused as a revision change.
* A material `edit` (title, body, media, type, or the market-data block toggling the rendered payload)
  increments `revision` and returns the item to `DRAFT`, clearing approval and scheduling. The new
  revision is a *different* logical identity, so a corrected post is a new publication and not a
  duplicate — and the old revision can never be re-sent.
* `cancel` blocks a scheduled job (`PUBLICATION_CANCELLED`); `reopen` creates `revision + 1` as a draft
  that needs a fresh approval.
* The admin surface is the bot itself: `/content`, `show`, `new`, `media`, `market`,
  `approve`, `schedule`, `publish`, `cancel`, `reopen`, `help`, plus inline buttons that only ever expose
  legal transitions. Non-admins get the ordinary menu and no hint that the surface exists (single
  acknowledgement per callback, no error disclosure). With `CHANNEL_ADMIN_USER_IDS` empty the surface is
  disabled entirely.
* Scheduling from the chat takes Tehran wall-clock (`YYYY-MM-DD HH:MM`) and stores an absolute instant
  (`tehranWallClockToIso('2026-10-01 09:30') = 2026-10-01T06:00:00.000Z`).

## 8. Formatters and Typed Payloads

`channel-format.ts` renders the typed `PublicationPayload` (`publicationId`, `messageType`, `text`,
`parseMode: 'HTML'`, optional media, `destinationKey`, `meta`) from already-computed inputs:

* Persian layout, Persian digits, `٪` for percentages, the Phase 1/4 display unit conversion (performed
  here and only here), Tehran timestamps and the type's series title.
* Messages end with the product's disclaimer where required and never contain advice, forecasts,
  signals, guarantees or invented values.
* Missing data is rendered explicitly (`⚠️ بخشی از نمادها داده معتبر امروز ندارند.`,
  `— بدون داده معتبر`), never as `0` and never with a "now" timestamp.
* HTML is escaped by the formatter (`<`, `>`, `&`), and media captions respect the platform caption limit
  (`CHANNEL_MEDIA_CAPTION_LIMIT`): over-long text is sent as its own message before the photo.
* A formatter cannot fetch prices, query the API, mutate market state or daily statistics, decide
  validity, trigger alerts, invent values or change approval state — none of those dependencies exist in
  its signature, and the specs assert the rendered output for the invalid/partial cases as well.

## 9. Eligibility Policies and the Market Gate

The engine decides, for every job, whether it may publish *now*:

| Skip reason | Meaning |
| --- | --- |
| `INVALID_MARKET_SNAPSHOT` | the snapshot is not a validated Phase 1/4 product |
| `STALE_MARKET_DATA` | the data is beyond `PRICE_STALE_AFTER_MINUTES` |
| `MISSING_REQUIRED_SYMBOL` | a symbol required by the message has no valid value |
| `INVALID_DAILY_STATISTICS` | daily open/current/high/low missing or inconsistent |
| `CONTENT_NOT_APPROVED` | editorial item not approved (or approval not valid at execution) |
| `PUBLICATION_CANCELLED` | the job/item was cancelled |
| `DUPLICATE_PUBLICATION` | the same logical identity was already delivered |
| `DESTINATION_UNAVAILABLE` | no destination is configured/enabled |
| `MOVEMENT_BELOW_THRESHOLD` | movement under the configured threshold |
| `RANGE_EVENT_SUPPRESSED` | new-extreme event suppressed by cooldown |
| `TYPE_DISABLED` | the type is switched off in configuration |
| `MISSED_WINDOW` | the scheduled window passed while the process was down |
| `CONTENT_NOT_PUBLISHABLE` | item missing/not in a publishable state |

Missing values are never substituted (`0` is a price, `null` is not), and a missing timestamp is never
replaced by "now".

## 10. Idempotency, Logical Identity and Duplicate Prevention

* Identity is a string key stored on the job and looked up inside the same transaction that would create
  the job, so two concurrent callers cannot both create it.
* Retries reuse the original key. Restarts reload the persisted jobs, and a key whose job is already
  `PUBLISHED` is refused as `DUPLICATE_PUBLICATION` without a network call (verified live: after a
  restart the same content publish produced *no* message and `bale=1 telegram=1` for the revision).
* Transitions are atomic over persisted state, not over in-memory booleans: `PUBLISHING` is written
  before any send, `PUBLISHED` only after every configured destination reports `SENT`.
* Ambiguity is recorded, not "fixed": an `UNKNOWN` outcome is never retried automatically and never
  counted as a success.
* `PRICE_UPDATE` keys include the slot and subject set, so a recovered tick cannot republish a slot that
  already went out while a *new* slot still publishes normally.

## 11. Scheduling in Asia/Tehran and the Tick Model

* One named cron, `channel-engine-tick` (`5 * * * * *`, `timeZone: 'Asia/Tehran'`), evaluated by
  `@nestjs/schedule`, which runs a named cron at most once per minute: no overlapping executions and no
  duplicate cron registration, whatever the configuration says.
* Publication times are configuration, not decorators: the tick compares the configured `HH:MM` with
  `tehranHourMinute(now)` and relies on the persisted key for "exactly one publication per day". This is
  what makes `CHANNEL_DAILY_RANGE_TIME`/`CHANNEL_DAILY_REPORT_TIME` changeable without a code change.
* Every time decision uses the fixed Tehran offset (UTC+3:30) from `src/common/tehran-time.ts`; the
  server's own time zone is never consulted.
* `NIGHTLY_ANALYSIS` is bound to its Tehran reporting day: publishing it on another day is refused as
  `MISSED_WINDOW` rather than posted late under the wrong date.
* Missed jobs (the process was down) are resolved by `CHANNEL_MISSED_JOB_GRACE_MINUTES`: an obsolete
  market update is *skipped and recorded*, editorial content inside its window still publishes, and
  nothing is discarded silently — every skip carries a typed reason in the history.

## 12. Retry, Failure Classification and Per-Destination Delivery

* Classification lives in the transport client: HTTP ≥ 500 and 429 (and explicit rate limits) ⇒
  `RETRYABLE`; any other HTTP status and `ok:false`/missing token ⇒ `PERMANENT`; timeout, socket reset or
  no response at all ⇒ `AMBIGUOUS`.
* The engine maps that to `SENT` / `FAILED` / `UNKNOWN` per destination, stores `attemptCount`,
  `failureCategory`, `lastAttemptAt`, `externalMessageId`, `sentAt` and a redacted `lastError`.
* Retry is bounded by `CHANNEL_PUBLICATION_MAX_ATTEMPTS` with exponential backoff from
  `CHANNEL_PUBLICATION_RETRY_DELAY_MS`; only `RETRYABLE` failures are retried and never after a
  confirmed success. Live evidence: an injected Telegram HTTP 500 produced exactly 3 attempts while Bale
  received exactly one message.
* Media: a photo whose caption fits is sent with the caption; a longer text is sent first and the photo
  follows as its own message. A permanent photo rejection falls back to the text-only publication, and
  the media outcome is stored separately (`mediaStatus`/`mediaError`) so a text success can never hide a
  media failure.
* Permanent failures are observable (`FAILED` + `lastError` + a logged error line), never swallowed, and
  never written as success (§28).

## 13. Persistence, Restart Recovery and Missed Jobs

`PublicationStore` keeps contents, jobs, deliveries, movement-event state and range-event state in one
atomic JSON document (`CHANNEL_DATA_FILE`), written by replacing the file after a serialized
transaction — the same discipline as the existing stores. It tolerates a missing, corrupt or
unexpectedly-shaped document without losing data that is still readable, drops malformed records
individually instead of discarding the file, prunes history without ever dropping in-flight jobs and
returns copy-on-read values.

Recovery on boot (`recover(now)`):

1. Any job whose destinations include a `SENT` is marked `PUBLISHED` — **nothing is re-sent**.
2. Any job with an `UNKNOWN` destination is marked `FAILED` with `DELIVERY_OUTCOME_UNKNOWN` and is not
   retried automatically.
3. Jobs whose window has passed are `SKIPPED`/`MISSED_WINDOW`; stale `PENDING` jobs are skipped rather
   than published late.
4. Nothing is re-created: the persisted key is checked before any new job could be made.

## 14. Daily Range: Scheduled vs Event

* The scheduled `DAILY_RANGE` message reports the **real** daily high/low of the Tehran day from Phase 1
  statistics, with the observation time; it never derives a range from the two prices it happened to see.
* Event mode (default off) fires only when a *new* daily extreme is established **and** the value exists;
  without the statistic no event is produced, and there is no extra polling — the baseline is recorded
  during the tick from the same snapshot the rest of the system reads.
* Cooldown (`CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES`) suppresses chains of small new extremes; the
  suppression is recorded (`RANGE_EVENT_SUPPRESSED`), not silent.
* Scheduled and event messages are distinct identities, so an event cannot mask the scheduled message,
  and neither can publish twice on the same day/slot.

## 15. Market Movement: Thresholds, Cooldown and Re-arm

* Movement compares the current validated value with the previous validated value (Phase 1's notion of
  movement), in **both** directions, and publishes only above the effective threshold.
* Effective threshold = per-symbol override (`CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES`) else the global
  default (`CHANNEL_MOVEMENT_THRESHOLD_PERCENT`). **A missing threshold never means unrestricted
  publication**: when no override exists the documented global default applies, and a value of `0`
  disables the symbol deliberately and visibly (it is a configured decision, not a fallback).
* Cooldown per symbol (`CHANNEL_MOVEMENT_COOLDOWN_MINUTES`) plus re-arm at half the threshold prevent
  publication for every tiny fluctuation while still allowing a genuine second move to be reported.
* Event identity is deterministic (subject + Tehran day + destinations), and the same movement cannot be
  published twice.

## 16. Daily Report, Educational, Branded and Nightly Analysis

* `DAILY_REPORT` renders Phase 4 values as they are (open, current, high, low, absolute and percentage
  daily change, last valid update and freshness). It **recalculates nothing** and fabricates nothing;
  stale or partial data is labelled explicitly ("بخشی از نمادها داده معتبر امروز ندارند") and the message
  is readable on both platforms. Its identity is the Tehran day + destinations, so revisions of the
  process cannot turn into duplicate reports (§19.4 shows one report per destination for the day, and a
  further tick changed nothing).
* `EDUCATIONAL` («گنجینه طلایی اتابک») and `BRANDED` are human content behind the approval workflow; the
  delivered text is exactly the approved body, escaped, wrapped in the type's layout and accompanied by
  the product's standard footer.
* `NIGHTLY_ANALYSIS` («نگاه طلای اتابک») combines approved editorial prose with an optional
  validated-data block; its quantitative claims can therefore only come from Phase 1/4, it warns when the
  data is partial or stale, it never invents a "previous close", and it carries no guarantees, signals or
  advice. It is bound to its Tehran reporting day.

## 17. Integration with Phases 1–4 and Regression Safety

* `BotService` keeps its three cron entry points (half-hourly price update, daily closing price, poster
  report); each now runs Phase 1's cycle exactly as before, then hands the publishable result to the
  engine (`runCycle(...) → evaluateCycle → reportCycle → publishPriceUpdate → publishMarketEvents`). The
  price message is therefore still produced by the existing builder and still goes to the same
  destinations; what changed is that duplicates are now prevented by the engine rather than by an
  in-memory flag.
* Phase 1 remains the single price truth and Phase 4 the source of descriptive intelligence: no Phase 5
  component can fetch a price, validate one, alter daily statistics or bypass the anomaly/sanity filter.
  A rejected or anomalous price cannot become a channel message, and no Phase 5 path can trigger an alert.
* Alerts (Phase 3) still evaluate on the Phase 1 → Phase 3 path; the publication engine neither triggers
  them nor duplicates their evaluation.
* The existing UX stays intact: the market/alert/favorites screens and their callbacks behave as before
  (the only UX addition is the admin content surface and its own callback namespace), and the whole
  Phase 0–4 test suite still passes unchanged (§19.2).

## 18. Configuration, Logging, Observability and Documentation

* **21 `CHANNEL_*` keys** were added, all validated at startup by `env.validation.ts` and exposed through
  typed getters in `app-config.service.ts`, all documented in `.env.example`, the README table and §4.5:
  `CHANNEL_DATA_FILE`, `CHANNEL_ADMIN_USER_IDS`, `CHANNEL_MAX_CONTENT_CHARS`,
  `CHANNEL_MEDIA_CAPTION_LIMIT`, `CHANNEL_HISTORY_LIMIT`, `CHANNEL_PUBLICATION_MAX_ATTEMPTS`,
  `CHANNEL_PUBLICATION_RETRY_DELAY_MS`, `CHANNEL_MISSED_JOB_GRACE_MINUTES`,
  `CHANNEL_MOVEMENT_THRESHOLD_PERCENT`, `CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES`,
  `CHANNEL_MOVEMENT_COOLDOWN_MINUTES`, `CHANNEL_DAILY_RANGE_ENABLED`, `CHANNEL_DAILY_RANGE_TIME`,
  `CHANNEL_DAILY_RANGE_EVENTS_ENABLED`, `CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES`,
  `CHANNEL_DAILY_REPORT_ENABLED`, `CHANNEL_DAILY_REPORT_TIME` … plus the shared channel keys already
  documented in earlier phases.
* The two scheduled market messages are **off by default** (`CHANNEL_DAILY_RANGE_ENABLED=false`,
  `CHANNEL_DAILY_REPORT_ENABLED=false`) because switching them on changes the channel's cadence — that
  must be an explicit operational decision, not a side effect of upgrading.
* Logging is operational and secret-free: policy summary at boot, one line per publication decision
  (delivered / not delivered / skipped-with-reason), retry warnings with attempt numbers, an error line
  for permanent failures, and a boot line stating destinations, history size and data file. Tokens are
  redacted by the shared `log-safety` helper and never appear in messages, logs or the store.
* No false success is ever logged: a partially delivered job reports exactly which destination did not
  receive the message, and the reason is persisted.

## 19. Tests and Quality Gates

### 19.1 Required scenarios (§27) — all covered

| Requirement | Where |
| --- | --- |
| registry: 7 types, invalid type rejected, mapping | `message-registry.spec.ts` (10) |
| `PRICE_UPDATE` publication and duplicate prevention | `channel-engine.spec.ts`, `test/channel-engine.e2e-spec.ts` |
| movement up / down / below threshold / missing threshold / suppression / cooldown / re-arm / rejected data | `channel-policy.spec.ts` (22), `channel-engine.spec.ts` |
| daily range: valid / missing / first / new high / new low / unchanged / day reset / scheduled vs event | `channel-policy.spec.ts`, `channel-engine.spec.ts`, `channel-format.spec.ts` |
| daily report: valid / partial / stale / missing statistics / no fabrication / Tehran date / duplicate | `channel-engine.spec.ts`, `channel-format.spec.ts`, `test/channel-engine.e2e-spec.ts` |
| editorial lifecycle (educational, branded, nightly), duplicates, history | `content-lifecycle.spec.ts` (18), `content-admin.spec.ts` (29) |
| delivery success / failure / timeout / retry / permanent / ambiguous / independent destinations / restart | `channel-publisher.spec.ts` (12), `channel-engine.spec.ts`, `publication.store.spec.ts` (11) |
| scheduling: time zone, execution, overlap, concurrency, cancel, missed, recovery | `channel-scheduling.spec.ts` (9), `channel-engine.spec.ts` |
| Phase 0–4 regression | the full suite (51 suites) |
| no test sends a real message | every platform call is a double (`test-doubles.ts`); network is never used in tests |

### 19.2 Test counts on the tree being reported on

* `npm test` → **51 suites, 781 tests, all passing** (Phase 4 baseline was 42 suites/639 tests; Phase 5
  adds 9 suites / 142 tests and touches no existing expectation).
* `npx jest --config test/jest-e2e.json` → **5 suites, 31 tests, all passing**.
* Focused Phase 5 specs: registry 10, format 12, policy 22, publisher 12, engine 19, content lifecycle
  18, scheduling 9, store 11, content-admin 29, `test/channel-engine.e2e-spec.ts` 6.

### 19.3 Coverage (whole repository, `npm run test:cov`)

Statements **91.1 %**, branches **81.13 %**, functions **92.44 %**, lines **91.14 %**.
Phase 5 modules: `message-registry.ts` **100 %** on all four metrics, `channel-publisher.service.ts`
statements/lines **100 %** (branches 88.09 %), `content-admin.service.ts` **93.8 %** statements with
**100 %** functions, `channel-format.ts` 90.65 %, `channel-engine.service.ts` 84.63 %,
`channel-policy.service.ts` 83.68 %, `publication.store.ts` 80.81 %, `content.service.ts` 78.18 %.
The uncovered lines are defensive branches (corrupt-file handling, unexpected store shapes, generic
error paths) that the store spec exercises at the boundary rather than through every permutation — none
of them is an untested *decision* of the engine.

### 19.4 Live runtime verification (real clock, real HTTP wire, real tick cron)

A wire-level rig (`/home/user/.tmp-p5-runtime/`) ran the **built** application (`node dist/main.js`) with
`/etc/hosts` mapping `tapi.bale.ai` **and** `api.telegram.org` to a local HTTPS mock that emulates both
APIs (each with its own inbound queue) plus the Phase 1 price API. **No application file was patched or
stubbed for the run**; the only doubles live inside the rig. 27 checks were executed; **all passed**.

1. **Editorial lifecycle over the real admin surface** — `/content new EDUCATIONAL …` created a draft
   (`DRAFT`), `/content approve` stored `APPROVED` with a timestamp, `/content publish` delivered to
   **@atabak_bale** *and* **@atabak_telegram**; both deliveries are recorded `SENT` with external message
   ids and the job is `PUBLISHED`.
2. **Duplicate refusal** — publishing the same revision again was refused, the operator was told
   `ℹ️ قبلاً منتشر شده است؛ پیام تکراری ارسال نشد.`, **no second message** appeared on the wire, and no
   second job was created.
3. **Unapproved draft blocked** — a freshly created `BRANDED` draft answered
   `❌ منتشر نشد — دلیل: CONTENT_NOT_APPROVED` with zero network calls.
4. **Independent destinations** — with an injected Telegram HTTP 500 the same job produced
   `bale: SENT (#1010)` / `telegram: FAILED` with exactly **3** Telegram attempts (the configured bound),
   exactly **1** Bale message, and the job history kept the failed destination visible instead of
   reporting a clean success.
5. **Scheduled daily report by the real Tehran tick** — with `CHANNEL_DAILY_REPORT_TIME` set one minute
   ahead, the real cron produced exactly **one** `DAILY_REPORT|2026-10-16|bale+telegram` job, rendered
   from the restored Phase 1 state (`۱۷٬۹۵۰٬۰۰۰ ریال` for طلای ۱۸ عیار, `+۲٫۵۷٪`, explicit partial-data
   warning), delivered once to each destination — and a further tick changed nothing.
6. **Restart safety** — after a restart the engine logged `history 3 job(s)`, re-sent **nothing**, and the
   persisted jobs/deliveries were byte-identical to before the restart.

Verbatim wire payloads, the rendered messages, the admin decisions and the persisted state are in
`/home/user/phase5-runtime-transcript.md`.

Two defects were found by this run and fixed before the commit: a duplicate publication reported as a
plain success (now explicitly reported as "already published, no duplicate sent"), and a dead
`platformOf()` helper removed from the publisher.

### 19.5 §33 hard rules

Verified before declaring completion: the seven types exist and nothing else is accepted; the three
pillars are intact (Phase 1 sole price truth, Phase 4 descriptive intelligence, no second state/cache);
the publisher cannot bypass validation; editorial content requires approval that is re-checked at
execution; duplicate prevention is as strong as the platform allows (logical identity + persisted
keys + atomic transition); Bale and Telegram are tracked independently; no false-success logging exists;
retries are bounded and permanent failures are observable; ambiguous outcomes are neither treated as
success nor auto-retried; Tehran scheduling is explicit and server-zone independent; restart and
missed-job behaviour is explicit and tested; the existing price posting still works through the same
builder and destinations; the Phase 0–4 regression suite still passes; there is no AI/prediction/
recommendation feature; no unnecessary infrastructure or dependency was added; all changed files were
reviewed; and this report reflects the actual, executed results.

## 20. Repository, Delivery Status and Readiness for Phase 6

* **Scope review**: `git status` shows only the intended sources, specs and docs; no temporary, debug or
  generated file is tracked (`grep` for `console.log`, `TODO`, `FIXME`, `debugger`, `.only` in the new
  code returns nothing; `src/channel/__dbg.spec.ts` was deleted during development and does not exist);
  `git diff` was reviewed file by file, including the touched Phase 1–4 files.
* **Commit**: Phase 5 is one commit on top of the Phase 4 commit (`4d6ae8d`), pushed to
  `origin/main` — see the push evidence below.
* **Push**: performed with an explicit fast-forward push and verified against GitHub afterwards
  (`main -> main`, local `HEAD` == remote `HEAD`); no force push, no history rewrite, no `git add .`
  (every file was listed explicitly), and no token appears in any report, log or commit.
* **Delivery artifacts**: patch/bundle artifacts for the phase delta and the complete history are
  regenerated after the commit, alongside `/home/user/phase5-runtime-transcript.md` (runtime evidence)
  and this report.
* **Phase 6 readiness**: the channel engine is the stable seam for any further work — new
  destinations are added in `ChannelPublisher`, new message types would be added to the registry and
  policies, and the store already serializes history, deliveries and event state. Nothing in Phase 5
  assumes a specific cron cadence beyond the tick, and nothing outside `src/channel/` needs to change to
  extend it.

**PHASE 5 COMPLETE — READY FOR PHASE 6**

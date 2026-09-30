# PHASE 3 REPORT — 🔔 PRICE ALERT (Atabak Gold)

**PHASE 3 RESULT: COMPLETE**

Repository: `github.com/llpeymann/atabak_gold` · branch `main` · base commit `708434e` (Phase 2)
Deliverable: **one commit on top of `708434e`** — the exact commit/tree hashes are written into the
`phase3-atabak-gold.patch` header and the hand-off message · Date: 2026-09-30 · Timezone: Asia/Tehran

> Push status: **BLOCKED** (no repository credentials in this environment — see section 24). The full
> commit is shipped as `phase3-atabak-gold.patch` + `phase3-atabak-gold.bundle` (and as an all-phases
> patch/bundle), verified by re-applying the patch to the base commit and comparing Git tree hashes.

---

## 1. Executive Summary

Phase 3 adds a persistent, deterministic, one-shot price-alert system on top of the Phase 1 Market
Reliability Engine and the Phase 2 bot UX. Nothing in Phase 0/1/2 was redesigned; the alert engine is a
**consumer of the validated Phase 1 market state** and has no path to the external price API.

| Area | Result |
| --- | --- |
| Alert types | `PRICE_ABOVE`, `PRICE_BELOW`, `PERCENT_CHANGE` (direction `UP`/`DOWN`) — section 6 |
| Trigger semantics | crossing (`previous < target ≤ current` / `previous > target ≥ current`), gaps and equality included — section 7 |
| One-shot | an alert fires at most once; `TRIGGERED` is terminal until the user deletes it — sections 10, 17 |
| Baseline | fixed at creation from a fresh Phase 1 price, refreshed only on explicit percentage edit/re-enable — section 9 |
| Persistence | atomic JSON (`ALERTS_DATA_FILE`), survives restarts, no migration/reset of existing data — section 5 |
| Notifications | existing Telegram/Bale adapter abstraction, exactly one delivery record per trigger, bounded retries — sections 15, 16 |
| Safety | rejected/anomalous/stale data is never evaluated; ownership and status validated server-side on every action — sections 11, 13 |
| Limits | `MAX_ALERTS_PER_USER` (default 5) enforced inside the same atomic transaction as creation — section 19 |
| UX | `🔔 هشدار قیمت` hub, create wizard, My Alerts, alert detail with status-appropriate actions — section 20 |
| Tests | 39 suites / 571 unit tests + 3 suites / 18 e2e tests, all green; live runtime regression with the real scheduler — section 23 |
| Gates | `npm ci`, `npm run build`, `npm run lint`, `npx jest`, `npm run test:e2e`, `docker build` — section 23 |

## 2. Repository Audit (STEP 1) and Files Changed

Full audit: [`docs/PHASE_3_AUDIT.md`](./PHASE_3_AUDIT.md) (written before any code changed, plus a
"§4 As-built deltas" table listing every place where the implementation consciously deviated from the
pre-code design and why).

| # | Finding | Consequence |
| --- | --- | --- |
| B1 | Phase 1 keeps exactly one trusted price path: `PriceService.fetchRawPayload` → `RawPayloadParser` → `PriceNormalizer` → `SanityChecker` → `MarketEngineService.evaluateCycle` → `MarketStateService`. | Alerts listen to the commit boundary only; no second polling loop, no second price cache. |
| B2 | The engine already exposed a listener seam (`registerUpdateListener`) used by nothing. | Phase 3 registers one listener there; the hook is 4 lines and touches no Phase 1 decision. |
| B3 | Phase 2 persistence is atomic JSON + rename (`USER_DATA_FILE`), no ORM, no migrations. | Alerts reuse the same pattern (`ALERTS_DATA_FILE`); a database would contradict §4/§65. |
| B4 | Phase 2 already owns user identity (`UserStore`, platform + platformUserId). | Alerts reference `userId` only; no second user system, platform preserved. |
| B5 | `src/bot/ux/callback-data.ts` is a dependency-free v1 grammar with a spec. | The alert grammar extends it (`v1:alert:*`); parsing stays pure and unit-testable. |
| B6 | The `🔔 هشدار` entry existed as a Phase 2 placeholder with a "not yet available" screen. | The placeholder was replaced by the real hub; no second navigation system was introduced. |
| B7 | Symbols live in the canonical registry `src/market/symbols.ts` (with per-symbol unit + acceptance bounds). | The wizard lists registry entries only; the service rejects anything not in the registry. |

**Files changed:** 43 paths — 25 modified (`+2038 / −81`) and 18 new files (7167 lines).

| New | Purpose |
| --- | --- |
| `src/alerts/alert.types.ts` | Domain model, status/type/direction/delivery enums, result + reason types |
| `src/alerts/alert.store.ts` | Atomic JSON persistence, per-symbol / per-user indexes, serialized transactions |
| `src/alerts/alert-evaluator.ts` | Pure condition evaluation (no I/O) |
| `src/alerts/alert.service.ts` | Ownership, validation, lifecycle, capacity, trigger reservation, delivery bookkeeping |
| `src/alerts/alert-format.ts` | Persian rendering (screens, notification, condition text, spacing rules) |
| `src/alerts/alert-notification.service.ts` | Delivery through the platform adapter, bounded retries, outcome recording |
| `src/alerts/alert-engine.service.ts` | Market-update listener → evaluate → reserve → notify |
| `src/bot/ux/alert-callback.types.ts` | Compact alert type keys for callback payloads |
| `src/bot/ux/number-input.ts` | Strict Persian/Latin numeric parser (single value, no ambiguity) |
| `src/bot/ux/alert-flow.integration.spec.ts`, `src/alerts/*.spec.ts`, `src/bot/ux/number-input.spec.ts`, `test/alert-journey.e2e-spec.ts`, `docs/PHASE_3_AUDIT.md` | Tests + documentation |

| Modified | Change (one line) |
| --- | --- |
| `src/app.module.ts` | Registers the four Phase 3 providers |
| `src/market/market-engine.service.ts` | Emits committed prices to listeners (accepted, committed prices only) |
| `src/users/user.types.ts`, `user.store.ts`, `user.service.ts` | Store the chat id used for alert delivery (same user identity) |
| `src/bot/ux/bot-ux.service.ts` | Alert router, wizard, screens, status-aware actions |
| `src/bot/ux/callback-data.ts`, `ux-keyboards.ts`, `ux-event-log.service.ts` | Alert callback grammar, keyboards, in-app event logging |
| `src/bot/ux/ux-format.ts`, `ux-format.spec.ts` | Removed the dead Phase 2 alerts placeholder formatter |
| `src/config/app-config.service.ts`, `src/config/env.validation.ts` | New Phase 3 configuration (validated, documented) |
| `src/common/money.ts` | Shared rounding helper used by alert presentation |
| `README.md`, `.env.example` | Alert documentation and environment variables |
| existing specs (`bot-ux.service.spec.ts`, `callback-data.spec.ts`, `favorites.integration.spec.ts`, `market-flow.integration.spec.ts`, `markup-integrity.spec.ts`, `test-doubles.ts`, `market-engine.integration.spec.ts`, `test/bot-ux.e2e-spec.ts`, `test/setup-env.ts`) | Extended for the alert path (new cases only; no weakened assertions) |

## 3. Architecture Changes

```
External Market API
        │  (unchanged, Phase 1 only)
        ▼
PriceService → Parser → Normalizer → SanityChecker → MarketEngineService.evaluateCycle
        │                                    │
        │                                    ▼
        │                          MarketStateService (validated state)
        │                                    │
        │  committed prices only             │  getState(symbol) — read-only
        ▼                                    ▼
AlertEngineService.handleCommittedPrices ──► AlertEvaluator (pure)
        │                                          │
        │                                          ▼
        │                                   Trigger decision + reason
        ▼                                          │
AlertService.reserveTrigger  ◄── AlertStore.transact() ──► Alert TRIGGERED + AlertDelivery PENDING
        │
        ▼
AlertNotificationService ──► PlatformRegistry adapter ──► Telegram / Bale ──► user chat
```

* Exactly one integration point with Phase 1: `MarketEngineService.registerUpdateListener`, called after
  `marketState.commit(...)` with **accepted** prices, so rejected/anomalous data can never reach the
  evaluator. `notifyListeners` is wrapped so a listener failure is logged and cannot break the market
  cycle.
* The evaluator is pure (`evaluateAlert(alert, observation) → AlertEvaluationResult`); all I/O,
  state transitions and notifications live outside it.
* The alert engine never calls `PriceService`, never re-derives prices and never keeps its own price
  history; crossing uses the Phase 1 `previousPrice`/`currentPrice` pair of the committed observation.
* No new infrastructure: no Redis/Kafka/queue/worker/microservice; the only new dependency count is zero
  (`package.json` unchanged).

## 4. Domain Model and Enums (STEP 2)

`src/alerts/alert.types.ts` (names below are the real ones):

| Concept | Fields |
| --- | --- |
| `Alert` | `id`, `userId`, `symbol`, `type` (`PRICE_ABOVE`/`PRICE_BELOW`/`PERCENT_CHANGE`), `direction` (`UP`/`DOWN`, `null` for absolute), `status` (`ACTIVE`/`DISABLED`/`TRIGGERED`/`DELETED`), `targetPrice`, `targetPercent`, `baselinePrice`, `createdAt`, `updatedAt`, `disabledAt`, `triggeredAt`, `deletedAt`, `triggerPrice`, `triggeredPercent` |
| `AlertDelivery` | `alertId` (unique), `userId`, `platform`, `chatId`, `status` (`PENDING`/`SENT`/`FAILED`), `attemptCount`, `triggeredAt`, `sentAt`, `lastAttemptAt`, `lastError`, `skippedReason` |
| `AlertEvaluationResult` | `alertId`, `shouldTrigger`, `reason` (machine-readable), `currentPrice`, `previousPrice`, `target`, `changePercent`, `evaluatedAt` |
| `MarketObservation` | `symbol`, `currentPrice`, `previousPrice`, `receivedAt` — the only market input the evaluator accepts |

No arbitrary strings are used for domain decisions: statuses, types, directions, reasons and skip
reasons are all typed unions with exhaustive `switch`es (TypeScript narrows them; a new member breaks the
build rather than silently falling through).

## 5. Persistence and Migration Safety

* `ALERTS_DATA_FILE` (default `./data/alerts.json`) holds `{ alerts: [...], deliveries: [...] }`, written
  with the same atomic technique as Phase 1/2 (write temp file → `rename`), so a crash mid-write cannot
  corrupt the file. An unreadable/corrupt file is logged and treated as empty instead of crashing.
* `AlertStore.transact(mutator)` serializes all mutations through one promise chain, so capacity checks,
  status transitions, trigger reservation and delivery bookkeeping are atomic with respect to each other
  inside a single process (§37, §66). Reads are answered from the maintained indexes
  (`activeBySymbol`, `alertsByUser`) — no full-file scan per market tick (§57).
* Migration safety (§93, §94): no schema/database exists to migrate; the store **adds** a file next to the
  existing market-state and user files and never rewrites, resets or drops them. Phase 2 user records and
  favourites are untouched; the only change is an added `chatId` field on the user record, which is
  optional and back-filled on the next interaction (older records keep working).
* Backward compatibility: every pre-existing environment variable keeps its meaning and default; all new
  ones have defaults, so an unchanged `.env` still boots with alerts enabled.

## 6. Alert Types and Condition Semantics

| Type | Condition (evaluated on unrounded values) | Trigger reason |
| --- | --- | --- |
| `PRICE_ABOVE` | `currentPrice >= targetPrice` | `PRICE_ABOVE_REACHED` |
| `PRICE_BELOW` | `currentPrice <= targetPrice` | `PRICE_BELOW_REACHED` |
| `PERCENT_CHANGE` + `UP` | `((current − baseline) / baseline) * 100 >= targetPercent` | `PERCENT_INCREASE_REACHED` |
| `PERCENT_CHANGE` + `DOWN` | `((current − baseline) / baseline) * 100 <= −targetPercent` | `PERCENT_DECREASE_REACHED` |

* `targetPercent` is stored as a positive magnitude plus an explicit direction, so the user always picks
  `📈 افزایش درصدی` or `📉 کاهش درصدی`; there is no ambiguous raw `±` input (§26, §28).
* No rounding before comparison: `2.0049%` stays `2.0049%`; rounding happens only in presentation
  (`formatPercentFa`, `formatRial`) (§30, §53).
* Internally all prices stay in the Phase 1 canonical unit (Rial, `USD` for `XAUUSD`); no `× 10`/`÷ 10`
  anywhere — the single conversion/formatting boundary is `src/common/money.ts` + `alert-format.ts`.

## 7. Crossing, Gap and Equality Semantics

The evaluator implements crossing, not mere satisfaction:

| Type | Trigger condition |
| --- | --- |
| `PRICE_ABOVE` | `previousPrice < targetPrice && currentPrice >= targetPrice` |
| `PRICE_BELOW` | `previousPrice > targetPrice && currentPrice <= targetPrice` |

* Gap handling (§12): `previous = 17,400,000`, `current = 17,800,000`, `target = 17,500,000` → triggers.
  The comparison is against the previous **valid** observation, so a jump over the target still counts.
* Equality (§13): `previous < target && current == target` triggers (and symmetrically for below).
* Already-true conditions do **not** fire: `previous >= target && current >= target` is not a crossing, so
  an alert created while the market already satisfies its condition never produces a surprise
  notification; the wizard detects that state, states it explicitly in Persian
  (`همین حالا برقرار است`) and requires an explicit `✅ تأیید` before creating the alert (§14).
* `previousPrice` is `null` only when Phase 1 has no earlier accepted price (e.g. the first accepted price
  of a new Tehran day). Such an observation cannot establish a crossing, so it does not trigger; the alert
  stays `ACTIVE` and fires at the next genuine crossing. This limitation is documented in the README
  (§62 — a real limitation instead of an invented guarantee).
* Percent alerts require a crossing of the percentage threshold in the same way
  (`previous` change below the threshold, `current` change at/above it), which is what keeps them
  consistent with the "one crossing, one shot" model.

## 8. Creating or Re-Enabling an Alert Whose Condition Already Holds

* Creation: the confirmation screen shows the current price and a Persian note that the condition is
  already satisfied; the alert is created as `ACTIVE` waiting for a **future** crossing, never firing
  because of the at-creation state.
* Re-enable (absolute alert): the alert becomes `ACTIVE` and simply waits for the next crossing; the
  current price is not used to fire it (§16).
* Re-enable (percentage alert): the baseline is **replaced with the latest fresh, valid Phase 1 price**
  and monitoring restarts from that point (§16). If no fresh valid price exists, the enable is refused
  with a Persian explanation instead of arming an alert with a stale baseline.
* Policy outcome: no re-enable can produce an immediate "because it was already true" notification — the
  tests assert exactly that for all four types.

## 9. Percentage Baseline Rules

1. At creation the baseline is read from the Phase 1 market state for that symbol and accepted only when
   it is fresh and strictly positive; otherwise creation fails with a clear Persian message
   (`⚠️ قیمت معتبر این نماد در دسترس نیست.`) and nothing is stored (§6, §8, §51).
2. Rejected values (`null`, `undefined`, `NaN`, `±Infinity`, `≤ 0`, non-numeric) can never become a
   baseline; the guard is inside the domain layer, not only in the wizard.
3. The baseline is then **fixed**: it is never silently recalculated on later market updates, and no code
   path recomputes it from "the latest price" implicitly.
4. It changes only through an explicit percentage edit (the new baseline becomes the current fresh price,
   atomically with the new target) or an explicit re-enable of a disabled percentage alert (§16, §17).
5. The confirmation screen shows the baseline and an approximate target price for orientation, but the
   percentage formula above is the authoritative condition (§32).

## 10. Lifecycle and State Transitions

```
                 create                    trigger
   (new) ──────────────► ACTIVE ─────────────────────► TRIGGERED ──┐
                          │  ▲                                       │ delete
                 disable  │  │  enable (absolute: wait for crossing; │
                          │  │  percent: new baseline)               │
                          ▼  │                                       │
                       DISABLED                                     ▼
                          │                                    DELETED
                          └────────────── delete ─────────────────────┘
```

* `DELETED` is a soft delete (`status = DELETED`, `deletedAt` set); the record stays in the file for
  auditability but leaves every user list, every index and the capacity count (§18, §67).
* `TRIGGERED` is terminal for evaluation: a one-shot alert never fires twice, and the UI offers only
  `🗑 حذف` for it. Enabling a triggered alert is refused server-side (`INVALID_STATE`) and has a dedicated
  test.
* Only legal transitions exist in the service API; each one re-checks the current status inside the
  transaction, so a stale button (e.g. "disable" on an alert that just triggered) is rejected instead of
  producing an inconsistent state.

## 11. Ownership and User Identity

* Every alert carries `userId` (Phase 2 `User.id`), and **every** service entry point that takes an alert
  id also takes the owner id: `findForUser`, `edit`, `disable`, `enable`, `delete`, `reserveTrigger`,
  and delivery lookups. Ownership is enforced in the domain layer; the router's checks are additional,
  never the only line of defence (§19, §68).
* A foreign or unknown id produces the same user-visible answer (`این هشدار قابل استفاده نیست.` →
  `ALERT_NOT_FOUND`), so the API never leaks whether somebody else's alert exists.
* Identity is the Phase 2 platform identity (`platform` + `platformUserId`), so a Bale user and a Telegram
  user with the same numeric id are different owners. The chat id used for delivery is stored on the same
  user record; there is no second user model (§20).

## 12. Symbol Validation

* The wizard's symbol keyboard is generated from the canonical registry (`symbolRegistry` in
  `src/market/symbols.ts`) — no local list, no invented instrument, no hard-coded Persian names (§21).
* The router validates the callback symbol against the registry before showing the type step (unknown
  symbol → `UNKNOWN_SYMBOL` → `⚠️ این نماد پشتیبانی نمیشود.`), and `AlertService.create` validates it
  again in the domain layer, so a hand-crafted callback cannot bypass the wizard (§22).
* Malformed callback ids (`v1:alert:sym:not a symbol`, unsafe alert ids) are rejected by the pure
  callback grammar before any service call; the grammar checks shape, the registry decides support — both
  behaviours are pinned by tests.

## 13. Market Integration, Invalid Data and Staleness

* The listener receives the prices Phase 1 has already accepted and committed. Data rejected by Phase 1
  (`INVALID_SCHEMA`, `MISSING_SYMBOL`, `UNKNOWN_SYMBOL`, `INVALID_NUMBER`, `INVALID_PRICE`,
  `OUT_OF_RANGE`, `EXCESSIVE_CHANGE`) is never delivered to the alert engine, so it cannot evaluate or
  trigger anything (§49, §50) — covered by a dedicated engine-integration test that feeds an anomalous
  cycle and asserts zero reservations.
* Freshness uses the existing Phase 1 staleness semantics; Phase 3 adds no second staleness rule. A stale
  state cannot serve as a percentage baseline, and evaluation only ever runs on freshly committed
  observations (§51).
* Alerts query by symbol: `listActiveForSymbol(symbol)` is served from the `activeBySymbol` index, so a
  tick evaluates only the ACTIVE alerts of the updated symbol (§57).
* There is no second market polling mechanism: with BOT polling disabled the bot still publishes on its
  cron, and alerts fire from the same cycle.

## 14. Evaluator and Trigger Reasons (STEP 2, §54–§56)

* `evaluateAlert(alert, observation)` is a pure function: it reads nothing, writes nothing, sends
  nothing, logs nothing, mutates no user, and produces a deterministic `AlertEvaluationResult`
  (31 unit tests, including all four "no new trigger" cases of §73/§74 and the threshold/value cases of
  §75).
* Machine-readable reasons: `PRICE_ABOVE_REACHED`, `PRICE_BELOW_REACHED`, `PERCENT_INCREASE_REACHED`,
  `PERCENT_DECREASE_REACHED`, plus the non-trigger reasons (condition not crossed, invalid data,
  not active). The notification text is derived from the reason, not from string matching.
* The evaluator also explains *why not* (e.g. already beyond the target), which is what the wizard uses to
  describe the "already true" case, and what the tests assert instead of "no crash".
* Side effects live in `AlertEngineService` (listener orchestration), `AlertService` (state) and
  `AlertNotificationService` (delivery), each of which is independently tested.

## 15. Notification Architecture and Idempotency

* Delivery uses the existing abstraction only: `PlatformRegistry.resolve(platform)` → adapter →
  `sendMessage` through `BotApiClient`. There is no direct `fetch`/HTTP call to Telegram or Bale anywhere
  in the alert code (§41), and both platforms are covered by tests (Bale end-to-end, Telegram in the
  notification spec with both credentials set).
* Exactly one delivery record per alert id (enforced by construction in the store), created inside the
  same `transact()` that flips the alert to `TRIGGERED` — the trigger and its delivery can never diverge
  (§42, §43, §44).
* Idempotency: `reserveTrigger(alertId, observation)` succeeds only while the alert is `ACTIVE`. Replaying
  the same committed event returns "not reserved" the second time, a second engine instance over the same
  store cannot reserve again, and a restarted process sees `TRIGGERED` and never re-notifies (§43, §61).
  Tests cover the same-event-twice case (`1` then `0` reservations), the restart case (no second
  `sendMessage`) and the concurrent-reservation case.
* The notification is purely informational (§48): symbol, current price, condition, baseline/approximate
  target for percentage alerts, timestamp, and the closing line
  `ℹ️ این هشدار یکبار اجرا شد و غیرفعال شده است.` — no advice, no recommendation, no prediction. The
  closing line doubles as the machine-readable marker used by tests and by the runtime transcript.

## 16. Retry Policy and Delivery States

| Delivery state | Meaning |
| --- | --- |
| `PENDING` | reserved, not yet successfully delivered |
| `SENT` | the platform accepted the message (exactly one success per alert) |
| `FAILED` | the bounded attempts are exhausted, or delivery became impossible |

* Attempts = `ALERT_NOTIFICATION_MAX_RETRIES` (default 3) beyond the first, separated by
  `ALERT_NOTIFICATION_RETRY_DELAY_MS` (default 5000 ms, `0` allowed for tests/ops). Each attempt updates
  `attemptCount`, `lastAttemptAt`, `lastError`; a success clears `lastError` and stamps `sentAt`.
* No infinite retry and no flood: retries happen only for that alert's delivery; market updates cannot
  re-trigger it (the alert is `TRIGGERED`), and a retry never creates a second delivery record.
* A restart with `PENDING` + `attemptCount > 0` + `lastError === null` (i.e. the process died between
  "sent" and "recorded") is deliberately **not** re-sent — it is marked `FAILED` with
  `skippedReason = DELIVERY_OUTCOME_UNKNOWN`, because at-most-once delivery is chosen over the risk of a
  duplicate message for a one-shot alert. This is a conscious, tested, documented trade-off.
* Deleting or disabling an alert before delivery prevents the message
  (`skippedReason = ALERT_DELETED` / `ALERT_DISABLED`); a delivery that was already sent is never
  "un-sent", and the alert's `TRIGGERED` state is separate from the delivery outcome (§45) — a failed
  delivery keeps `TRIGGERED` and records the failure, so operators can see both facts.

## 17. Concurrency and Race Handling

All mutations run inside `AlertStore.transact()` (single serialized chain), so the following are
deterministic and test-covered (§58–§60):

| Race | Behaviour |
| --- | --- |
| Two creates at the limit | the second sees the updated count inside the transaction and is refused with the Persian limit message — the limit cannot be bypassed |
| Double-clicked confirm / repeated callback / retried request | an idempotency key derived from the wizard state blocks the duplicate; distinctly different alerts (e.g. `≥ 17,500,000` and `≥ 18,000,000`) are unaffected |
| Two enables | the second is a no-op on an already-`ACTIVE` alert (no double baseline refresh, no state corruption) |
| Delete + trigger | the reservation re-checks status inside the transaction; a deleted alert is never reserved, and a delivery that finds a deleted alert is skipped instead of sent |
| Disable + trigger | same mechanism: disable wins if it committed first, and no notification is produced after a successful disable |
| Evaluation + evaluation | `reserveTrigger` transitions `ACTIVE → TRIGGERED` atomically, so only one of two concurrent evaluations can reserve |
| Retry + evaluation | the retry path only touches an existing delivery; it cannot produce a new trigger |
| Restart during a retry | the delivery state is re-read from disk; no duplicate attempt for a delivery already marked `SENT` |

## 18. Restart Recovery and Ordering

* Alerts and deliveries are persisted on every mutation, so after a restart: `ACTIVE` stays `ACTIVE`,
  `DISABLED` stays `DISABLED`, `TRIGGERED` stays `TRIGGERED` (never re-notified), `DELETED` stays deleted.
* The runtime regression proves it against the real scheduler: created `ACTIVE` → triggered `TRIGGERED`
  with delivery `SENT` → process restarted → the alert still shows `✅ فعال شده` in `🔔 هشدارهای من` and
  the notification count on the wire stayed exactly 1 (see `phase3-runtime-transcript.md`).
* Wizard state: in-memory, scoped per user, TTL `ALERT_WIZARD_TTL_MINUTES` (default 15), and it is
  intentionally not persisted — a restart abandons a half-finished wizard, exactly as §69 allows, while
  alert data survives. It never leaks between users (keyed by user id) and `/menu` abandons it.
* Ordering (§62): alerts use the Phase 1 ordering information that exists (`previousPrice` of the
  committed observation plus the commit timestamp). Phase 1 does not provide a monotonic sequence for
  provider timestamps, so Phase 3 does not invent one: a provider-side out-of-order price that Phase 1
  accepts and commits is treated as the next observation. This is documented in the README limitations
  section rather than papered over with a fake guarantee.

## 19. Limits and Duplicate Prevention

* `MAX_ALERTS_PER_USER` is read once into configuration (default 5, allowed 1–100) — the number 5 appears
  in configuration and tests only, never as a scattered literal (§35, §89).
* Capacity counts `ACTIVE` + `DISABLED`; `TRIGGERED` and `DELETED` release capacity (§36) — the runtime
  transcript shows a triggered alert no longer counting (`۱ از ۵` with the alert in `✅ فعال شده`).
* Enforcement is atomic: the count and the insert happen in the same `transact()`, so two simultaneous
  creations cannot both pass the check (§37) — pinned by a concurrency test.
* Duplicate prevention targets accidental duplicates only: the same wizard confirmation cannot create two
  identical alerts (double-click, repeated callback, retried request, concurrent identical create), while
  distinct targets on the same symbol remain allowed (§38).
* User-facing limit message: `⚠️ به حداکثر تعداد هشدار مجاز رسیدهاید.` plus the Persian hint to delete or
  disable one first, with the configured number rendered from configuration (§71).

## 20. Bot UX (Screens, Wizard, Messages)

* Hub `🔔 هشدار قیمت`: `➕ ساخت هشدار` · `🔔 هشدارهای من` · `⬅️ بازگشت` · `🏠 منوی اصلی` — built on the
  Phase 2 keyboard/navigation helpers, with no second navigation system (§23).
* Create wizard: symbol (registry-backed, `🟡 طلای ۱۸` style labels) → type
  (`📈 رسیدن به قیمت بالاتر`, `📉 افت به قیمت پایینتر`, `📈 افزایش درصدی`, `📉 کاهش درصدی`) → numeric input
  → validation → summary (`🔔 تأیید هشدار` with symbol, condition, current price, status, and for
  percentage alerts the baseline and approximate target) → `✅ تأیید` / `❌ لغو` → `✅ هشدار با موفقیت
  ایجاد شد.` (§24–§32).
* Numeric input is parsed by a strict single-value parser (`number-input.ts`): Persian/Arabic-Indic and
  Latin digits, thousand separators only in valid groups of three, one decimal separator, no trailing or
  embedded junk, no ambiguity between grouping and decimals — an unparseable answer keeps the wizard open
  with a retry prompt (§27, §29).
* `🔔 هشدارهای من` lists only the caller's alerts, newest first, with symbol, condition and a status
  badge (`🟢 فعال`, `🔕 غیرفعال`, `✅ فعال شده`) plus the capacity line (§39).
* Alert detail shows symbol, condition, target, status, baseline (percentage alerts), creation time and
  trigger time when triggered, and offers exactly the status-appropriate actions: ACTIVE →
  `🔕 غیرفعال` `✏️ ویرایش` `🗑 حذف`; DISABLED → `🔔 فعال کردن` `✏️ ویرایش` `🗑 حذف`; TRIGGERED → `🗑 حذف`
  (§40).
* Delete requires an explicit confirmation step (`🗑 حذف` → `✅ حذف` / `❌ لغو`) and performs the soft
  delete (§18, §70).
* Edit changes the target only (changing symbol or type means creating a new alert — documented), is
  atomic, validates the new value first, and refreshes the percentage baseline to the current fresh price
  (§17).
* All user-visible texts are Persian, HTML-escaped where they carry markup, and every action ends in an
  acknowledged, edited screen (no dangling "loading" states); event logging records screen-level
  navigation without personal data.

## 21. Validation and Error Handling

| Input | Handling |
| --- | --- |
| `null`, `undefined`, `NaN`, `±Infinity` | rejected by the domain guard before any state change |
| malformed numeric text | rejected by the strict parser with `⚠️ مقدار واردشده معتبر نیست.` |
| zero/negative price target | rejected (`قیمت هدف باید عددی بزرگتر از صفر باشد.`) |
| price outside the symbol's Phase 1 acceptance range | rejected (`INVALID_TARGET`) because such a price can never be accepted by Phase 1 |
| percentage outside `ALERT_MIN_TARGET_PERCENT..ALERT_MAX_TARGET_PERCENT` | rejected with the configured bounds in the message |
| unknown / unsupported symbol | rejected with `⚠️ این نماد پشتیبانی نمیشود.` |
| malformed callback data | answered with the Phase 2 "expired option" screen, never a crash |
| foreign / unknown alert id | `این هشدار قابل استفاده نیست.` |
| action invalid for the current status | refused with `INVALID_STATE` and a Persian explanation |
| missing fresh valid price for a percentage baseline | refused with `⚠️ قیمت معتبر این نماد در دسترس نیست.` |
| platform temporarily unavailable | delivery recorded as `FAILED`; internal reason kept in logs, user sees nothing technical |

No stack trace, SQL/axios error, enum name, file path or credential ever reaches the user; logs use the
Phase 1/2 `describeError` helper and never contain bot tokens or request headers (§64).

## 22. Configuration (new environment variables)

| Variable | Purpose | Default | Range |
| --- | --- | --- | --- |
| `ALERTS_DATA_FILE` | persistence file for alerts + deliveries (empty disables persistence) | `./data/alerts.json` | path or empty |
| `MAX_ALERTS_PER_USER` | capacity per user; `ACTIVE` + `DISABLED` count | `5` | 1–100 |
| `ALERT_NOTIFICATION_MAX_RETRIES` | extra delivery attempts after the first (`0` = no retries) | `3` | 0–10 |
| `ALERT_NOTIFICATION_RETRY_DELAY_MS` | delay between attempts | `5000` | 0–600000 |
| `ALERT_MIN_TARGET_PERCENT` | smallest accepted percentage magnitude | `0.01` | > 0, ≤ max |
| `ALERT_MAX_TARGET_PERCENT` | largest accepted percentage magnitude | `100` | ≥ min |
| `ALERT_WIZARD_TTL_MINUTES` | how long a half-finished wizard waits for the numeric answer | `15` | 1–10080 |

All are validated by `env.validation.ts` (fail-fast, Persian-free technical messages), documented in
`.env.example` next to the Phase 0–2 variables, and centralised in `AppConfigService` getters — no policy
value is hard-coded at a call site (§89). Percentage bounds exist for safety and are a documented default,
not an invented business rule (§90); the retry variables use a non-negative reader so an explicit `0` is
honoured instead of silently falling back to the default.

## 23. Tests, Coverage and Verification (STEP 4, §72–§87, §99)

### 23.1 Required commands (actually executed on the frozen tree)

| Command | Result |
| --- | --- |
| `npm ci` | PASS |
| `npm run build` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npx jest` / `npm test` | **39 suites / 571 tests PASS** |
| `npm run test:e2e` | **3 suites / 18 tests PASS** |
| `docker build .` | PASS (image `atabak-gold-p3`, `sha256:7135e90bcbde…`) |
| Runtime regression (real process + real wire + real cron) | PASS — see `phase3-runtime-transcript.md` |

Phase 2 baseline was 32 suites / 352 tests; Phase 3 adds **+7 suites / +219 tests** (unit, after
removing two duplicated integration cases) and **+1 e2e suite / +9 e2e tests**.

### 23.2 Unit / integration test inventory

| Suite | Tests | Focus |
| --- | --- | --- |
| `src/alerts/alert-evaluator.spec.ts` | 31 | §73–§75: above/below crossing, equality, gaps, "already true", percent up/down below/at/above the threshold, `baseline = 0`, invalid baseline |
| `src/alerts/alert.store.spec.ts` | 13 | atomic persistence, indexes, corruption tolerance, one delivery per alert |
| `src/alerts/alert.service.spec.ts` | 51 | creation, validation (§76), ownership (§77), limits (§78), duplicates (§79), lifecycle, edit, enable/disable, soft delete, trigger reservation |
| `src/alerts/alert-notification.spec.ts` | 16 | delivery states (§83), bounded retry, no infinite retry, `PENDING/OUTCOME_UNKNOWN` restart policy, Bale **and** Telegram adapters, unconfigured platform |
| `src/alerts/alert-engine.integration.spec.ts` | 18 | listener → evaluation → reservation; rejected/anomalous data (§85); disabled/deleted alerts (§80, §81); one-shot after triggering (§82); second engine instance |
| `src/bot/ux/alert-flow.integration.spec.ts` | 35 | end-to-end UX flow over the real router: navigation, wizard, confirmation, already-true confirmation, list/detail, status-dependent actions, stale/expired callbacks, delivery-state screens (two earlier duplicated navigation cases were merged away — every distinct assertion kept) |
| `src/bot/ux/number-input.spec.ts` | 39 | strict numeric parser (§27, §29) |
| `src/bot/ux/callback-data.spec.ts` | 27 | alert callback grammar + alert-id safety |
| `src/market/market-engine.integration.spec.ts` | 16 | Phase 1 regression + 4 listener tests (accepted-only, isolation from listener failures) |
| `src/bot/ux/ux-format.spec.ts` | 24 | presentation regression after removing the Phase 2 placeholder |
| `test/alert-journey.e2e-spec.ts` | 9 | §87 journeys through the real bot service: create → trigger → My Alerts → triggered detail; **create → disable → market crosses → no notification (then re-enable → new crossing → exactly one)**; **create → delete → market crosses → no notification (and the quota is freed)**; **create → restart → still ACTIVE → triggers normally**; triggered alert one-shot across a restart; delivery failure/recovery; rejected price; capacity |

§80 (disable → no notification), §81 (delete → no notification), §82 (trigger → exactly one
notification), §83 (failure → bounded retry, deterministic final state), §84 (restart) and §85 (invalid
market data) each have a dedicated test asserting the *absence* of a notification where required, not
only the presence of state changes.

### 23.3 Coverage (fresh `npm run test:cov` on the frozen tree)

| Scope | Statements | Branches | Functions |
| --- | --- | --- | --- |
| Overall | 93.07% (2806/3015) | 83.51% (1767/2116) | 94.86% (572/603) |
| `src/alerts` (module) | 93.89% | 80.38% | 92.41% |
| `alert.service.ts` | 94.54% | 90.21% | 100% |
| `alert.store.ts` | 94.29% | 89.06% | 90% |
| `alert-evaluator.ts` | 93.33% | 94.34% | 100% |
| `alert-notification.service.ts` | 91.76% | 73.13% | 69.23% |
| `alert-engine.service.ts` | 93.48% | 75.76% | 100% |
| `alert-format.ts` | 93.52% | 56.36% | 90.48% |
| `bot-ux.service.ts` | 93.55% | 84.18% | 100% |
| `number-input.ts` | 97.06% | 95.83% | 100% |

Uncovered lines are the defensive branches that tests deliberately drive through their *public*
behaviour (file-write failure logs, unreachable `default:` arms, platform error strings) plus a few
formatting fallbacks; no untested business rule remains.

### 23.4 Runtime regression (real process, real scheduler, mocked platform wire)

Full transcript: [`/home/user/phase3-runtime-transcript.md`](../phase3-runtime-transcript.md)

1. The create-alert wizard was driven through the real `getUpdates` long-poll path: `🔔 هشدار قیمت` →
   symbol → `📈 رسیدن به قیمت بالاتر` → `17800000` → `🔔 تأیید هشدار` → `✅ تأیید` →
   `✅ هشدار با موفقیت ایجاد شد`, `🔔 هشدارهای من` shows `1️⃣ طلای ۱۸ عیار ≥ ۱۷٬۸۰۰٬۰۰۰ ریال 🟢 فعال`,
   persisted `status = ACTIVE`. **Re-run on the final tree (2026-10-12)** with the alert created below
   its target, so the trigger could only come from a real crossing.
2. The mock provider then served `17,900,000` and the application's **own half-hourly cron** (19:30
   Tehran) ran the Phase 1 pipeline, committed the price and triggered the alert:
   `16:00:00.017Z TRIGGERED` → `16:00:00.033Z sendMessage (chat 7001)` → `16:00:00.034Z SENT`,
   `attemptCount = 1`, exactly **one** notification on the wire, with the §48 content.
3. The trigger arrived from the application's **own 19:30 Tehran cron** (2026-09-30) / **18:00 Tehran
   cron** (2026-10-12, gap crossing `17,620,000 → 17,900,000` over the `17,800,000` target, 10 ms after
   the market commit) — one notification, delivery `SENT`, `attemptCount = 1`, and exactly **one**
   external provider fetch for the whole run.
4. The process was restarted with the same data: `TRIGGERED` + `SENT` survived, the list screen showed
   `✅ فعال شده`, and the notification count stayed **1 → 1** (2026-09-30) / **2 → 2** (2026-10-12, where
   the two counts are one alert per platform identity — same numeric id on Bale and Telegram, each
   delivered exactly once through its own adapter, no re-send after the restart).

The same three properties are also asserted as automated e2e journeys (`test/alert-journey.e2e-spec.ts`):
a *disabled* alert never notifies while the market crosses it twice and only fires after a fresh
re-enable crossing; a *deleted* alert never notifies and releases its quota; and an `ACTIVE` alert
survives a process restart (new module graph over the same files) and then triggers and delivers
normally in the new process.

### 23.5 Regression of earlier phases (§86)

All Phase 0/1/2 suites still pass unchanged in meaning: market reliability, anomaly rejection, market
state, daily statistics, publishing, bot navigation, favourites, user persistence, Telegram and Bale
behaviour. The only Phase 2 test edit was the replacement of the "alerts is a placeholder" assertions
with assertions about the real hub, plus additive cases; `ux-format.ts` lost a dead placeholder formatter
that nothing referenced anymore.

## 24. Definition of Done and Phase 4 Readiness

| # | Criterion (§97) | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | User can create an alert through the wizard (symbol → type → target → confirm) | PASS | alert-flow spec, e2e, runtime transcript |
| 2 | Only registry symbols and supported types are accepted | PASS | `callback-data.spec.ts`, `alert.service.spec.ts`, `alert-flow.integration.spec.ts` |
| 3 | Only valid targets are accepted; malformed/zero/negative/out-of-range rejected | PASS | `alert.service.spec.ts` (§76), `number-input.spec.ts` |
| 4 | Confirmation is required before persistence; duplicates are prevented | PASS | `alert-flow.integration.spec.ts`, `alert.service.spec.ts` (§79) |
| 5 | Only valid market data is evaluated | PASS | `alert-engine.integration.spec.ts` (§85) |
| 6 | Correct crossing behaviour (including gaps and equality) | PASS | `alert-evaluator.spec.ts` (§73–§75) |
| 7 | Percentage baseline correct, fixed and refreshed only on explicit edit/re-enable | PASS | `alert.service.spec.ts`, `alert-flow.integration.spec.ts` |
| 8 | Invalid prices can never trigger | PASS | evaluator + engine-integration tests |
| 9 | Disabled/deleted/triggered alerts cannot trigger | PASS | `alert-engine.integration.spec.ts` + e2e journeys (disable → cross ×2 → 0 messages; delete → cross ×3 → 0 messages; triggered → 1 only) |
| 10 | List, detail, enable, disable, edit, delete all work and are status-aware | PASS | `alert-flow.integration.spec.ts`, runtime transcript |
| 11 | Exactly one notification per trigger (idempotent across retries and restarts) | PASS | notification + engine specs, runtime transcript (1 → 1 after restart) |
| 12 | Delivery result is tracked separately from the alert status | PASS | `alert-notification.spec.ts` |
| 13 | Retry is bounded and configurable; no infinite retry or flood | PASS | `alert-notification.spec.ts` |
| 14 | State survives restarts (alerts and deliveries) | PASS | store specs + runtime restart round |
| 15 | Users remain isolated (list/detail/actions/trigger access) | PASS | `alert.service.spec.ts` (§77), `alert-flow.integration.spec.ts` |
| 16 | `MAX_ALERTS_PER_USER` configurable, enforced atomically, counting policy consistent | PASS | `alert.service.spec.ts` (§78), `.env.example` |
| 17 | Ownership and status validated server-side; no trust in callbacks | PASS | service guards + router specs |
| 18 | Persian UX, no technical leakage, informational-only notification content | PASS | formatter specs, runtime transcript |
| 19 | No magic numbers; all policy values centralised and documented | PASS | `app-config.service.ts`, `.env.example`, README |
| 20 | No Phase 1 bypass, no duplicate market source, no new infrastructure/dependency | PASS | architecture in section 3; `package.json` unchanged |
| 21 | No out-of-scope features implemented (no AI/portfolio/payments/…, no future phase) | PASS | scope review in STEP 5; no such code path exists |
| 22 | `npm ci` / `npm run build` / `npm run lint` | PASS | section 23.1 |
| 23 | `npx jest` (39 suites / 571) and `npm run test:e2e` (3 suites / 18) | PASS | section 23.1 |
| 24 | `docker build` | PASS | `atabak-gold-p3`, sha256 `7135e90bcbde…` |
| 25 | Commit created on `708434e` (base tree `47083255`) | PASS | single Phase 3 commit; its exact SHA/tree are in the `phase3-atabak-gold.patch` header and the hand-off message |
| 26 | Push to origin | **BLOCKED** | no credentials in this environment; `phase3-atabak-gold.patch` + `.bundle` (and the all-phases patch/bundle) delivered |

**Known limitations (documented in the README, not hidden):** crossing needs a previous accepted
observation, so the first accepted price of a new Tehran day cannot itself establish a crossing; state is
process-local with a single JSON file, so multiple simultaneous instances are not supported (same as
Phases 1–2); notification delivery targets the chat the user last interacted from and falls back to the
platform user id; editing changes the target only; the `0`-value acceptance of the two retry variables is
verified at configuration level but not re-asserted through `env.validation.ts`'s own integer reader.

**STEP 5 review outcome:** the final diff was reviewed for unrelated changes (only the alert path and its
tests, config and docs), duplicated logic (the earlier duplicate test blocks and the dead placeholder
formatter were removed), dead code (unused exports dropped), secrets (`.env` stays git-ignored; no token
is logged), magic numbers (all moved to configuration), missing validation/ownership (both layers
covered), races (section 17), duplicate notifications (section 15) and Phase 1 bypasses (section 13).
Defects found and fixed by the tests during implementation (and in the final review): the wizard's generic
retry for an unfixable numeric answer, the retry configuration silently ignoring `0`, the notification
attempt being consumed before the platform adapter was resolved, the capacity message advising an action
(disabling) that does not actually free quota, a duplicated navigation block in the alert-flow spec, and —
exposed by the frozen Phase 1 suite after the environment date rolled over — a **date-dependent Phase 1
restart test** that hard-coded the Tehran day and therefore only passed on one calendar date; it now
derives the current day from the project's own `tehranDayKey` helper, so the whole suite is
date-independent.

All Phase 3 requirements are implemented, verified and green; the only non-pass is the environment-bound
`git push`.

**PHASE 3 COMPLETE — READY FOR PHASE 4**

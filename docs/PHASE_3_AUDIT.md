# PHASE 3 — Repository Audit & Design (Price Alert)

Date: 2026-09-30 · Branch `main` · Base: the Phase 2 commit (Phases 0–2 delivered, local only)
Scope: implement the Price Alert system **without** touching Phase 1 logic or redesigning Phase 2 UX.

---

## 1. What already exists (inspected before any change)

| Area | Found | Reusable for Phase 3 |
| --- | --- | --- |
| Market pipeline | `MarketEngineService.evaluateCycle()` — parser → normalizer → sanity/anomaly → `MarketStateService.commit()` → change calc → daily stats → publish/reject. Rejected prices never reach `commit`. | **The only price source.** Alert evaluation must hook the committed, accepted prices. |
| Market state | `MarketStateService`: per-symbol `currentPrice`, `previousPrice`, `lastValidPrice`, `updatedAt`, `lastSuccessfulUpdate`, `daily`, `freshness`, `ageMs`; `getState/getLastValidPrice/getSameDayPrice`. | Current price + freshness for baselines; `previousPrice`/evaluation baseline for crossing. |
| Publication | `BotService` cron → `evaluateCycle` → channel message. | Untouched. |
| Users | `src/users`: `User {id, platform, platformUserId, createdAt, updatedAt}`, `UserStore` (atomic JSON, serialized writes, tolerant load), `UserService` (registry validation, limits, per-user scoping). | Reused as the **only** user system; extended with the last known `chatId` so notifications can be delivered to the right chat. |
| Bot UX | `src/bot/ux`: `callback-data` (v1 grammar + validation), `BotUxService` (router + in-memory sessions + safe invalid-callback screen), `ux-format` (all Persian text), `ux-keyboards`, `MarketViewService` (read-only projection), `UxEventLogService`. | Extended with the alert flows; navigation, sessions, formatting and markup guards are reused, not duplicated. |
| Platform | `src/platform`: `BotApiClient` (single HTTP layer), `PlatformAdapter.render()` (edit-in-place + send fallback), `PlatformRegistry` (Bale always, Telegram when configured). | The notification channel: alerts send through the adapter, never through a raw API call. |
| Config | `env.validation` + `AppConfigService` typed getters, `.env.example`, README. | Extended with the Phase 3 variables. |
| Persistence tech | Atomic JSON (`tmp` + `rename`), serialized write chain, tolerant load (`market-state.store.ts`, `user.store.ts`). | Reused for alerts/deliveries: **no new database, no Redis/queue** — the project has no relational DB and the spec allows the smallest safe solution (§66/§93). |
| Tests | 32 suites / 352 unit+integration, 9 e2e, `test-doubles.ts` harnesses (`createUxHarness`, `createMarketHarness`, `createPlatformHarness`, `seedMarketState`). | Extended with an alert harness; all existing suites must stay green. |

**Not present (so not reused):** ORM/DB/migrations, notification engine, scheduler other than cron, any alert concept.

## 2. Key constraints discovered

* `MarketStateService.commit()` sets `previousPrice` only for same-day comparisons; on the first accepted
  price of a new Tehran day it is `null`, while the sanity layer still reports the observation baseline it
  used (`evaluation.previousPrice` + `baseline: 'SAME_DAY' | 'PREVIOUS_DAY'`). Crossing detection therefore
  uses **the Phase 1 evaluation** (the observation that immediately precedes this accepted price), never an
  alert-owned price history (§52).
* Rejected/anomalous prices never reach `commit()`, so the alert hook physically cannot be called for them
  (§50) — this is enforced by position, and covered by a regression test.
* The JSON stores are single-writer per process; determinism is achieved by a serialized write chain. There
  is no cross-process concurrency (single container deployment), so alert limits/trigger reservation use the
  same critical-section mechanism instead of a distributed lock (§37 allows the safest practical strategy).

## 3. Design (decided before coding)

### 3.1 Components (new module `src/alerts/`)

| File | Responsibility |
| --- | --- |
| `alert.types.ts` | Domain model + enums (`AlertType`, `PercentDirection`, `AlertStatus`, `DeliveryStatus`, `TriggerReason`), `Alert`, `AlertDelivery`, `AlertEvaluationResult`, persisted document shape. |
| `alert.store.ts` | Persistence + indexes (`symbol → ACTIVE alert ids`, `userId → alert ids`), atomic writes, serialized mutations. |
| `alert.service.ts` | Domain rules: validation, ownership, capacity, duplicate prevention, CRUD/state transitions, trigger reservation, delivery bookkeeping. |
| `alert-evaluator.ts` | **Pure** condition evaluation (crossing for absolute alerts, fixed-baseline percentage for percent alerts). No I/O. |
| `alert-engine.service.ts` | Integration point: registered as a market-update listener; orchestrates evaluate → reserve → dispatch; boot recovery of pending deliveries. |
| `alert-notification.service.ts` | Delivery through `PlatformAdapter`, bounded retries, delivery-state persistence, pre-send eligibility re-check. |
| `alert-format.ts` | Persian presentation for alerts (list/detail/confirm/summary + notification bodies) using the central money/price utilities. |

### 3.2 Data model (Phase 3 §33/§34)

```
Alert        { id, userId, platform, symbol, type, status,
               targetPrice | null, targetPercent | null, direction | null,
               baselinePrice | null, createdAt, updatedAt,
               triggeredAt | null, disabledAt | null, deletedAt | null }
AlertDelivery{ id, alertId, userId, platform, chatId, reason, status,
               triggerPrice, triggerPercent, triggeredAt,
               attemptCount, lastAttemptAt, sentAt, lastError, skippedReason }
```

* `targetPercent` is a positive magnitude; the signed comparison uses `direction` (UP/DOWN).
* Capacity policy (frozen): **ACTIVE + DISABLED count**, TRIGGERED and DELETED do not.
* Soft delete (`status = DELETED` + `deletedAt`), never removed from the file.

### 3.3 Trigger & idempotency

* One delivery record per trigger, created **inside the same critical section** that flips the alert to
  `TRIGGERED`; a second evaluation can never find the alert `ACTIVE`, so a duplicate record is impossible.
* Before every send attempt the dispatcher re-checks `alert.status === 'TRIGGERED'` (delete/disable wins,
  §59/§60), then persists `attemptCount + 1` **before** calling the platform.
* Bounded retries (`ALERT_NOTIFICATION_MAX_RETRIES`, `ALERT_NOTIFICATION_RETRY_DELAY_MS`); after the last
  attempt the delivery becomes `FAILED` and is logged. Recovery on boot resumes `PENDING` deliveries whose
  last attempt is known to have failed; a delivery whose send outcome is unknown (persisted attempt with no
  recorded error) is **not** resent and is recorded as failed, because duplicate notifications are the
  harder invariant to violate.

### 3.4 Evaluation rules

* `PRICE_ABOVE`: trigger when `previous < target && current >= target`.
* `PRICE_BELOW`: trigger when `previous > target && current <= target`.
* `PERCENT_CHANGE UP`: `((current - baseline) / baseline) * 100 >= targetPercent` (unrounded).
* `PERCENT_CHANGE DOWN`: `... <= -targetPercent`.
* Only `ACTIVE` alerts of the updated symbol are evaluated; a missing previous observation cannot produce a
  trigger (§62 limitation documented, not faked).
* Evaluation happens **after** the accepted prices were committed to market state.

### 3.5 UX (reuses Phase 2 patterns)

`🔔 هشدار` → screen with `➕ ساخت هشدار`, `🔔 هشدارهای من`; wizard (symbol → type → target → confirmation) with
in-memory session state (TTL, per user), text input parsed by a strict Persian/Latin number parser, alert list
→ detail → enable/disable/edit/delete (delete asks for confirmation), and every callback validated
server-side (alert id format + ownership + action allowed for the current status).

### 3.6 Configuration (grouped, documented, no magic numbers)

`ALERTS_DATA_FILE`, `MAX_ALERTS_PER_USER`, `ALERT_NOTIFICATION_MAX_RETRIES`,
`ALERT_NOTIFICATION_RETRY_DELAY_MS`, `ALERT_MIN_TARGET_PERCENT`, `ALERT_MAX_TARGET_PERCENT`,
`ALERT_WIZARD_TTL_MINUTES`. Price targets are validated against the **Phase 1 registry ranges** of the symbol
(no new policy invented; a target outside the accepted data range could never be crossed).

### 3.7 What will NOT be touched

Phase 1 pipeline internals (parser/normalizer/sanity/daily stats/publisher), Phase 2 screens, favorites,
channel publication, schedules. The only Phase 1 edit is a minimal, additive listener hook in
`MarketEngineService` (register/notify) — no behaviour change for existing callers.

## 4. As-built deltas (recorded after implementation)

Everything in §3 was implemented as designed. The following points were discovered **while** implementing
and testing, and are part of the delivered behaviour:

| Point | What changed and why |
| --- | --- |
| Alert type | `PERCENT_CHANGE` + `direction` was split into two explicit types (`PERCENT_INCREASE` / `PERCENT_DECREASE`) so an alert can never be ambiguous about its direction, while the stored `targetPercent` stays a positive magnitude. |
| Evaluator hardening | The pure evaluator also refuses a **non-positive** stored percentage target (a corrupt record must never fire) in addition to `NaN`/`±Infinity`/non-positive baseline. Found by the matrix tests. |
| Store critical section | The first implementation chained the write *inside* the transaction link, which made the very first transaction wait for itself (deadlock, found by `alert.store.spec.ts`). Fixed: the link awaits the load, applies the synchronous operation and then writes — one chain hop per transaction, FIFO order guaranteed by queuing synchronously. |
| Config semantics | `ALERT_NOTIFICATION_MAX_RETRIES=0` / `ALERT_NOTIFICATION_RETRY_DELAY_MS=0` are meaningful values ("no retry", "immediately") and must not fall back to the default, so those two getters use a dedicated non-negative integer reader (found by the retry tests). |
| Attempt accounting | The platform adapter is resolved **before** an attempt is counted, so an unconfigured platform is recorded as a configuration failure (`attemptCount = 0`) instead of consuming a delivery attempt. |
| Wizard retry wording | A refused number re-asks for the value; a failure that another number cannot fix (no usable price, unsupported symbol) closes the wizard with the reason-specific Persian message instead of looping the user. |
| Number input strictness | Ambiguous grouping (`1,2,3`, `12,34`) is rejected instead of guessed, and Persian/Arabic-Indic digits are normalized by the shared `money.ts` helper (single implementation). |
| Listener contract | `MarketUpdateListener.onMarketPricesCommitted` is async and awaited by the engine, but each listener is isolated with try/catch: a failing alert layer can never break price publication. Notification *delivery* (with retries) is intentionally decoupled from the market cycle. |
| Phase 2 placeholder | `formatAlertsPlaceholder` (and its test) was removed: the `🔔 هشدار` section is now the real hub, and two Phase 2 tests that asserted the placeholder were updated to assert the hub. |

## 5. Post-review fixes (final review pass)

After the first full green run the diff was reviewed once more against the specification; these are the
resulting changes — all covered by tests and re-verified end to end:

| # | Finding | Fix |
| --- | --- | --- |
| 1 | The wizard message after a *refused numeric answer* was generic, so a stale/absent price looked like a typo (§29/§63). | `consumeWizardInput` is reason-aware: `INVALID_TARGET` re-asks, `NO_VALID_PRICE` / `UNKNOWN_SYMBOL` close the wizard with the reason-specific Persian message and a cancel keyboard. |
| 2 | `ALERT_NOTIFICATION_MAX_RETRIES=0` silently fell back to 3 (§47/§89: policy values must be honoured). | Dedicated non-negative reader for both retry getters. |
| 3 | A delivery attempt was consumed before the platform adapter was resolved (§42). | Adapter resolved first; an unconfigured platform is recorded as `FAILED` with `attemptCount = 0`. |
| 4 | The capacity message advised deleting *or* disabling (§71), but under the frozen policy (`ACTIVE + DISABLED` count) only deletion frees quota. | Message now says deletion is required and states explicitly that a disabled alert still occupies quota. |
| 5 | Two duplicated navigation cases had accumulated in `alert-flow.integration.spec.ts` (same title, overlapping assertions). | The two blocks were merged into one describe; every distinct assertion was kept (37 → 35 tests, none weakened). |
| 6 | `market-state.service.spec.ts` hard-coded the Tehran day for the restart test, so it passed only on the calendar date it was written (§86/determinism). | The test derives the current day from the project's own `tehranDayKey` helper — the whole suite is now date-independent. Discovered when the sandbox clock rolled over to a new day. |
| 7 | §87 asked for e2e journeys "Create → Disable → market reaches target → no notification" and "Create → Delete → market reaches target → no notification", and §84 for "create → restart → still ACTIVE → triggers normally"; only unit/integration level covered them. | Three e2e journeys added to `test/alert-journey.e2e-spec.ts` (disable + re-enable semantics, delete + quota release, restart-then-trigger), all passing. |
| 8 | `docker-compose.yml` described the data volume as market-state only (§91/§94 documentation accuracy). | Comment now names all three files that live there (`MARKET_STATE_FILE`, `USER_DATA_FILE`, `ALERTS_DATA_FILE`). |

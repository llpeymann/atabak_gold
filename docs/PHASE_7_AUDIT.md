# PHASE 7 — AUDIT (GROWTH ENGINE: REFERRALS & REWARDS)

Audit of the **real repository state** before any Phase 7 code was written, per §3 of the phase
specification ("inspect the actual repo, never assume a phase exists from its name").
Base commit for this phase: `f6e8932` (Phase 6 — channel ↔ bot integration).

Everything below was read from the working tree; no file was modified during the audit.

---

## 1. What already exists (and is therefore reused, not rebuilt)

| Area | Owner in the repo | Phase 7 use |
| --- | --- | --- |
| Persistence | `src/users/user.store.ts` — a JSON document written atomically (tmp + rename), state held in `Map`s, serialized through a `writeChain` | the referral document, the ledger and the activity timestamp live **in this same document** |
| Alert persistence | `src/alerts/alert.store.ts` — same pattern plus a real `transact()` on its own write chain | untouched; capacity is *read* through it |
| Alert capacity | `src/alerts/alert.service.ts`: `maxAlerts` (= `config.maxAlertsPerUser`, `:267`) enforced at `:254` inside `AlertStore.transact` via `tx.countForCapacity(userId) >= limit`; displayed at `bot-ux.service.ts:1064/:1298/:1345` | extended with an **effective limit** (`AlertCapacityService`); no second counter |
| Start command & deep links | `src/bot/deep-link.ts` (`parseStartPayload`, `screenForRoute`), `src/bot/ux/bot-ux.service.ts:handleStart` (`:732`, before the marker `// --- Phase 3: alert flows ---` at `:806`) | the referral payload becomes a sixth recognized payload kind (with one **session** for attribution moved earlier) |
| URLs | `src/bot/destination.service.ts` (Phase 6 — the single URL seam, platform-aware hosts `ble.ir` / `t.me`) | referral links are built there too (no second URL builder) |
| Menu & screens | `src/bot/ux/callback-data.ts` (`ScreenKey`, `SCREEN_KEYS`, `v1:screen:<key>`), `ux-keyboards.ts` (`mainMenuKeyboard`, `screenFooter`, …), `bot-ux.service.ts` (`UxScreen`, `renderScreen`, `recordScreenEvent`, `parentOf`) | one new screen key + one new menu row inside the existing menu |
| Event log | `src/bot/ux/ux-event-log.service.ts` (`UxEvent` union) | three new event names (facts only, no codes/ids of third parties) |
| Notification surface | `AlertNotificationService.dispatch(delivery: AlertDelivery)` is alert-only | the reward message goes through the platform adapter (the same send surface the bot already uses) |
| DI | `src/app.module.ts` — one flat `providers` array, `ConfigModule` with `validateEnvironment` | two new providers registered in the same list |
| Config | `src/config/env.validation.ts` (defaults + startup validation), `src/config/app-config.service.ts` (typed getters) | new `REFERRAL_*` keys with the same validation style |
| Tests | jest (unit + `src/**/*.integration.spec.ts`) and a separate e2e config (`test/jest-e2e.json`), doubles in `src/testing/test-doubles.ts` | Phase 7 specs use the same harness (real router + real store, network doubled) |

## 2. Gaps this phase had to fill (nothing else was touched)

1. **No "new vs. known user" signal.** `UserStore.upsertUser` creates *and* updates silently; attribution
   must know which one happened. → needed a transaction that reports `created`, executed in the same
   critical section as the registration.
2. **No transaction seam for the user document.** `UserStore` had no `transact()` (only `AlertStore`
   had one). A referral must be recorded in the *same* write as the registration. → `UserStore.transact`
   was added on the already-existing write chain; `writeFile` now reports success/failure.
3. **No interaction timestamp.** `User` had no `lastInteractionAt`, so a rolling activity metric could
   not exist. → exactly one field added, written only from the central inbound path.
4. **Capacity was a single integer.** `maxAlerts` is one configured number read in four places. → the
   effective limit is *derived* from the ledger (`AlertCapacityService`), and the alert subsystem keeps
   enforcing it through the same `create()` path.
5. **No reward ledger, no referral collection, no code namespace.** → added to the existing document
   (version 1 → 2), no second database, no migration script.

## 3. Constraints discovered during the audit (they shaped the design)

* **Identity is per platform.** `User` is keyed by `(platform, platformUserId)`; there is **no**
  verified Bale ↔ Telegram mapping in the repo. Cross-platform attribution is therefore impossible to
  do honestly and was explicitly not implemented (documented limitation, §10.4 in the report).
* **Cross-process safety is limited by the storage technology.** The document is a single JSON file with
  one atomic rename per write. Serialization is guaranteed **within one process**; two replicas writing
  the same file would race. Phase 7 therefore relies on single-writer semantics and documents that a
  multi-replica deployment needs external coordination — it does not claim a distributed guarantee it
  cannot test.
* **The Phase 6 payload bound is 32 characters** (`^[a-z0-9_-]{1,32}$`). `ref_` + an 8-character code is
  12 characters, so the referral payload fits without loosening the existing validation.
* **`asCommand()` drops arguments**, so the payload is parsed from `message.text` in one place
  (`handleStart`) — the same trap Phase 6 already handled.
* **The alert notification service cannot carry the reward message** (today: alert deliveries only), so
  the congratulation message uses the platform adapter directly, after the grant is persisted.

## 4. Deliberate non-goals (unchanged from the phase specification)

No cash/payments/wallets/coupons, no extra reward categories, no ranks/loyalty, no CRM/funnels/click
analytics, no fingerprinting or fraud platform, no AI, no new price provider or alert engine, no
parallel user database, no cross-platform merging, no admin dashboard, no new infrastructure
(no Redis/Kafka/RabbitMQ/microservices), no unrelated refactoring or rebranding.

# PHASE 7 REPORT — 🌱 GROWTH ENGINE (referrals & rewards) — Atabak Gold

Reporter: implementation agent · Date: 2026-10-16 · Branch: `main` · Base commit: `f6e8932` (Phase 6)
Verification environment: the real repository tree at `/home/user/atabak_gold`, the real `npm` scripts,
and the real built application (`dist/main.js`) driven over a real HTTPS/HTTP wire by a test-only rig
that lives **outside** the repository (`/home/user/.tmp-p7-runtime/`). Nothing in the application is
stubbed: the only doubles are the emulated Bale Bot API and price API endpoints of that rig.

---

## PHASE 7 RESULT: COMPLETE

---

## 1. Repository Audit

The phase started by reading the tree, not the phase names (`docs/PHASE_7_AUDIT.md` records the full map).

* **Persistence** — `src/users/user.store.ts` + `src/users/user.types.ts`: a single JSON document
  (`USER_DATA_FILE`, tmp file + `rename`) holding `users` and `favorites`. It is the only user store;
  Phase 7 **extends this document** (`USER_DATA_VERSION` 1 → 2) instead of adding a second store.
* **Identity** — a user is `{id, platform, platformUserId, chatId}`; `(platform, platformUserId)` is the
  resolution key and `handleUpdate` is the single place that resolves it. No display names, no usernames,
  no cross-platform mapping.
* **Bot surface** — `src/bot/ux/*`: one router (`handleUpdate`), one screen renderer, one keyboard module,
  one callback grammar (`v1:screen:<key>`), one event log. Reused as-is; Phase 7 adds **one** screen, **one**
  menu row and **one** start-payload arm.
* **Deep links** — `src/bot/deep-link.ts` (`parseStartPayload`, `screenForRoute`) and
  `src/bot/destination.service.ts` (public destinations per platform) from Phase 6. Extended, never replaced.
* **Alerts (Phase 3)** — `src/alerts/alert.service.ts` enforced a configured `maxAlerts` directly. Phase 7
  adds a **read-only derived entitlement** on top (`AlertCapacityService`); validation, persistence,
  ownership, scheduling and delivery are untouched.
* **Configuration** — `src/config/env.validation.ts` + `app-config.service.ts`: defaults, ranges and
  getters, validated at boot.
* **Gaps that had to be filled** (all in `docs/PHASE_7_AUDIT.md`): no referral code, no attribution record,
  no reward ledger, no interaction timestamp, no composable alert capacity.
* **Real constraints discovered and respected**: identity is per platform (no verified Telegram↔Bale
  mapping — §10 limitation, documented, not guessed); the store is a single-writer document (one atomic
  rename per write ⇒ single-process serialization only — multi-replica coordination is **not** claimed);
  `asCommand()` drops arguments, so `/start <payload>` is parsed from `message.text`; the platform payload
  bound is 32 characters (`ref_` + 8 = 12, inside it).

## 2. Referral-Code Implementation

* `src/referrals/referral-code.ts` — code = **8 characters** from the unambiguous alphabet
  `abcdefghjkmnpqrstuvwxyz23456789` (31 symbols, ≈8.5·10¹¹ combinations — no `0/o/1/l/i`), drawn with
  `node:crypto.randomInt`. Never sequential, never user-supplied, exposes no internal id and no secret.
* **Uniqueness**: the store keeps a code index and `assignReferralCode()` runs **inside** a transaction:
  a collision is retried (bounded attempts) and, if the attempt budget is exhausted, no code is written
  and the caller gets `null` — never a duplicate. The index is rebuilt from `users` at load, so a lost
  index can never lose a code.
* **Stability**: the code is assigned lazily on first need (referral screen / context) and never rotated;
  repeated requests return the same code. `referralCodeFor()` is idempotent and concurrency-safe.
* **Links** (`referral-link.ts` behaviour, exposed through `BotDestinationService`):
  Telegram `https://t.me/<TELEGRAM_REFERRAL_BOT_USERNAME>?start=ref_<CODE>`, Bale
  `https://ble.ir/<BALE_REFERRAL_BOT_USERNAME>?start=ref_<CODE>` (the form verified in Bale's own
  documentation). If a platform's username is not configured, the builder returns **`null`** — the UI then
  shows an explanation instead of a fabricated link. Usernames are never hardcoded.

## 3. Referral Attribution

Flow of `/start ref_<CODE>` (`ReferralService.handleStartReferral`):

1. payload parsed by the Phase-6 parser (`kind: 'referral'` only for a syntactically valid code);
2. code resolved to an inviter through the code index;
3. invitee identity resolved through the existing `(platform, platformUserId)` path;
4. inviter/invitee compared by **internal user id** (self-referral) — never by name or username;
5. a genuinely new user (`created === true`) is the **only** attribution trigger;
6. the invited user is registered by the existing store path and the referral row is written **in the same
   transaction** (`UserStore.transact()` — the single critical section), together with any newly earned
   reward rows;
7. the standard welcome screen is rendered, with a short note that the registration came from a referral
   link — normal onboarding is never blocked by a bad payload.

Outcomes are explicit and mutually exclusive: `joined | existing-user | self-referral | unknown-code |
disabled | persist-failed`. `persist-failed` → the referral is **not** counted and the user is told
normally; success is never reported when the write did not happen (the transaction dumps a local copy, so a
failed write leaves disk *and* memory unchanged).

Guarantees: at most one inviter per invitee (`inviteeUserId` is the uniqueness key), no inviter
reassignment, no retroactive attribution (an already-registered user is told the code applies to new users),
no duplicate row from repeated starts or repeated platform updates, no count inflation under concurrent
arrivals (both go through the same serialized transaction).

## 4. Referral Statistics

`ReferralService.statsFor(userId)` — every number read from the persisted document:

* **successfulReferrals** = unique referral rows owned by the inviter (no pending/rejected rows exist by
  design: a row is written only when the referral qualified).
* **activeReferrals** = referred users whose `lastInteractionAt >= now − 30 days` (rolling window from
  `REFERRAL_ACTIVE_WINDOW_DAYS`). Boundary is inclusive and deterministic (tested exactly at the cutoff);
  a user **without** a timestamp is inactive (absent is never read as "now"); the count is unique referred
  **users**, not interactions.
* `lastInteractionAt` is written only from the inbound update path (`touchActivity`, throttled to one write
  per minute per user). Outgoing notifications, scheduled jobs, channel publications and failed/malformed
  updates never touch it.
* **earnedThresholds** = `floor(successful / referralsPerReward)` and **remainingForNextReward** =
  `perReward − (successful % perReward)` are shown as *progress only*. The number of rewards really in force
  comes from the ledger; pending rows are reported as pending, never as granted.
* Also shown: `baseAlertCapacity`, `effectiveAlertCapacity`, `referralsPerReward`, and the user's own link.

## 5. Reward Engine

* Ledger: `referrals.rewards[]` — `{id, userId, rewardType:'ALERT_CAPACITY', threshold, status,
  referralsAtGrant, capacityBonus, createdAt, grantedAt, lastError}`. Uniqueness key
  `userId::rewardType::threshold` (§8.2) is enforced by the store; a second write of the same triple is
  rejected.
* Threshold handling: every arrival that changes the referral count records **every newly earned** threshold
  (3, 6, 9, 12, …) as `PENDING` in the same transaction as the referral itself.
* Application: `applyPendingRewards(userId, now)` performs an idempotent transition `PENDING → GRANTED`
  (capacity is *derived* from `GRANTED` rows, so re-running it is harmless); it is invoked on the invitee's
  own arrival, so the inviter notice only ever describes a real grant.
* Recovery: a grant that could not be applied stays `PENDING` with `lastError` and is retried on the next
  arrival — nothing is lost, nothing is double-applied. If the configured ceiling
  (`REFERRAL_MAX_BONUS_SLOTS`) is reached, the grant stays `PENDING` and is logged (`CAPACITY_CEILING_REACHED`)
  — the honest limit rather than an unbounded grant.
* Notification: only after a successful grant, from the applied grant data
  (`formatRewardGrantedNotice({threshold, slots, totalCapacity})`). A notification failure never reverses
  and never duplicates the grant. Text:
  `🎁 تبریک! با تکمیل ۳ دعوت موفق، ۱ ظرفیت دائمی اضافه برای هشدار قیمت دریافت کردی.` + the real effective
  capacity.

## 6. Alert-Capacity Integration

* `AlertCapacityService.effectiveLimit(userId)` = `MAX_ALERTS_PER_USER` + `min(Σ capacityBonus of GRANTED
  rows, REFERRAL_MAX_BONUS_SLOTS)`. `bonusSlotsFrom()` ignores rows with zero/negative/non-finite bonuses, so
  corrupted data can only fail to add capacity — it can never reduce or remove existing capacity.
* `AlertService` keeps `maxAlerts` as the configured base and answers `effectiveMaxAlerts(userId)` for
  **enforcement and every display path**; the constructor gained the capacity service (5 args) and nothing else.
* There is **no second counter**: every read derives from the durable ledger. That is what makes retries,
  restarts and concurrent arrivals harmless.
* Existing alert validation, creation, persistence, scheduling and delivery are unchanged and still covered
  by `alert.service.spec.ts` (51 tests) plus `alert-capacity.spec.ts` (10 tests).

## 7. User Interface

* One new menu row `👥 دعوت از دوستان` in the existing keyboard (now 9 rows); all existing rows and actions
  unchanged (golden-menu e2e updated accordingly).
* Screen `referral` (`v1:screen:referral`), reachable while a grant is pending or a destination is
  unconfigured: successful referrals, active referred members, granted permanent capacity, progress to the
  next reward, the effective alert capacity, a short rule/definition explanation, and the user's own link
  with a `url` button (native share sheet on Telegram; on Bale a documented URL button — no invented
  buttons). With no configured username the screen explains the situation instead of printing a fake link.
* No other user's private data is exposed: only counts are shown, never an invitee id or name.

## 8. Security and Abuse Prevention

* Payloads are untrusted: syntax first (`^[a-z0-9_-]{1,32}$`), then code lookup; malformed/oversized/
  unknown payloads are neutral (normal `/start` behaviour, no crash, never a route).
* Self-referral refused by internal id; already-registered users never counted, never re-attributed.
* Duplicates prevented by uniqueness keys in the store **inside** the serialized transaction (in-memory
  locks alone are not relied upon); the same triple/user can never be persisted twice.
* Counters and capacity cannot be manipulated from input: the client cannot name an inviter, a code or a
  bonus — those come from the persisted document only.
* Internal ids are not exposed: the public artefact is an 8-char random code with no id inside it; user text
  is rendered through the existing HTML-escaping path (no parse-mode injection); tokens never appear in
  messages, buttons or logs (asserted on the wire and in the application log by the runtime rig).
* No fingerprinting, no extra PII, no fraud platform — and no claim of detecting fake accounts.

## 9. Persistence and Migrations

* Schema: `USER_DATA_FILE` document v2 = `{version, savedAt, users[], favorites[], referrals[], rewards[]}`
  with `users[]` gaining `referralCode`, `lastInteractionAt`. Written atomically (tmp + rename).
* **No destructive migration**: the loader accepts a v1 document (arrays `referrals`/`rewards` absent,
  Phase-7 user fields absent; `chatId`/`lastInteractionAt` normalised to `null`, never invented), keeps every
  existing record, and the first write upgrades the document to `version: 2`. Verified twice: unit test
  `user.store.spec.ts` “loads a document written before Phase 7 and upgrades it without losing data (§14)”,
  and live on the built artifact (the rig boots from a pre-Phase-7 document and the legacy user keeps its id
  and `createdAt` while gaining a code).
* Uniqueness/indexes in the document model: code index (unique code), referral key (`inviteeUserId`),
  reward key (`userId::rewardType::threshold`); all rebuilt from data at load, so they are lookups, not a
  second source of truth.
* Deployment/rollback: documented in README §12 (`### مهاجرت و بازگشت (Phase 7)`). Rollback keeps the v2
  fields; disabling the feature preserves data and grants.
* **Honest limit**: one process owns the document. Multi-replica deployments need external coordination and
  are not claimed as safe.

## 10. Files Changed

**Added (12)**

| File | Purpose |
| --- | --- |
| `src/referrals/referral.types.ts` (106) | Referral/reward/outcome/stats contracts |
| `src/referrals/referral-code.ts` (77) | Secure code generation, alphabet, payload helpers |
| `src/referrals/referral.service.ts` (664) | Attribution, activity, statistics, reward accounting |
| `src/alerts/alert-capacity.service.ts` (100) | Read-only derived effective capacity |
| `src/bot/ux/start-route.integration.spec.ts` (252) | Start-route integration (`ref_` + the five routes) |
| `src/referrals/referral-code.spec.ts` (155) | Code/link tests |
| `src/referrals/referral.service.spec.ts` (454) | Attribution and edge-case tests |
| `src/referrals/referral-rewards.spec.ts` (493) | Threshold, idempotency, recovery tests |
| `src/referrals/referral-activity.spec.ts` (395) | Active-member and statistics tests |
| `src/referrals/referral-flow.integration.spec.ts` (307) | End-to-end flow through the UX layer |
| `src/alerts/alert-capacity.spec.ts` (245) | Capacity integration tests |
| `docs/PHASE_7_AUDIT.md` (65) | Audit: reuse map, gaps, constraints, non-goals |

**Modified (24, +1834/−331)**

*Persistence/config*: `src/users/user.types.ts` (+34/−3), `src/users/user.store.ts` (+475/−9: transaction,
referral/reward/activity APIs, v1-tolerant load, snapshot), `src/config/env.validation.ts` (+98/−1),
`src/config/app-config.service.ts` (+61), `src/app.module.ts` (+7).
*Referral surface*: `src/bot/deep-link.ts` (+26/−3: `ref_` arm), `src/bot/destination.service.ts` (+49:
referral destinations per platform), `src/bot/ux/ux-format.ts` (+110: referral screen, welcome note, reward
notice), `src/bot/ux/ux-keyboards.ts` (+36/−3: menu row + share button), `src/bot/ux/callback-data.ts` (+4/−1),
`src/bot/ux/ux-event-log.service.ts` (+6), `src/bot/ux/bot-ux.service.ts` (+249/−20: referral screen,
invitee note, inviter notice, activity touch).
*Alerts*: `src/alerts/alert.service.ts` (+21/−1).
*Tests*: `src/alerts/alert.service.spec.ts`, `src/config/env.validation.spec.ts`, `src/users/user.store.spec.ts`,
`src/testing/test-doubles.ts`, `src/bot/deep-link.spec.ts`, `src/channel/cta-policy.spec.ts`,
`src/bot/ux/bot-ux.service.spec.ts`, `src/bot/ux/favorites.integration.spec.ts`,
`src/bot/ux/market-flow.integration.spec.ts`, `test/bot-ux.e2e-spec.ts` (golden menu).
*Docs*: `README.md` (+97/−3), `.env.example` (+27).

**Deleted:** none.

> Note on the two reworked Phase-6 specs (`deep-link.spec.ts`, `cta-policy.spec.ts`): while verifying the
> diff, the working copies were found to be **missing** committed Phase-6 cases (a name-level comparison hid
> it). They were restored, not dropped: purity, secret-free `logPolicy`, label↔route invariant and
> subject-group assertions back into `cta-policy.spec.ts` (now 15 tests), and the payload length bound plus
> determinism back into `deep-link.spec.ts` (now 24 tests). Net effect of the phase is **more** coverage than
> Phase 6, not less.

## 11. Tests and Quality Checks

| Check | Command | Result |
| --- | --- | --- |
| Dependency install | `git diff -- package.json package-lock.json`, `npm ls --depth=0` | **NOT RUN** (no dependency change: diff empty, installed tree consistent) |
| Build | `npm run build` | **PASS** |
| Lint | `npx eslint "{src,test}/**/*.ts"` | **PASS** (0 problems) |
| Type check | `npx tsc -p tsconfig.json --noEmit` + `…tsconfig.build.json…` | **PASS** (both clean) |
| Unit + integration | `npx jest` | **PASS** — 64 suites / **1039 tests**, 0 failed |
| Coverage | `npm run test:cov` | **PASS** — stmts 91.41 / branch 81.55 / funcs 92.49 / lines 91.40 |
| E2E | `npm run test:e2e` | **PASS** — 5 suites / 36 tests |
| Migration verification | `user.store.spec.ts` v1 test + rig boot from a v1 document | **PASS** |
| Referral-code tests | `referral-code.spec.ts` (12) | **PASS** |
| Referral-attribution tests | `referral.service.spec.ts` (24), `referral-flow.integration.spec.ts` (13) | **PASS** |
| Active-member/statistics tests | `referral-activity.spec.ts` (16) | **PASS** |
| Reward-threshold tests | `referral-rewards.spec.ts` (27) | **PASS** |
| Alert-capacity integration | `alert-capacity.spec.ts` (10), `alert.service.spec.ts` (51) | **PASS** |
| Telegram-specific | unit: link shapes/parser/attribution (`platform: 'telegram'`) | **PASS** (unit) |
| Telegram live | live rig | **NOT RUN** (no Telegram credential in the environment) |
| Bale-specific | live rig on the built artifact | **PASS** — 41/41 checks |
| Regression Phases 1–6 | full `npx jest` + `npm run test:e2e` | **PASS** (all suites green, no phase skipped) |
| Manual verification | human checklist (README §16) | **NOT RUN** (replaced by the automated rig; checklist provided) |

Runtime rig (`.tmp-p7-runtime/run-p7.js`, 41 checks, all PASS): pre-Phase-7 document upgrade → invitee
`/start ref_<code>` → three successful referrals → exactly one GRANTED reward with
`capacityBonus = 1` → the inviter notice with the real threshold and the real capacity → referral screen
with the persisted numbers and the user's own `ble.ir` link → self-referral and duplicate start never count
→ `/start alert` still opens the Phase-3 wizard and creates no alert → no token in any message, button or
log line → restart keeps the code, the rows and the single grant, and re-issues nothing.

## 12. Configuration Changes

| Variable | Default | Validation |
| --- | --- | --- |
| `REFERRAL_ENABLED` | `true` | boolean; disabled ⇒ nothing is created or attributed |
| `REFERRAL_REWARDS_ENABLED` | `true` | boolean; disabled ⇒ no new grants, existing capacity preserved |
| `REFERRAL_REWARDS_PER_THRESHOLD` | `3` | integer 1..10000 (frozen rule 3) |
| `REFERRAL_REWARD_BONUS_SLOTS` | `1` | integer 1..100 (frozen rule 1) |
| `REFERRAL_ACTIVE_WINDOW_DAYS` | `30` | integer 1..3650 (frozen rule 30) |
| `REFERRAL_MAX_BONUS_SLOTS` | `50` | integer 1..10000 — the ceiling that keeps a bad config finite |
| `BALE_REFERRAL_BOT_USERNAME` | `''` | username shape or empty (empty ⇒ no link, explanation shown) |
| `TELEGRAM_REFERRAL_BOT_USERNAME` | `''` | username shape or empty |

Thresholds are read from configuration in one place (`app-config.service.ts`) and are never hardcoded
across services. No secrets are added to the repository.

## 13. Documentation Changes

* `README.md`: new `## 4.7 موتور رشد` section (rules, uniqueness/transaction/effectively-once, UI, honest
  limits), 8 env rows, `USER_DATA_FILE` re-documented as a v2 document, `PHASE_7_{AUDIT,REPORT}.md` in the
  docs index, and `### مهاجرت و بازگشت (Phase 7)` in §12 (no migration needed, deploy steps, rollback,
  disable-without-data-loss, capacity-reduction boundary).
* `.env.example`: full Phase-7 block with per-key rationale.
* `docs/PHASE_7_AUDIT.md`, `docs/PHASE_7_REPORT.md` (this file).
* README §16 carries the safe manual checklist (attribution, grant, capacity), which never requires real
  production users or unsolicited messages.

## 14. Known Limitations

1. **No cross-platform identity merging** — Telegram and Bale accounts of the same person are two users
   (existing model, documented; merging would need a verified mapping the repository does not have).
2. **Single-writer document store** — correctness relies on one process owning `USER_DATA_FILE`; multiple
   replicas would need external coordination. Not claimed as safe.
3. **Pre-Phase-7 users are inactive until their next interaction** — there is no historical interaction data
   to backfill, and none is invented.
4. **Ceiling on permanent capacity** (`REFERRAL_MAX_BONUS_SLOTS`, default 50). Beyond it thresholds stay
   `PENDING` and are logged; they are never silently granted or dropped.
5. **Bale has no separate “share sheet” button** — the link is presented as a `url` button plus copyable
   text (the documented capability), not as an invented control.
6. **No click/lead analytics, no fraud platform** — out of scope by §18; the active-member metric is the
   only behavioural signal, and fake-account detection is explicitly not guaranteed.
7. **Code rotation** is not exposed in the UI; it would be a manual, documented operational procedure.

## 15. Out-of-Scope Confirmation

No payments/wallets/coupons, no extra reward categories, no ranks/loyalty, no CRM/lead funnels/click
analytics/external analytics, no fingerprinting or fraud infrastructure, no AI/LLM/prediction/signals, no new
price provider, no new alert engine, no parallel user database, no cross-platform merging, no separate admin
dashboard, no new infrastructure (Redis/Kafka/RabbitMQ/microservices), no unrelated refactoring. No new
dependency was added (`package.json`/`package-lock.json` unchanged).

## 16. Definition of Done

**Referral system** — unique stable code **PASS** (`referral-code.spec.ts`, rig) · links from real
configuration **PASS** (both platform shapes, `null` without config) · links enter the existing flow **PASS**
(rig + `start-route.integration.spec.ts`) · at most one inviter **PASS** (`inviteeUserId` key) · attribution
only after registration+persistence **PASS** (`created` trigger, `persist-failed`) · existing users never
counted **PASS** · self-referral rejected **PASS** · duplicates/concurrency cannot inflate **PASS**.

**Statistics** — accurate counts **PASS** · rolling 30-day definition **PASS** (inclusive boundary tested) ·
automation/jobs never counted **PASS** · progress computed correctly **PASS** · UI shows persisted values
**PASS** (rig) · no private data exposed **PASS**.

**Rewards** — every 3 referrals ⇒ 1 permanent slot **PASS** (thresholds 0,1,2,3,4,5,6,8,9,12, …) · each
threshold at most once **PASS** · durable, auditable ledger **PASS** · applied via the Phase-3 mechanism
**PASS** · failed grants never reported as successful **PASS** · retry/concurrency cannot duplicate **PASS**
(restart proven in the rig) · existing alert behaviour and entitlements intact **PASS**.

**Quality and deployment** — migrations documented and verified **PASS** · tests pass **PASS** · build **PASS**
· lint **PASS** (0 problems) · regression green **PASS** · README + `.env.example` updated **PASS** · final
diff reviewed **PASS** (no deletions, no stray files, no dependency change) · limitations reported honestly
**PASS** (§14).

## 17. Final Status

```
PHASE 7 COMPLETE — READY FOR THE NEXT PHASE
```

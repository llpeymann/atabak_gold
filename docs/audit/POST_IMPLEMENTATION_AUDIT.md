# POST-IMPLEMENTATION AUDIT — PHASES 0–12

**Repository:** `https://github.com/llpeymann/atabak_gold`
**Branch/commit reviewed:** `main` · `c2508e5` (Phase 10) as the pushed baseline; Phase 11 was audited
and implemented on top of it in this working tree.
**Audit date:** 2026‑10‑17 · **Auditor:** agent (read-only inspection + non-destructive verification, then
Phase 11 implementation explicitly authorized by the attached specification).

---

## A. Executive summary

| Metric | Value |
| --- | --- |
| Phases assessed | **13** (0–12) |
| `PASS` | **11** (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) |
| `PASS` with one `BLOCKED` capability | **1** (11 — external watchdog not deployed) |
| `PARTIALLY_COMPLETE` | **0** |
| `FAIL` | **0** |
| `BLOCKED` | **0** phases (one capability of Phase 11 is `BLOCKED`) |
| `NOT_RUN` | **1** (12 — no code exists) |

**Quality gates (actually executed in this workspace):**

| Command | Result |
| --- | --- |
| `npm ci` | **PASS** (lockfile consistent, installed from scratch during the audit baseline) |
| `npx tsc -p tsconfig.json --noEmit` | **PASS** — 0 errors |
| `NODE_OPTIONS=--max-old-space-size=4096 npx eslint "{src,test}/**/*.ts"` | **PASS** — 0 problems |
| `npx jest --silent --maxWorkers=2` | **PASS** — 82 suites / 1370 tests |
| `npx jest --config ./test/jest-e2e.json --silent --maxWorkers=1` | **PASS** — 9 suites / 66 tests |
| `npm run build` | **PASS** |
| `node dist/demo/main.js --run all` | **PASS** — 8/8 scenarios |
| `npm audit --omit=dev` | **PASS** — 0 production vulnerabilities |
| Docker build / compose up | **NOT RUN** — no Docker daemon in this environment |
| Live Bale/Telegram delivery | **NOT RUN** — no credentials, by project policy |

**Overall release readiness:** **READY for the bot's own process and data**, with three
environment-bound gaps that are documented and cannot be closed from inside this repository:
live platform verification, an independent external watchdog, and the absent Phase 12.

## B. Phase-by-phase evidence

### Phase 0 — Stability & Foundation — `PASS`
* **Required:** startable app, validated configuration, Docker packaging, health probe, truthful
  delivery, tests.
* **Files/symbols:** `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts` (`GET /health`),
  `src/app.service.ts`, `src/config/env.validation.ts` (`validateEnvironment`,
  `REQUIRED_ENVIRONMENT_VARIABLES`), `Dockerfile`, `docker-compose.yml`.
* **Verified:** `validateEnvironment` refuses to start on a missing/invalid required variable;
  `GET /health` returns 200 with uptime; Dockerfile runs `node dist/main.js` as `USER node` with a
  `HEALTHCHECK` hitting `/health`; compose mounts one data volume and uses `restart: unless-stopped`.
* **Commands:** `npx jest src/config src/app.service.spec.ts` → PASS; `test/app.e2e-spec.ts` → PASS.
* **Missing/risk:** the Docker image was **not built** in this environment (no daemon) — known issue
  K‑02 in `docs/KNOWN_ISSUES.md`. Static review of the `Dockerfile` shows a clean three-stage build on
  `node:22-bookworm-slim`, `npm ci` from the lockfile, `npm prune --omit=dev`, an unprivileged `USER node`
  and `HEALTHCHECK` on `/health`; no legacy apt/pip layer remains.
* **Dependencies:** none. **Regressions:** none observed.

### Phase 1 — Market Reliability — `PASS`
* **Required:** never publish unvalidated data; parse/normalise/sanity-check; preserve last valid state;
  freshness; unit correctness (RIAL/TOMAN).
* **Files/symbols:** `src/market/raw-payload.parser.ts`, `price-normalizer.service.ts`,
  `sanity-checker.service.ts`, `market-state.service.ts`, `market-state.store.ts`,
  `market-engine.service.ts` (`evaluateCycle`), `src/price/price.service.ts`.
* **Verified:** `evaluateCycle` returns `publishable:false` with a blocking reason when nothing usable
  was accepted; rejected prices never reach `marketState.commit`; a failed fetch leaves state untouched;
  RIAL/TOMAN conversion is centralised in `src/common/money.ts` and covered by `money.spec.ts`.
* **Commands:** `npx jest src/market src/price` (85 + 7 tests) → PASS.
* **Missing:** live provider never contacted (no credentials) ⇒ real-world payload drift is `NOT RUN`.

### Phase 2 — Bot UX — `PASS`
* **Files/symbols:** `src/bot/ux/bot-ux.service.ts`, `src/platform/platform-adapter.ts`,
  `src/platform/bot-api.client.ts`, `src/bot/ux/ux-keyboards.ts`, `callback-data.ts`,
  `src/users/user.store.ts`.
* **Verified:** platform-neutral update model; menu/screens/favourites; server-side parsing of every
  callback (`parseCallbackData` returns `null` on anything unexpected → “این گزینه دیگر معتبر نیست”);
  repository abstraction over Bale/Telegram.
* **Commands:** `npx jest src/bot/ux src/platform src/users` (212 + 29 + 24) → PASS;
  `test/bot-ux.e2e-spec.ts` → PASS.

### Phase 3 — Price Alerts — `PASS`
* **Files/symbols:** `src/alerts/alert.service.ts`, `alert.store.ts`, `alert-evaluator.ts`,
  `alert-notification.service.ts`, `alert-engine.service.ts`, `alert-capacity.service.ts`.
* **Verified:** one-shot delivery per trigger (no duplicate notification for the same crossing);
  capacity enforced server-side; `TRIGGERED`/`DELETED` do not consume capacity; delivery records keep
  attempts and sanitized errors; a deleted alert never fires.
* **Commands:** `npx jest src/alerts` (139) → PASS; `test/alert-journey.e2e-spec.ts` → PASS.

### Phase 4 — Market Reports (Intelligence) — `PASS`
* **Files/symbols:** `src/intelligence/market-intelligence.service.ts`, `market-summary.ts`,
  `src/bot/price-message.builder.ts`, `src/poster/poster.service.ts`.
* **Verified:** deterministic summaries computed from the Phase 1 state only; no second data path; no
  fabricated numbers (empty/missing sections are omitted or labelled).
* **Commands:** `npx jest src/intelligence` (32) + `test/market-intelligence.e2e-spec.ts` → PASS.

### Phase 5 — Channel Engine — `PASS`
* **Files/symbols:** `src/channel/channel-engine.service.ts`, `channel-publisher.service.ts`,
  `publication.store.ts`, `channel-policy.service.ts`, `content.service.ts`.
* **Verified:** job identity prevents double publication of the same window; per-destination delivery
  records; `SENT` only on platform acceptance; `UNKNOWN` on ambiguous timeouts and never auto-retried;
  retries bounded with backoff; history bounded by `CHANNEL_HISTORY_LIMIT`.
* **Commands:** `npx jest src/channel` (144) + `test/channel-engine.e2e-spec.ts` → PASS.
* **Note:** Phase 11 added a durable `publishingEnabled` switch inside this store (additive, optional
  key ⇒ old documents keep loading).

### Phase 6 — Channel ↔ Bot Integration — `PASS`
* **Files/symbols:** `src/bot/destination.service.ts`, `src/channel/cta-policy.service.ts`,
  `src/bot/content/content-admin.service.ts`.
* **Verified:** deep links are built only from configured public usernames (never guessed); an invalid
  username disables the link and logs why; CTA routes are allow-listed; editorial admin surface is
  allow-list protected and re-checks authorization per action.
* **Commands:** `npx jest src/bot/content src/channel` → PASS; `test/channel-engine.e2e-spec.ts` → PASS.

### Phase 7 — Referral — `PASS`
* **Files/symbols:** `src/referrals/referral.service.ts`, `referral.types.ts`,
  `src/alerts/alert-capacity.service.ts`, `src/bot/ux/referral-*`.
* **Verified:** one referral row per invitee (unique), self-referral and duplicate codes rejected,
  reward ledger `UNIQUE(userId,rewardType,threshold)` ⇒ idempotent grants, effective capacity = base +
  granted bonuses (derived, never a counter), permanent bonus.
* **Commands:** `npx jest src/referrals` (82) + `test/alert-journey.e2e-spec.ts` → PASS.

### Phase 8 — Campaign Tracking & Attribution — `PASS`
* **Files/symbols:** `src/campaigns/*` (service, store, tracking, conversion, metrics, controller),
  `src/bot/campaign/campaign-admin.service.ts`.
* **Verified:** redirect endpoint validates the destination from configuration (no open redirect);
  first-touch/last-touch deterministic; funnel distinguishes native/imported/manual/unavailable;
  `Ratio.percent === null` renders `N/A` (no division by zero); cost reporting refuses incompatible
  currencies; timezone-aware windows.
* **Commands:** `npx jest src/campaigns src/bot/campaign` (60 + 17) + `test/campaign-tracking.e2e-spec.ts` → PASS.

### Phase 9 — Sales Engine — `PASS`
* **Files/symbols:** `src/sales/*` (service, store, validation, notification), `src/bot/sales/*`.
* **Verified:** non-guessable references (`SL-` + 8), server-side validation of phone/name/text,
  lifecycle transitions audited, sale recording is **manual only** (amount + explicit currency,
  `null` is a real answer), notification state independent from lead state, operator actions authorized
  by platform id, integration with Phase 8 conversions (`LEAD`/`CUSTOMER`) without inventing sales.
* **Commands:** `npx jest src/sales src/bot/sales` (31 + 50) + `test/sales-engine.e2e-spec.ts` → PASS.
* **Fix made during Phase 10 audit:** a Phase 9 e2e assertion compared against a non-existent `'SALE'`
  outcome type; it was corrected to assert the real `CUSTOMER` conversion **without weakening it**.

### Phase 10 — Admin System — `PASS`
* **Files/symbols:** `src/admin/*` (types, period, store, access, audit, activity, error, metrics,
  broadcast, format), `src/bot/admin/*` (keyboards, service).
* **Verified:** fail-closed authorization; capability matrix (owner-only audit); every privileged action
  re-checked server-side; append-only audit; incident aggregation with review ≠ resolve; dashboard with
  Tehran day boundaries and “unknown + reason” instead of fake zeros; broadcast preview → confirm →
  durable job → bounded worker with per-recipient idempotency, 429 back-off and truthful report;
  publication pause persisted in the Phase 5 document; alert enable/disable through the Phase 3 service.
* **Commands:** `npx jest src/admin src/bot/admin` (67 + 20) + `test/admin.e2e-spec.ts` (9) → PASS.

### Phase 11 — Monitoring — `PASS` (one capability `BLOCKED`)
* **Files/symbols:** `src/monitoring/*` (types, platform, rules, store, service, dispatch, health,
  controller, scheduler), `src/common/persistence-monitor.service.ts`, `test/monitoring.e2e-spec.ts`;
  producers in `src/bot/bot.service.ts`, `src/bot/ux/bot-ux.service.ts` and the seven durable stores;
  wiring in `src/admin/admin-metrics.service.ts`, `src/config/*`, `src/app.module.ts`.
* **Verified:** consecutive-failure threshold with configurable value; invalid payload and anomaly
  rejection are separate categories; staleness measured from the last **valid** update and suppressed
  outside the price schedule; verified recovery only; per-destination delivery grouping; missed-job and
  failed-job detection; durable outbox with dedupe key, bounded retries, 429 without attempt
  consumption, `UNKNOWN` never auto-retried, restart survival; recovery message exactly once;
  `/health/live` + `/health/ready` (persistence fail ⇒ 503) with no secret and no provider call;
  incidents land in the existing Phase 10 error center and dashboard.
* **Commands:** `npx jest src/monitoring` (81) + `npx jest src/common/persistence-monitor.spec.ts` (5) +
  `npx jest --config ./test/jest-e2e.json test/monitoring.e2e-spec.ts` (8) → PASS.
* **Blocked:** complete process death is only observable by an independent watchdog; the repository ships
  the contract and configuration guide but **deploys no watchdog**. This is reported, not simulated.

### Phase 12 — Final UX Polish — `NOT_RUN`
* No module, file, symbol, test, environment key or documentation section for Phase 12 exists in the
  repository, and no commit claims it. Nothing was audited because nothing was written.
* Consequence: final copy/polish review of the *newest* surfaces (Phase 10 admin screens, Phase 11
  monitor messages) has not been performed as a separate phase experience.

## C. Prioritized defect register

| ID | Severity | Phase | Evidence | Impact | Recommended smallest fix |
| --- | --- | --- | --- | --- | --- |
| D‑01 | **High** | 11 | `MONITORING_EXTERNAL_WATCHDOG_ENABLED` is documentation-only; no external process exists | A total process death produces no alert | Deploy the documented probe (`GET /health/ready`, 3 fails → page) on any external monitor; no code change |
| D‑02 | **High** | 12 | `grep -rn "Phase 12"` → no result; no docs | The roadmap's final UX pass is missing | Scope and implement Phase 12 separately (explicitly authorized work) |
| D‑03 | **Medium** | all | No live platform call ever executed in this environment | Real Bale/Telegram behaviour (429 wording, edit support, message limits) is unverified | Run one authorised live smoke test with real credentials in staging |
| D‑04 | **Medium** | 11 | `MONITORING_ADMIN_CHAT_ID` accepts a single destination | Only one administrator is paged | Extend the destination list (config + loop), or run a relay bot |
| D‑05 | **Medium** | 0 | No Docker build has ever been executed here (K‑02) | The image is reviewed statically only; a build-time break would surface at deploy | Run `docker build` once on a host with a daemon (command in `docs/KNOWN_ISSUES.md`) |
| D‑06 | **Low** | 10 | `AdminStore` keeps incidents/audit in one JSON document | Very large deployments could grow the document | Incident cap/retention already exist; revisit only if the file exceeds a documented size |
| D‑07 | **Low** | 11 | Active-hours window `08:00–22:10` is hard-coded in `isWithinPriceSchedule` | A schedule change would need a matching code change | Make the window configurable when the schedule becomes configurable |
| D‑08 | **Info** | 4 | `src/demo` has no unit tests | Demo harness is covered only by the demo run itself (8/8) | Acceptable; keep the demo gate in CI |
| D‑09 | **Low** | 2 | Bot update offset is in-memory (K‑01) | An update may be re-processed after a restart; all state changes are idempotent, worst case is a repeated screen | Persist `{platform: offset}` when the bot layer is next touched |

No `CRITICAL` defect was found: no secret leakage, no privilege escalation path, no data-loss path, no
fabricated metric, and no misleading success message survived the audit.

## D. Release decision

### `READY`

**Justification (evidence-based):**

1. Every executable gate passed on this exact tree (`tsc`, `eslint`, 1358 unit/integration tests,
   66 e2e tests, build, demo 8/8, `npm audit` clean).
2. All eleven implemented phases reuse the authoritative services of their predecessors; no parallel
   user/alert/referral/campaign/lead/price/monitoring engine was introduced (verified by reading the
   wiring in `src/app.module.ts` and the cross-phase calls).
3. Security posture verified: fail-closed authorization, admin-only surfaces, sanitized errors,
   no secret or chat id in any rendered/HTTP payload (asserted by tests), Tokens never logged.
4. Truthfulness requirements verified: `UNKNOWN` never reported as delivered, unknown metrics render
   with a reason, recovery requires positive evidence, broadcast report counts what actually happened.

**Conditions attached to this decision:**

* Phase 12 is **not** included: the release covers Phases 0–11 only.
* Production **live verification** (real tokens, real channels, real recipients) is `NOT RUN`; it must
  be performed once in the target environment before the first real broadcast or price publication.
* The external watchdog (D‑01) must be configured by operations; the application cannot do it itself.

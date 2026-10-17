# RELEASE READINESS — Phase 0–11

**Decision: `READY`** (Phases 0–11 only; Phase 12 is `NOT_RUN` and is not part of this release)
**Repository:** `https://github.com/llpeymann/atabak_gold` · **Branch:** `main`
**Reviewed tree:** Phase 10 commit `c2508e5` + Phase 11 implementation in this working tree
**Date:** 2026‑10‑17

---

## 1. Release decision and its evidence

| Gate | Threshold for `READY` | Observed | Verdict |
| --- | --- | --- | --- |
| Type safety | `tsc --noEmit` = 0 errors | 0 errors | PASS |
| Lint | ESLint `{src,test}` = 0 problems | 0 problems | PASS |
| Unit/integration tests | all green, no skips hiding failures | 82 suites / 1370 tests pass | PASS |
| End-to-end tests | all green | 9 suites / 66 tests pass | PASS |
| Build | `npm run build` succeeds | succeeded | PASS |
| Install from lockfile | `npm ci` succeeds | succeeded | PASS |
| Dependency risk (prod) | 0 known vulnerabilities | 0 (info/low/moderate/high/critical) | PASS |
| Demo (product walkthrough) | all scenarios pass offline | 8/8 | PASS |
| Secrets in repo/logs/payloads | none | none found; tests assert it | PASS |
| Phase regressions | no dropped capability | Phases 1–10 suites still green | PASS |
| Live platform verification | required once before first real send | **not performed** | **OPEN (env)** |
| External watchdog | required for total-process-death alerting | **not deployed** | **OPEN (ops)** |

`READY` here means: the software is internally consistent, tested, and safe to deploy; two operational
steps (live smoke test, external probe) remain outside the repository's control and are listed as
pre-flight items, not as code defects.

## 2. What ships

* 12 phases requested; **11 implemented** (0–11). Phase 12 (`Final UX Polish`) has no code.
* No new infrastructure: one process, one JSON-document data directory, no Redis/queue/external DB.
* Total code additions for Phase 11: 9 monitoring files + 1 shared persistence seam, 7 unit suites
  (86 tests), 1 e2e suite (8 tests), 2 docs, 1 audit set — plus one optional line in seven stores.

## 3. Pre-flight checklist for the deployer

| # | Step | Why | Command / where |
| --- | --- | --- | --- |
| 1 | Fill `.env` from `.env.example` | Startup fails fast on a missing/invalid required key | `cp .env.example .env` |
| 2 | Set `BALE_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` (only the platform(s) used) | The bot cannot poll without a token | `.env` |
| 3 | Set `ADMIN_OWNER_IDS` (`bale:123`) | Fail-closed admin surface; without it nobody can administer | `.env` |
| 4 | Set `MONITORING_ADMIN_CHAT_ID` (numeric) or ensure an owner has a chat id | Otherwise incidents persist but nobody is paged | `.env` |
| 5 | Keep `MONITORING_DATA_FILE` on the same volume as the other data files | Pending notifications must survive a restart | `docker-compose.yml` volume `/app/data` |
| 6 | Run the live smoke test once (send one test message, one price cycle) | Real platform behaviour is unverified here (D‑03) | `docs/KNOWN_ISSUES.md` K‑03 |
| 7 | Configure an external probe on `GET /health/ready` (3 fails → page) | Total process death pages nobody otherwise (D‑01) | `docs/PHASE_11_REPORT.md` §L |
| 8 | Build the image once on a host with Docker | The image was never built in the audit environment (D‑05/K‑02) | `docker build -t atabak-gold .` |

## 4. Data and backup posture

* Persistent state: market state, users/favourites, alerts, referral ledger, campaigns, leads,
  admin document (incidents/audit/broadcast jobs), monitoring document (watches/jobs/outbox).
* All files use the same atomic write pattern (`tmp` → `rename`) and are validated/versioned on load;
  a corrupt or older document degrades to "start with what is valid + warn", never a crash loop.
* Backup: snapshot the whole `/app/data` volume. Restoring an older snapshot is safe for every store
  (no destructive migrations); worst case is re-processing of a completed price window, which the
  idempotency keys in Phases 1/3/5/10/11 absorb.
* Bounded growth: alert/incident/notification history caps are configured (`*_HISTORY_LIMIT`,
  `ADMIN_MAX_INCIDENTS`, `ADMIN_INCIDENT_RETENTION_DAYS`); pending outbox rows are never pruned.

## 5. Rollback

1. Redeploy the previous image tag (or `git checkout c2508e5`) — Phase 11 is purely additive.
2. The Phase 11 document is ignored by older code; no downgrade script is needed.
3. If monitoring must be silenced without a rollback: `MONITORING_ENABLED=false` (truthful "off"
   state in the admin surface) or `MONITORING_SWEEP_INTERVAL_SECONDS=0` to stop the timer only.
4. If broadcast publishing must stop: the Phase 5 pause switch via the admin UI (persisted), which is
   independent of monitoring.

## 6. Operational readiness

| Area | State |
| --- | --- |
| Liveness | `GET /health/live` — 200 while the loop answers |
| Readiness | `GET /health/ready` — 200 (`ok`/`degraded`) or 503 on a real `fail` |
| Legacy probe | `GET /health` unchanged (Docker/Compose healthcheck) |
| Incident visibility | Phase 10 error center + dashboard rows, `monitoring` source |
| Logs | Structured, secrets redacted; each sweep prints a one-line summary |
| Rate limits | Outbox pacing (`MONITORING_NOTIFICATION_MIN_INTERVAL_MS`) and 429 handling without attempt loss |
| Bounded work per tick | `MONITORING_NOTIFICATION_BATCH_SIZE` (default 10), single non-overlapping sweep |
| Timezone | All schedules and the active window in `Asia/Tehran` |

## 7. Residual risk register (release view)

| ID | Risk | Severity | Mitigation at release |
| --- | --- | --- | --- |
| R‑1 | Total process death is silent | High | Deployer configures the external probe (pre-flight #7); single-process design is intentional and documented |
| R‑2 | Real platform behaviour differs from the simulated adapter | Medium | Pre-flight #6 live smoke test before the first real broadcast |
| R‑3 | Single admin notification destination | Medium | Fine for one operator; documented (D‑04) |
| R‑4 | Undefined Phase 12 polish | Medium | Out of scope of this release; explicitly not claimed |
| R‑5 | Very large data documents (JSON) | Low | Caps/retention configured; revisit only past a documented size |
| R‑6 | Re-processed update after restart (K‑01) | Low | Every state transition is idempotent |

## 8. Sign-off summary

* **Code quality:** no `tsc`/lint/build/test failure, no known production vulnerability.
* **Truthfulness:** no fabricated metric, no delivered-but-unknown claim, no fake "healthy" when
  monitoring is off; every open gap is named in `docs/audit/POST_IMPLEMENTATION_AUDIT.md` §C.
* **Scope discipline:** no capability from Phases 1–10 removed, replaced or duplicated; no second admin
  surface; no new dependency for Phase 11.
* **Decision:** **`READY`** for Phases 0–11, conditional on the eight pre-flight steps in §3 and on
  Phase 12 remaining explicitly out of scope.

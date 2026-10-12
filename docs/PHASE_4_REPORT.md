# PHASE 4 REPORT — 📊 MARKET INTELLIGENCE (Atabak Gold)

**PHASE 4 RESULT: COMPLETE — READY FOR PHASE 5** (push to `origin` remains BLOCKED, see §20)

This report follows the mandatory phase process order of §64: audit (STEP 1) → design (STEP 2) → domain
(STEP 3) → presentation (STEP 4) → UX (STEP 5) → tests → quality commands → scope review.

---

## 1. Executive Summary

Phase 4 adds a **deterministic, descriptive market-intelligence layer** on top of the Phase 1 validated
market state. Nothing in this phase can fetch a price, validate a price, mutate market state or trigger
an alert: it reads what Phase 1 already accepted and renders it. There is no second market state, no
second cache, no second freshness mechanism and no new infrastructure.

Delivered, all reachable from the existing `📊 بازار` hub:

* **Daily market report** (`📊 گزارش امروز`, compact) and **detailed report** (`📋 گزارش کامل امروز`):
  per registry symbol `open` (first valid price of the Tehran day), `current` (latest valid), `high`,
  `low`, absolute daily change and full-precision daily percentage, plus an explicit per-symbol
  unavailable state.
* **Market movement** (`📈 حرکت بازار`): current versus the **previous valid** price, absolute and
  percentage movement, direction `UP`/`DOWN`/`UNCHANGED`/`UNKNOWN` — deliberately a different number
  from the daily change, and worded differently on screen.
* **Last update** (`🕐 آخرین بروزرسانی`): the real timestamp of the accepted price of every symbol
  (Asia/Tehran) with a freshness badge (`✅ تازه` / `⚠️ کهنه` / `— بدون داده معتبر`).
* **Market summary** (inside the report): counts of increasing / decreasing / unchanged / unknown —
  pure arithmetic over the same snapshot, no interpretation, no forecast, no advice.
* **`↻ بروزرسانی`** on every Phase 4 screen: re-reads the validated state and re-renders. It never calls
  the external price API, never invents a timestamp, never triggers alerts and never touches favorites.

Quality results on the frozen tree (all commands actually executed, §19):

| Gate | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | ✅ |
| Build | `npm run build` | ✅ |
| Lint | `npm run lint` | ✅ 0 problems |
| Unit + integration | `npx jest` | ✅ **42 suites / 639 tests** |
| End-to-end | `npm run test:e2e` | ✅ **4 suites / 25 tests** |
| Container | `sudo docker build -t atabak-gold-p4 .` | ✅ build succeeded, 246 MB, container boots cleanly (health endpoint up) |
| Live runtime | rig against a real HTTP wire + the **real Asia/Tehran cron** | ✅ §19.4 |

## 2. Scope Delivered and Explicit Non-Goals

In scope (§§5–§44 of the phase brief) and implemented: (A) daily market report, (B) last update,
(C) market movement, (D) optional market summary, (E) integration into the existing Phase 2 `📊 بازار`
hub, (F) a refresh path that must not call the external API.

Explicitly **not** implemented, by design (§4): no AI/ML/LLM, no sentiment, no prediction or
forecasting, no buy/sell or investment advice, no signals, no RSI/MACD/MA/Bollinger, no candles, no
charts, no portfolio, no referral, no campaign/CRM/lead capture, no sales/payment/subscription/premium,
no admin dashboard, no marketing, no inventory, no new market API, no Redis/Kafka/RabbitMQ/ClickHouse/
TimescaleDB/Elasticsearch. No new dependency was added and no new environment variable was introduced.

## 3. Process Compliance: Audit → Design → Domain → Presentation → UX → Tests → Quality → Review

* **STEP 1 — Audit.** `docs/PHASE_4_AUDIT.md` was written *before* any Phase 4 code. It inventories what
  already existed (Phase 1 validated state, daily reset, persistence, freshness thresholds; Phase 2 hub
  and navigation; Phase 3 alert flow) as C1–C13, what had to be added, what must not be touched, and the
  decisions taken during implementation (D1–D8), plus a second-pass section (D9–D12, §20 below).
* **STEP 2 — Design.** The layer was designed as *read → transform → render*, with the transformation
  living in a new `src/intelligence/` module that depends only on `MarketStateService` (a read-only
  façade) and never on the fetcher, engine, normalizer, store or the alert evaluator.
* **STEP 3 — Domain.** Types (`MarketIntelligenceSnapshot`, `SymbolIntelligence`, `MarketSummary`,
  `MarketIntelligenceFreshness`), the transformation service and the summary reducer were implemented
  with strong typing (no `any`, no magic numbers) and their own specs.
* **STEP 4 — Presentation.** `src/bot/ux/market-format.ts` renders the four screens; it formats only —
  it computes no market truth, validates nothing and mutates nothing. Unit conversion happens here and
  here only.
* **STEP 5 — UX.** The hub gained three entries plus the existing refresh, wired through the existing
  callback-data/ownership/keyboard conventions; every screen was rendered for real in the live rig (§19.4).
* **Tests → Quality → Review.** Specs/first-pass gate runs, then the second-pass re-verification, then
  `git status` / `git diff` review for junk files and scope creep (§§19–§20).

## 4. Files Changed

Phase 4 is a single commit: **28 files, +3108 / −200** versus the Phase 3 commit.

| Area | Files |
| --- | --- |
| New domain module | `src/intelligence/market-intelligence.types.ts`, `market-intelligence.service.ts`, `market-summary.ts` (+ `market-intelligence.spec.ts` 32 tests, `market-summary.spec.ts` 4) |
| Presentation | `src/bot/ux/market-format.ts` (+ `market-format.spec.ts` 21 tests) |
| Shared formatting | `src/common/money.ts` (Persian percent-sign support, Phase 1–3 callers unchanged) |
| UX wiring | `src/bot/ux/bot-ux.service.ts`, `market-view.service.ts`, `ux-keyboards.ts`, `callback-data.ts`, `ux-view.types.ts`, `ux-format.ts`, `ux-event-log.service.ts` (+ updated specs: `bot-ux.service.spec.ts`, `market-flow.integration.spec.ts`, `market-view.service.spec.ts`, `markup-integrity.spec.ts`, `ux-format.spec.ts`, `favorites.integration.spec.ts`) |
| Wiring | `src/app.module.ts` (module registration only) |
| E2E / doubles | `test/market-intelligence.e2e-spec.ts` (new, 7 tests), `test/bot-ux.e2e-spec.ts`, `src/testing/test-doubles.ts` |
| Docs | `README.md` (§4.4), `docs/PHASE_4_AUDIT.md`, `docs/PHASE_4_REPORT.md` (this file) |

No file was deleted, no dependency changed, no `.env` key added, no migration required.

## 5. Architecture and Data Flow

```
Phase 1 cron ──fetch──▶ validate/normalize ──▶ MarketStateService (single source of truth)
                                                   │  getState(def, now) → SymbolMarketState|null
                                                   │  daily {open, high, low, current, change}
                                                   │  updatedAt, previousPrice, ageMs, staleAfterMs
                                                   ▼
                                     MarketIntelligenceService.build(now)        [read-only]
                                                   ▼
                                     MarketIntelligenceSnapshot
                                     {generatedAt, freshness, symbols[], summary, hasData, hasStale, lastUpdate}
                                                   ▼
                                          market-format (format only)
                                                   ▼
                                          existing 📊 بازار hub screens
```

Hard invariants enforced by construction:

1. `MarketIntelligenceService` has no dependency that can perform I/O other than the in-memory
   `MarketStateService` read — it cannot fetch, cannot write, cannot validate.
2. The bot never calls the external price API. `↻ بروزرسانی` re-enters the same read-only path.
3. Formatters never compute market truth: every number they print arrives already computed in the
   snapshot; the only arithmetic allowed in the presentation layer is unit conversion.
4. One read of the market state per render, then a pure transformation; no per-symbol API or DB call,
   no background loop, no timer.

## 6. Daily Market Report Semantics (§6–§8)

For every symbol in the canonical registry:

| Field | Definition |
| --- | --- |
| `open` | the **first valid** price of the current Tehran day (Phase 1's own daily reset) |
| `current` | the **latest valid** price |
| `high` / `low` | the extremes of the valid prices of the day, in arrival order |
| `change` | `current − open` (absolute) |
| `changePercent` | `(change / open) × 100`, full precision; **`null` when `open` is 0**, displayed as `—` |

The first accepted update of a day sets `open = high = low = current` and therefore `change = 0` and
`changePercent = 0٪` — verified both as a unit test and on the live wire (§19.4: symbols whose only
valid price of the day was the cron update render `تغییر روزانه: ⚪ ۰ … | ۰٪`).

Screens: the compact report prints `اکنون` and `تغییر روزانه` per symbol; the detailed report
(`📋 گزارش کامل امروز`) adds `شروع روز`, `بیشترین`, `کمترین`. Rounding happens only at presentation;
never before.

## 7. Market Movement Semantics (§23–§26)

Movement compares the current valid price with the **previous valid** price of the same symbol — the
value Phase 1 keeps when it accepts a new price:

| Case | `movement` | `movementPercent` | Direction |
| --- | --- | --- | --- |
| current > previous | positive absolute | positive percentage | `UP` |
| current < previous | negative absolute | negative percentage | `DOWN` |
| current = previous | `0` | `0٪` | `UNCHANGED` |
| previous missing or 0 | `null` | `null` (shown `—`) | `UNKNOWN` |

`UNKNOWN` and the missing baseline are rendered explicitly (`— قیمت معتبر قبلی در دسترس نیست.` /
`بدون تغییر نسبت به آخرین بروزرسانی`), never as a fabricated zero. Movement is computed with
`calculatePriceChange` — the same Phase 1 helper already used by alerts — so a zero or invalid baseline
can never divide by zero and is reported as unknown.

## 8. Daily Change vs. Movement: Two Different Baselines (§27)

The two numbers are deliberately **different** and must never be conflated:

* daily change baseline = the **open of the Tehran day**;
* movement baseline = the **previous valid price** (the last accepted value before the current one).

Both are shown side by side in the live run with different labels — `تغییر روزانه` vs
`… نسبت به آخرین بروزرسانی` — and with different values, which is exactly the evidence that they are
not one number rendered twice:

| Symbol | Daily change (vs open) | Movement (vs previous valid) |
| --- | --- | --- |
| طلای ۱۸ عیار | `+۴۰۰٬۰۰۰ ریال | +۲٫۲۹٪` (open 17,500,000) | `+۲۸۰٬۰۰۰ ریال | +۱٫۵۹٪` (previous 17,620,000) |
| 🇺🇸 دلار آمریکا | `+۶٬۰۰۰ ریال | +۰٫۵۷٪` (open 1,052,000) | `+۳٬۰۰۰ ریال | +۰٫۲۸٪` (previous 1,055,000) |
| سکه امامی | `+۲۰۰٬۰۰۰ ریال | +۰٫۲۲٪` | `بدون تغییر` (previous = current) |

Integration tests assert on the same fixture that the two bases produce two distinct values, and that
changing one does not change the other.

## 9. Market Summary (§24, §30)

The summary is a pure reducer over the same snapshot: counts of `افزایشی` (UP), `کاهشی` (DOWN),
`بدون تغییر` (UNCHANGED) and `نامشخص` (UNKNOWN). It never classifies, ranks, scores or advises, and it
counts movement direction — never a mix of daily change and movement. Live output after the cron:

```
📈 افزایشی: ۲ · 📉 کاهشی: ۰ · ⚪ بدون تغییر: ۱ · ◽ نامشخص: ۱۳
```

(2 + 0 + 1 + 13 = 16 = the full registry; the 13 unknowns are the symbols whose previous valid price is
still unknown plus the symbols Phase 1 has no valid price for.)

## 10. Data Availability, Partial Data and the No-Fabrication Rule (§19–§20, §62)

* Symbols without a valid price render an explicit unavailable line
  (`⚠️ فعلاً اطلاعات معتبری در دسترس نیست.`) in the report and in movement, and `— بدون داده معتبر` in
  last update. No placeholder number is ever printed.
* A stale symbol (Phase 1's `PRICE_STALE_AFTER_MINUTES`) still shows its last valid price plus an
  explicit staleness badge (`⚠️ کهنه` / `⚠️ قیمت جدیدی برای این نماد دریافت نشده است.`).
* Partial markets are first-class: the report, movement and last-update screens all render correctly
  when only some symbols are valid (proved on the live wire — 10 of 16 symbols had data, 6 did not).
* Data rejected or flagged anomalous by Phase 1 **never** enters any report: the intelligence layer
  reads the validated state only and has no access to raw payloads.
* No fabrication anywhere: no invented timestamps, no interpolation, no carried-forward price presented
  as fresh, and no number computed from anything other than accepted state.

## 11. Freshness, Staleness and "Last Update" (§12–§18)

Per symbol, the last-update screen shows the real timestamp of the accepted price (Asia/Tehran) and one
of four states. Aggregated over the whole snapshot, `MarketIntelligenceFreshness` is derived by
`freshnessOf(summary)`:

| Snapshot state | Condition |
| --- | --- |
| `UNAVAILABLE` | no symbol has any valid price |
| `STALE` | every available symbol is stale |
| `PARTIAL` | some symbols are stale and/or unavailable alongside fresh ones |
| `FRESH` | all symbols available and fresh |

There is exactly one freshness mechanism: the thresholds are Phase 1's own (45 minutes for STALE, plus
the per-symbol overrides from Phase 1's configuration). The intelligence layer does not define its own
threshold, does not re-evaluate freshness on a timer and does not change `updatedAt` on refresh. The
`🕐` stamp printed under each symbol is that symbol's own accepted-price timestamp, not the render time.

## 12. Symbol Source, Canonical Order, Units (§21–§22, §36)

The section list comes from the Phase 1 **canonical symbol registry** — there is no second symbol list
anywhere in the bot. Order on every screen is the registry order (اونس جهانی، طلای ۱۸ عیار، طلای ۲۴
عیار، آبشده نقدی، سکه امامی، سکه تمام بهار، نیم سکه، ربع سکه، سکه گرمی، تتر (فی)، 🇺🇸 دلار آمریکا،
🇪🇺 یورو، 🇬🇧 پوند، 🇹🇷 لیر ترکیه، 🇦🇪 درهم امارات، 🇨🇳 یوآن چین), and is asserted deterministically in
tests regardless of the insertion order of the state map. Unit conversion happens once, at presentation
(`ریال` for domestic symbols, `دلار` for اونس جهانی), using the Phase 1 daily-reset and persistence
semantics rather than any Phase 4 re-implementation.

## 13. Presentation Layer: Formatting Rules (§30–§38)

* Signs: `+` for positive, `−`/`-` for negative, `0` for zero, `—` for unknown.
* Percent sign: Phase 4 screens use the Persian `٪` (via the new `formatPercentSignFa`); the shared
  `formatPercentFa(raw, suffix)` keeps `'%'` as its default so Phase 1–3 screens are byte-identical to
  before. `market-format.ts` is the only place that chooses the suffix.
* Thousands separator `٬` (e.g. `۱۷٬۵۰۰٬۰۰۰ ریال`) via Phase 1's money formatter; `٫` decimal separator.
* Every screen is HTML-escaped through the existing escape helper; no user-controlled text is ever
  interpolated raw; markup integrity is covered by 28 dedicated tests.
* `formatMarketHub`, `formatDailyReportScreen(view, unit, {detailed})`, `formatMovementScreen`,
  `formatLastUpdateScreen` are pure functions of the snapshot: same input → byte-identical output.
* `— ` and the em-dash/emoji vocabulary were chosen so that "unknown" is visually distinct from "0".

## 14. Bot UX, Screens and Navigation (§29–§31)

`📊 بازار` (Phase 2 hub) is the single entry point and now offers:

```
[📊 گزارش امروز]      [📈 حرکت بازار]
[🕐 آخرین بروزرسانی]
[↻ بروزرسانی]
[⬅️ بازگشت]           [🏠 منوی اصلی]
```

* The daily report adds `[📋 گزارش کامل]` to toggle the detailed view; every Phase 4 keyboard keeps
  `[⬅️ بازگشت]` and `[🏠 منوی اصلی]` so the existing navigation grammar is unchanged.
* Callback data follows the existing `v1:screen:*` convention and registry symbol keys only; callback
  ownership (only the pressing user's own view is edited) is enforced by the same Phase 2 code path.
* Each render emits one structured UX event (existing `ux-event-log.service.ts`), so renders are
  observable in logs without secrets and without noise.
* Unavailable / stale / partial states have dedicated, friendly Persian copy; the user never sees a
  crash, an empty message, or "undefined".

## 15. Refresh Semantics and Performance (§15, §41–§43)

`↻ بروزرسانی` executes exactly: **read state → build snapshot → render**. It:

* does **not** call the external price API (verified on the wire: total `GET /prices` count stayed at
  **1** across five refresh presses and a process restart);
* does **not** modify prices, daily aggregates, `lastUpdatedAt` or freshness (verified live:
  `۲۰:۰۰` before → `۲۰:۰۰` after, and in tests by asserting `lastUpdatedAt` is unchanged);
* does **not** trigger alerts and does **not** touch favorites;
* performs one market-state read and a deterministic transformation — no per-symbol calls, no new
  infrastructure, no background work, no cache.

Performance therefore equals the cost of an in-memory read plus string formatting; nothing in Phase 4
amortizes, schedules or polls.

## 16. Failure Isolation and Security (§45)

* A read failure is contained: the screen renders the friendly unavailable text
  (`⚠️ دریافت اطلاعات بازار با مشکل مواجه شد.` / `⚠️ در حال حاضر اطلاعات معتبر بازار در دسترس نیست.`)
  instead of a crash or an empty message; the technical detail is logged with a diagnostic context.
* Per-symbol failures degrade per symbol only — one broken symbol cannot blank the whole report.
* Only registry-validated symbols are accepted on callback paths; unknown or tampered symbol keys are
  ignored rather than rendered.
* Callbacks are owner-scoped (a user can only press and edit their own view).
* Logs contain no secrets and no token material; the snapshot debug log records counts and freshness
  (per-snapshot, one line), never payloads.
* No new attack surface was added: no new endpoint, no new inbound command, no new dependency.

## 17. Compatibility with Phases 1–3 (§44, §57)

* **Phase 1 stays the only price truth.** Phase 4 adds no fetcher, no validator, no store, no second
  cache, no second daily reset and no second freshness mechanism; it reuses `getState`, the daily
  aggregates, the persisted state file and the same thresholds.
* **Phase 3 alerts are untouched.** The intelligence layer never evaluates an alert, never triggers a
  notification and never duplicates Phase 3's evaluation: alerts continue to fire from the validated
  update flow (the live run shows exactly one publication from the real cron and no alert-side change).
* **Phase 0–2 screens are unchanged.** The hub's existing entries, favorites, settings and help screens
  behave exactly as before; the full Phase 0–3 test suites remain green (42 suites / 639 tests).
* **Restart** behaves per Phase 1 persistence: the state is restored from disk and every Phase 4 screen
  renders from it (verified live, with zero extra price fetches).

## 18. Configuration, Logging and Documentation (§58–§60)

* **No new configuration**: no new environment variable, no new file, no new flag. Behaviour is driven
  by Phase 1's existing configuration (`PRICE_STALE_AFTER_MINUTES`, the per-symbol thresholds) and the
  registry.
* **Logging**: one structured debug line per snapshot (symbol counts, freshness, symbols with data) and
  a warn line on a state-read failure; the message carries a diagnostic context and no secrets.
* **Code quality**: strong typing end-to-end (no `any`), no magic numbers (all thresholds/limits come
  from configuration or the registry), small single-responsibility services
  (`MarketIntelligenceService` = read+transform, `market-summary.ts` = reducer, `market-format.ts` =
  render), no hidden coupling to the alert subsystem.
* **Docs**: `README.md` §4.4 documents the report semantics, the daily-vs-movement distinction, the
  freshness rules, partial-data behaviour, the symbol source and order, the Tehran timezone handling and
  the refresh guarantee; `docs/PHASE_4_AUDIT.md` documents the audit and decisions.

## 19. Tests and Quality Gates (§46–§57, §64–§65)

### 19.1 Required scenarios (§46–§56) — all covered

| Requirement | Where |
| --- | --- |
| daily change positive / negative / zero | `market-intelligence.spec.ts` |
| zero open → `null` (no division by zero) | `market-intelligence.spec.ts` |
| movement UP / DOWN / UNCHANGED / UNKNOWN | `market-intelligence.spec.ts`, `market-format.spec.ts` |
| previous price 0 → unknown, never 0٪ | `market-intelligence.spec.ts` |
| first update of a day sets open=high=low=current, change 0 | `market-intelligence.spec.ts`, `market-flow.integration.spec.ts` |
| invalid / rejected data never enters a report | `market-intelligence.spec.ts`, `market-flow.integration.spec.ts` |
| high/low sequence 100 → 110 → 105 → 90 | `market-intelligence.spec.ts` |
| Tehran day reset | `market-intelligence.spec.ts` (new-day window test) |
| partial data | `market-intelligence.spec.ts`, `market-format.spec.ts`, e2e |
| stale symbol | `market-intelligence.spec.ts`, `market-format.spec.ts` |
| refresh keeps `lastUpdatedAt` and never fetches | `market-flow.integration.spec.ts` |
| deterministic symbol order (canonical registry) | `market-intelligence.spec.ts`, `market-format.spec.ts` |
| restart keeps data (Phase 1 persistence) | `test/market-intelligence.e2e-spec.ts`, live rig |
| Phase 0–3 regression (§57) | all 42 suites |

### 19.2 Test counts on the frozen tree

* `npx jest` → **42 suites, 639 tests, all passing**.
* `npm run test:e2e` → **4 suites, 25 tests, all passing**.
* Focused: `market-intelligence.spec.ts` 32, `market-summary.spec.ts` 4, `market-format.spec.ts` 21,
  `market-flow.integration.spec.ts` 12, `markup-integrity.spec.ts` 28, `bot-ux.service.spec.ts` 48,
  `market-view.service.spec.ts` 9, `ux-format.spec.ts` 22, `test/market-intelligence.e2e-spec.ts` 7.

### 19.3 Coverage (whole repository, `npm run test:cov`)

Lines **93.43 %**, statements **93.42 %**, functions **95.05 %**, branches **84.00 %**.
New modules: `market-intelligence.service.ts` statements 100 % / branches 93.47 %, `market-summary.ts`
100 % across the board, `market-format.ts` lines 100 % / branches 87.67 %, `market-view.service.ts`
lines 96.77 %, `money.ts` 100 %.

### 19.4 Live runtime verification (the frozen tree, real clock)

A wire-level rig ran the built application against mock Bale/price endpoints with **no seeded state**,
then on the real cron:

1. **Empty state**: `📊 گزارش امروز` answered `⚠️ در حال حاضر اطلاعات معتبر بازار در دسترس نیست.` with
   **0** price fetches — nothing invented.
2. **Restored state**: the app restored the state a previous run left in Phase 1's own persisted
   format (`Restored market state for 3 symbol(s)`) and the last-update screen listed them fresh.
3. **Real cron**: at **20:00 Tehran (16:30:00.1xxZ)** the real half-hourly job published
   `10 validated price(s) approved for publication` — with **exactly one** `GET /prices` in the whole run.
4. **Report values**: طلای ۱۸ عیار `اکنون ۱۷٬۹۰۰٬۰۰۰ | +۴۰۰٬۰۰۰ ریال | +۲٫۲۹٪`, delار `+۶٬۰۰۰ | +۰٫۵۷٪`,
   سکه امامی `+۲۰۰٬۰۰۰ | +۰٫۲۲٪`, three symbols with a single price of the day showing `۰ … | ۰٪`, six
   symbols showing the explicit unavailable line, summary `افزایشی: ۲ · کاهشی: ۰ · بدون تغییر: ۱ · نامشخص: ۱۳`.
5. **Movement**: `طلای ۱۸ عیار 🟢 +۲۸۰٬۰۰۰ ریال | +۱٫۵۹٪` (previous `۱۷٬۶۲۰٬۰۰۰`), `سکه امامی بدون
   تغییر`, `دلار 🟢 +۳٬۰۰۰ ریال | +۰٫۲۸٪` (previous `۱٬۰۵۵٬۰۰۰`) — visibly different from the daily
   numbers of the same moment.
6. **Refresh**: `🕐` stayed `۲۰:۰۰ → ۲۰:۰۰` and the price-call counter stayed `1 → 1` (checked again 5 s
   after the render); **restart** re-rendered everything with the counter still at `1`.
7. **Wire summary**: `priceCallsTotal 1`, `ignoredPortProbes 1` (platform health check), `publicationLines 1`,
   `reportRenders 18`.

Full transcript, including verbatim screens: `/home/user/phase4-runtime-transcript.md`.

### 19.5 §71 hard rules

Verified before completion: no fabricated data (every number traced to accepted state), no bypass of
Phase 1, no second market state/cache, no API call from the bot UI/refresh, no alert triggering from
intelligence, no rounding before presentation, no advice/forecast, no new dependency, no new
infrastructure, deterministic outputs, explicit unavailable states, documented semantics, all tests
kept and passing (none skipped or weakened), and every reported command actually executed (§65).

## 20. Repository, Delivery Status and Readiness for Phase 5

* **Scope review (§§66–§67)**: `git status` shows only the intended files — sources, specs, docs — with
  no temporary, debug or generated junk tracked; `git diff` was reviewed file by file; no out-of-scope
  change was made and no required change was left uncommitted.
* **Commit**: Phase 4 is one commit on top of the Phase 3 commit, storing the phase as a single unit.
* **Push: BLOCKED** — no credentials are available in this environment. `git push origin main` over
  HTTPS fails with `fatal: could not read Username for 'https://github.com'` and over SSH with
  `Could not read from remote repository`. Nothing was fabricated to hide this: delivery is via the
  patch/bundle artifacts listed in `/home/user/PUSH-INSTRUCTIONS.md`.
* **Delivery artifacts** (regenerated after the final commit; clone/`git am`/fetch verification of the
  bundle → all-phases patch chain re-run): `phase4-atabak-gold.patch` + `.bundle` for the phase delta on
  top of the Phase 3 commit, and `atabak-gold-all-phases.patch` + `.bundle` for the complete history.
* **Phase 5 readiness**: the intelligence layer is self-contained, read-only and deterministic; its
  snapshot type and `build(now)` entry point are the stable seam any later phase would consume, and
  nothing in Phase 4 assumes a specific cron cadence, storage backend or platform.

**PHASE 4 COMPLETE — READY FOR PHASE 5**

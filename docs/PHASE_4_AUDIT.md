# PHASE 4 AUDIT — 📊 Market Intelligence (Atabak Gold)

Written **before** any Phase 4 code was added, on top of commit `499b229` (Phases 0–3 complete).
The audit answers one question: *given what already exists, what does Phase 4 actually have to add?*

---

## 1. What was inspected

| Area | Files (actual names in this repository) |
| --- | --- |
| Market domain (Phase 1) | `src/market/market.types.ts`, `market-state.service.ts`, `market-state.store.ts`, `market-engine.service.ts`, `sanity-checker.service.ts`, `price-normalizer.service.ts`, `raw-payload.parser.ts`, `price-change.calculator.ts`, `price-format.ts`, `symbols.ts` |
| Market transport | `src/price/price.service.ts`, `src/price/price.error.ts` |
| Bot UX (Phase 2) | `src/bot/ux/bot-ux.service.ts`, `market-view.service.ts`, `ux-format.ts`, `ux-view.types.ts`, `ux-keyboards.ts`, `callback-data.ts`, `ux-event-log.service.ts`, `number-input.ts` |
| Alerts (Phase 3) | `src/alerts/*` |
| Platform layer | `src/platform/platform-registry.service.ts`, `platform-adapter.ts`, `bot-api.client.ts`, `update-poller.service.ts` |
| Users / persistence | `src/users/user.types.ts`, `user.store.ts`, `user.service.ts` |
| Config / tests / tooling | `src/config/app-config.service.ts`, `env.validation.ts`, `src/testing/test-doubles.ts`, `jest` config in `package.json`, `test/` e2e rig, `Dockerfile`, `docker-compose.yml`, README, `docs/PHASE_{0,1,2,3}_*` |
| Phase 3 runtime | `dist/main.js` boot, `MarketEngineService.registerUpdateListener` hook, `AlertStore` |

## 2. Existing architecture (as it really is)

```
PriceService.fetchRawPayload()                  ← the only code that touches the external API
   → RawPayloadParser → PriceNormalizerService → SanityCheckerService
   → MarketEngineService.evaluateCycle()        ← accept / reject per symbol, anomaly thresholds
        ├─ MarketStateService.commit()          ← ONLY place holding accepted prices
        │     per symbol: currentPrice, previousPrice, lastValidPrice, updatedAt,
        │                 lastSuccessfulUpdate, dayKey, direction, percentageChange,
        │                 absoluteChange, daily {open, high, low, current, change}
        │     freshness: FRESH/STALE from `PRICE_STALE_AFTER_MINUTES` (config.staleAfterMs)
        │     day rollover: `rollDayIfNeeded(tehranDayKey(now))` — Asia/Tehran, daily window reset
        ├─ MarketStateStore.persist()           ← atomic JSON (MARKET_STATE_FILE), restored on boot
        ├─ notifyListeners(accepted)            ← Phase 3 alerts listen here
        └─ buildPublishablePrices()             ← channel publication
   → BotUxService (Phase 2 router)  → MarketViewService (read-only projection)  → ux-format → adapter
```

Key facts that shaped Phase 4:

| # | Fact | Consequence for Phase 4 |
| --- | --- | --- |
| C1 | `MarketStateService` already exposes everything Phase 4 needs per symbol: validated `currentPrice`, `previousPrice` (previous **accepted** price of the same Tehran day), `daily{open,high,low,current,change}`, per-symbol `updatedAt`, `lastSuccessfulUpdate`, `freshness`, `ageMs`. | Phase 4 needs **no new persistence, no new price store, no new threshold**. It derives descriptive values from one read pass. |
| C2 | `calculatePriceChange(current, baseline)` (Phase 1) already implements "absolute + percentage + direction, `null`/`UNKNOWN` when the baseline is missing, non-finite or `≤ 0`". | Daily change (`baseline = open`) and market movement (`baseline = previous`) must both call it — §25's "reuse, do not duplicate". |
| C3 | `MarketViewService` is documented as "the only market dependency of the bot UX", builds view models and cannot mutate state or reach `PriceService`. | Phase 4's snapshot is built the same way; the service is extended, not bypassed. |
| C4 | The `📊 بازار` screen (Phase 2) renders `formatMarketSnapshot()` for the **anchor** (`required`) symbols only: `شروع روز / اکنون / بیشترین / کمترین / تغییر`. | §29 asks it to become the Phase 4 hub; the daily content it shows today must survive as the *detailed* report. |
| C5 | That formatter computes the daily percentage **itself**: `open === 0 ? null : (change / open) * 100`. | Violates §32 (formatter must not compute market truth). Phase 4 must move this into the domain snapshot. |
| C6 | Refresh already exists: `screenFooter({ refreshScreen })` re-renders the *same* screen from existing state — `callbackDataForScreen(screen)`. | §15/§43 are satisfied structurally; Phase 4 must keep it and **prove** it with a test (timestamp unchanged, zero provider calls). |
| C7 | Market movement (current vs previous) is **not rendered anywhere** today; the daily change is. | Phase 4 adds the movement layer + the "do not conflate the two" distinction (§23). |
| C8 | Partial data: `formatPriceScreen` lists missing symbols as a single `ℹ️ بدون اطلاعات معتبر: …` line and skips symbols without state. | §20 wants an explicit per-symbol unavailable state in the report; §8 "never fabricate" already holds. |
| C9 | Stale handling: `hasStale` + `formatStaleNotice()` ("آخرین قیمت معتبر …") is shown at the top of price screens. | §16–§18 want freshness to be *per symbol* in the intelligence screens; the existing notice wording stays. |
| C10 | Registry `symbolRegistry` (config) is the canonical symbol source, already in publication order (`gold → coins → currency`) with `required` flags; `SECTION_NAMES` gives plain titles. | §21/§22: iterate the registry; never hard-code a list in the formatter. |
| C11 | `callback-data.ts` is a pure versioned grammar with `ScreenKey`; `ux-keyboards.ts` builds keyboards; `bot-ux.service.ts` has one `renderScreen` switch and a `parentOf` map for `⬅️ بازگشت`. | New screens = one `ScreenKey` each + a `renderScreen` case + a `parentOf` entry. No second navigation system. |
| C12 | Phase 3 alerts read the same market state through their own listener; they never render prices. | Phase 4 must not touch alert evaluation, and must not trigger anything. |
| C13 | Tests: 39 unit suites (`npx jest`), e2e rig in `test/` with `setup-env.ts` isolation, `markup-integrity.spec.ts` guards HTML escaping on every screen, `test:cov` available. | New logic gets unit + integration + e2e coverage, and every new screen is added to the markup-integrity scenario list. |

## 3. What Phase 4 must add (and what it must not)

**Add**

1. `src/intelligence/` — a Market Intelligence layer that builds a **read-only snapshot**:
   per-symbol `availability` (`AVAILABLE`/`STALE`/`UNAVAILABLE`), validated `current`/`previous`,
   daily `open/high/low`, `dailyChange` + `dailyChangePercent`, `movement` + `movementPercent` +
   `movementDirection`, per-symbol `lastUpdatedAt`, plus a deterministic summary
   (increasing/decreasing/unchanged/unknown).
2. Four Phase 4 screens behind `📊 بازار`: `📊 گزارش امروز` (compact), `📋 گزارش کامل` (detailed),
   `📈 حرکت بازار`, `🕐 آخرین بروزرسانی` — each with the existing refresh/back/home footer.
3. Presentation for those snapshots in `ux-format.ts` (no arithmetic there), with explicit
   unavailable/stale handling.
4. Tests: unit matrix (§46–§55), integration (screens, refresh, no provider call), e2e journey,
   markup integrity for the new screens, regression of Phases 0–3.
5. Docs: README section for the market intelligence semantics + this audit + the Phase 4 report.

**Replace (not duplicate)**

* `MarketViewService.buildMarketSnapshot()` and `formatMarketSnapshot()` (anchor-only, percentage
  computed in the formatter) are superseded by the intelligence snapshot + its formatters. They will be
  removed and the specs that covered them updated to assert the equivalent Phase 4 behaviour (the
  detailed report keeps showing open/current/high/low/change).

**Not to be touched**

* `PriceService`, parser, normalizer, sanity checker, anomaly thresholds, `MarketEngineService`
  accept/reject logic, `MarketStateService` commit/rollover semantics, `MarketStateStore` format,
  Phase 3 alert engine, alert store, notification service, user store, platform adapters.
* No new dependency, no Redis/queue/warehouse, no historical price table, no second market state,
  no caching layer, no background loop (§4, §41, §42, §61, §68).

## 4. Design decisions taken before coding

| Decision | Rationale |
| --- | --- |
| Snapshot is built by **one pass** over the registry, reading `MarketStateService.getState()` once per symbol → `one market-state read` (§42). | No N+1, no caching, no polling. |
| `generatedAt` (when the snapshot was rendered) is **kept separate** from `lastUpdatedAt` (when the accepted price arrived). Only the latter is ever displayed as market time (§12, §15, §54). | Makes the "refresh must not fake a timestamp" rule testable. |
| Movement uses `state.previousPrice` (previous accepted price, same Tehran day) and is `UNKNOWN` when it is `null`; the daily window is independent. | §23: daily change ≠ market movement; §26: only validated prices. |
| Summary counts the **movement** directions, with `unknown` as its own bucket (never merged into `unchanged`). | §28 allows a descriptive summary; merging unknown into unchanged would be a fabricated claim. |
| Symbols with no validated state are `UNAVAILABLE` with `null` values (not omitted from the model) and are rendered explicitly; the report never fails as a whole (§20, §39, §52). | Partial data support without inventing values. |
| New `ScreenKey`s `report`, `report-full`, `movement`, `last-update`; `market` becomes the hub; `parentOf(…)` sends all four back to `market`. | Reuses the Phase 2 navigation primitive (§11 of the Phase 2 spec, §29 here). |
| All Phase 4 configuration comes from existing values (`displayUnit`, `staleAfterMs`, registry). No new environment variable. | §68/§58: no magic numbers, no configuration for configuration's sake. |

## 5. Decisions taken while implementing (and why they differ from the plan above)

| # | Decision | Reason |
| --- | --- | --- |
| D1 | The Phase 4 formatters live in a new module `src/bot/ux/market-format.ts` instead of being added to `ux-format.ts`. | Keeps the Phase 2 presentation module small (§59/§60); `ux-format.ts` only gained an exported `tidy()` so the whitespace rule stays in one place. |
| D2 | `MarketViewService.buildIntelligence()` / `buildSymbolIntelligence()` were added and the Phase 2 anchor formatter (`buildMarketSnapshot` + `formatMarketSnapshot` + `formatSnapshotLine` + their view types) was **removed**. | The old formatter computed `(change / open) * 100` inside the presentation layer, which §32 forbids; the detailed Phase 4 report shows exactly the same fields (open/current/high/low/change) from the domain snapshot, so nothing the user could see was lost, and its specs were rewritten to assert the equivalent (stronger) behaviour. |
| D3 | A failing `MarketStateService.getState()` for one symbol is caught per symbol: that symbol is reported `UNAVAILABLE`, the technical reason is logged, the rest of the report renders. | §45 (friendly screen, no crash, no leak) + §52 (partial data). The router's existing outer error screen (`⚠️ دریافت اطلاعات بازار با مشکل مواجه شد.`) stays as the safety net for anything else and remains covered by its Phase 2 test. |
| D4 | Phase 4 renders percentages with the Persian sign `٪`, while the Phase 1–3 screens keep `%`. | The Phase 4 spec asks for `٪` (§37); the shared `formatPercentFa` gained an optional suffix (default `%`, so no existing screen changes) and `formatPercentSignFa` wraps it — one implementation, two glyphs, zero drift in sign/rounding rules. |
| D5 | `MarketSummary.unknown` counts symbols whose *movement* is unknown; availability is counted in its own three buckets. | Prevents "no previous price" from being reported as "unchanged" (§25) and keeps the summary purely arithmetic (§28). |
| D6 | Event log names `market_report_view`, `market_movement_view`, `market_last_update_view` were added to the existing `UxEvent` union. | Keeps one observability vocabulary; no new logging framework. |
| D7 | The e2e spec for the market intelligence deletes the throw-away market-state file in `beforeEach`. | The e2e app shares `MARKET_STATE_FILE` across tests within a run; without isolation, day-window assertions would depend on test order (the same class of bug the date-dependent Phase 3 test had). The restart test still exercises real persistence, because it restarts *inside* the test. |
| D8 | No new environment variable, no new dependency, no second market state, no cache, no background loop. | §5, §41, §42, §61, §68 — everything needed already exists in Phase 1 configuration (`displayUnit`, `staleAfterMs`, `symbolRegistry`). |

## 6. Second-pass additions (after re-reading the phase spec end to end)

| # | Addition | Spec |
| --- | --- | --- |
| D9 | `MarketIntelligenceSnapshot.freshness` — an **aggregate** freshness state (`FRESH` / `STALE` / `PARTIAL` / `UNAVAILABLE`) derived only from Phase 1's per-symbol freshness and the registry, with no second threshold. | §16, §34 ("freshness state" on the snapshot; `PARTIAL` is an explicit concept) |
| D10 | The movement screen now renders the **absolute movement** next to the percentage (`🟢 +۱۰۰٬۰۰۰ ریال | +۰٫۵۷٪ نسبت به آخرین بروزرسانی`). | §3C ("absolute movement … percentage movement") |
| D11 | Snapshot generation logs one `debug` line with counts (`fresh / stale / unavailable` + aggregate state); a snapshot without any validated symbol is still a `warn`. | §59 (diagnosable without secrets; no excessive logging — `debug` only) |
| D12 | Tests strengthened for §51 (a new Tehran day starts a **new** daily window from its first accepted price) and §53 (a stale symbol keeps its real `lastUpdatedAt`). One extra test pins all four aggregate freshness states. | §51, §53, §16 |

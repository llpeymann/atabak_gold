# PHASE 1 — AUDIT OF THE CURRENT PRICE ARCHITECTURE

> Required by Step 3 of the Phase 1 instructions. Performed before any code change, against the actual
> repository state after Phase 0 (commit `99bc75c`).
> Date: 2026-09-30 · Scope audited: `src/`, `package.json`, `tsconfig*.json`, `test/`, `docs/`

---

## 1. How the external API is called

`PriceService.getMarketData()` → `HttpService.get(PRICE_API_URL, { timeout: PRICE_API_TIMEOUT_MS, headers })`
through `firstValueFrom`, with a bounded retry loop (max 3 attempts, exponential backoff) added in Phase 0.
Errors are wrapped in `PriceApiError` with a `retryable` flag (5xx/429/timeout retryable, 4xx permanent).

## 2. What the raw API response looks like

Not documented anywhere in the repository and not verifiable from here (no live URL/token). The only contract
that exists today is the implicit one the code consumes:

```json
{
  "gold":     [ { "symbol": "IR_GOLD_18K", "name": "…", "price": 17981900, "change_percent": 1.15 }, … ],
  "currency": [ { "symbol": "USD", "price": 1032000, "change_percent": 0.55 }, … ]
}
```

Optional extra members seen in the code history: `cryptocurrency` (never used). No source timestamp is read.

## 3–4. Which symbols exist and how they are named

Hard-coded **inside `price-message.builder.ts`** (Phase 0) — the only place they exist:

| Section | Symbols | Label |
| --- | --- | --- |
| gold | `XAUUSD` | اونس جهانی |
| gold | `IR_GOLD_18K`, `IR_GOLD_24K`, `IR_GOLD_MELTED` | طلای ۱۸ / ۲۴ عیار، آبشده نقدی |
| coins | `IR_COIN_EMAMI`, `IR_COIN_BAHAR`, `IR_COIN_HALF`, `IR_COIN_QUARTER`, `IR_COIN_1G` | سکهها |
| currency | `USDT_IRT`, `USD`, `EUR`, `GBP`, `TRY`, `AED`, `CNY` | ارزها |

Naming is `<MARKET>_<ASSET>_<VARIANT>` for Iranian instruments and plain ISO codes for currencies.

## 5. Which symbols are required

**None.** The current code treats every symbol as optional: a symbol missing from the payload is silently
absent from the published message, with no log, no rejection reason and no alert.

## 6. What unit the API returns

Unknown/undocumented. Phase 0 introduced `PRICE_API_UNIT` (default `RIAL`) and `PRICE_SYMBOL_UNITS`
for per-symbol overrides, so the unit is at least explicit and correctable — but the default remains an
assumption that has never been verified against the live payload. `XAUUSD` is quoted in **USD**, not Rial,
and there is no per-symbol unit in the domain model today.

## 7. How price values are parsed

`common/money.ts → parseAmount()` (numbers, numeric strings, Persian digits, Persian/Arabic separators),
then `toRial()`. Values that fail parsing are dropped with a warning (`normalizeItem` returns `null`).

## 8. Where price formatting happens

`common/money.ts → formatMoney(amountInRial, displayUnit)` (single source of truth, Phase 0) +
`formatPercentFa()`. `escapeHtml()` in `common/html.ts`. Both the channel message and the poster go through them.

## 9. How `lastPrices` currently works

Phase 0 replaced the old `Map<string, number>` with `bot/trend-tracker.ts`: each entry stores
`{ priceInRial, dayKey }`; `trendFor()` returns `unknown` when the stored entry belongs to another day;
`commit()` is called only after a message was actually delivered somewhere.

## 10. How current/previous prices are stored

Only as a single value per symbol (the last committed price) plus its day key. There is **no**
`currentPrice`/`previousPrice`/`lastValidPrice` separation, no `updatedAt`, no daily open/high/low.

## 11. Whether state survives restart

**No.** Everything is in memory (`TrendTracker.lastPublished`). A restart loses the comparison baseline and
would (after Phase 0 logic) simply produce `unknown` trends until the first delivery — no crash, but no
daily statistics exist to lose yet either.

## 12. How Cron obtains prices

`BotService` (`handleHalfHourlyPriceUpdate`, `handleDailyClosingPriceUpdate`, `handlePosterReport`) →
`runPublication()` (in-flight gate) → `PriceService.getMarketData()` → message/poster → `BaleService.sendMessage()`.

## 13. How prices reach the Publisher

Through `PriceMessageBuilder.build(data)` / `PosterService.generatePricePoster(data)`, which receive the
**raw normalized payload `MarketData`** directly. The publisher-facing objects are therefore derived from
unvalidated upstream data.

## 14. Whether Bale and Telegram consume the same price object

Yes. `BaleService.sendMessage(text)` renders one text and posts it to every enabled target
(`DeliveryResult[]` per platform since Phase 0).

## 15. Whether poster generation consumes the same price object

Almost: the poster receives the same `MarketData` object as the price message but renders its own
first-5-items-of-each-array layout (not the curated symbol lists).

## 16. Where comparison/change calculations happen

Percentage change is taken **from the API field `change_percent`** and displayed as-is (rounded in Phase 0).
Nothing in the application computes a change from two observations; the trend emoji is the only
application-side comparison (`TrendTracker`).

## 17. Whether any validation already exists

Phase 0 added: (a) payload-shape checks (object, `gold`/`currency` arrays), (b) per-item checks
(`symbol` present, `price` finite and `> 0`), (c) "no usable prices" → error. There is **no** schema
contract, no required-symbol concept, no per-symbol registry, no bounds, no anomaly detection, no
rejection reasons beyond a warning log.

## 18. Whether any anomaly protection already exists

**None.** A 10× price spike that is a finite positive number is currently accepted, published and used as
the trend baseline.

---

## Gap summary vs. the Phase 1 target pipeline

| Pipeline stage | Today | Phase 1 requirement |
| --- | --- | --- |
| Parse/Adapter | inline in `PriceService.normalizePayload` | explicit parser with schema contract |
| Normalizer | inline in the same method | separate normalizer with unit handling per symbol |
| Schema validation | partial, ad-hoc | explicit `INVALID_SCHEMA` outcome |
| Required symbols | not modelled | registry with `required` per symbol |
| Numeric validation | `parseAmount` + `> 0` guard | explicit `INVALID_NUMBER` / `INVALID_PRICE` outcomes |
| Bounds / sanity | none | per-symbol `min`/`max`, configurable |
| Anomaly detection | none | configurable change thresholds, `EXCESSIVE_CHANGE` |
| Market state | one price + dayKey | `currentPrice`, `previousPrice`, `lastValidPrice`, `updatedAt`, freshness |
| Daily statistics | none | `open`, `high`, `low`, `current`, `change`, Tehran reset |
| Persistence | none | minimal state file (state must survive restart) |
| Change calculation | API field only | deterministic `absoluteChange`/`percentageChange`/`direction` |
| Admin alert | none | anomaly alert + cooldown |
| Publishing gate | message builder accepts raw data | publisher receives only approved domain objects |

## Observations that shape the implementation

1. `MarketData`/`price.interface.ts` is the raw-payload-shaped model that currently doubles as the domain
   model — it must be replaced by a real internal contract (`NormalizedPrice`), and the raw shape must stay
   inside the parser.
2. The symbol lists in `price-message.builder.ts` must move to a central registry (single source of truth for
   label, section, required flag, unit and thresholds).
3. `TrendTracker` overlaps the coming `MarketState` (same "previous price on the same Tehran day" concern) —
   it must be absorbed, not duplicated.
4. Poster and price message both need to consume the *validated* update, so the engine output has to be a
   single publishable domain object.
5. `XAUUSD` needs its own unit (`USD`) in the domain model; conflating it with Rial-denominated instruments
   would make thresholds and bounds meaningless.
6. Nothing in the pipeline must require new infrastructure: a JSON state file is the minimum persistence
   needed for `lastValidPrice` and daily statistics to survive a restart.

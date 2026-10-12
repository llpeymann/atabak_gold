import {
  Freshness,
  MarketSection,
  PriceDirection,
  PriceUnit,
} from '../market/market.types';

/**
 * Phase 4 — Market Intelligence contracts (§34 of the phase specification).
 *
 * Phase 1 is the single source of price truth; everything below is a *descriptive* projection of
 * already-validated state. No field here may ever be produced by a calculation that invents market
 * data: when an input is missing, the field is `null` (or the direction `UNKNOWN`) and the
 * availability flag says why.
 */

/** Per-symbol state of the information, never of the market itself (§16, §19, §52). */
export type SymbolAvailability = 'AVAILABLE' | 'STALE' | 'UNAVAILABLE';

/**
 * Freshness of a whole snapshot (§16, §34). It reuses Phase 1's freshness decision per symbol and
 * only *aggregates* it — Phase 4 introduces no threshold of its own.
 *
 * - `FRESH`       every registry symbol has a fresh validated price
 * - `STALE`       there is data, but none of it is fresh
 * - `PARTIAL`     there is fresh data, but some symbols are stale or have no valid data at all
 * - `UNAVAILABLE` no registry symbol has a validated price
 */
export type MarketIntelligenceFreshness =
  'FRESH' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';

/**
 * One symbol inside a snapshot.
 *
 * `currentPrice`/`previousPrice`/`open`/`high`/`low` are always *accepted* Phase 1 values (or
 * `null`). `previousPrice` is the previous accepted price of the same Tehran day — the comparison
 * basis for market movement as opposed to the daily change (§23).
 */
export interface MarketSymbolSnapshot {
  symbol: string;
  label: string;
  section: MarketSection;
  unit: PriceUnit;
  availability: SymbolAvailability;
  /** Phase 1 freshness (`null` when the symbol has no state at all). */
  freshness: Freshness | null;

  currentPrice: number | null;
  previousPrice: number | null;
  open: number | null;
  high: number | null;
  low: number | null;

  /** `current - open` (Phase 1 daily statistics). `null` when the day has no window yet. */
  dailyChange: number | null;
  /** Full-precision `(current - open) / open * 100`; `null` when `open` is unusable (§7). */
  dailyChangePercent: number | null;
  dailyDirection: PriceDirection;

  /** `current - previous` — the last *valid* move, not the daily change (§23–§27). */
  movement: number | null;
  /** Full-precision `(current - previous) / previous * 100`; `null` when it cannot be computed. */
  movementPercent: number | null;
  movementDirection: PriceDirection;

  /** When the accepted price behind `currentPrice` was received (Asia/Tehran at render time). */
  lastUpdatedAt: string | null;
  /** Age of that update in milliseconds, as Phase 1 computed it (`null` without state). */
  ageMs: number | null;
}

/**
 * Descriptive counts (§28). Only counting — no interpretation, no advice.
 * `unknown` is its own bucket: a symbol whose previous valid price is unavailable is never
 * reported as "unchanged".
 */
export interface MarketSummary {
  increasing: number;
  decreasing: number;
  unchanged: number;
  unknown: number;
  available: number;
  stale: number;
  unavailable: number;
}

/**
 * A read-only snapshot of the market, rebuilt from Phase 1 state on every render.
 *
 * `generatedAt` is *not* market information: it is when this projection was created (used for logs
 * and debugging only). Every user-visible time comes from `lastUpdatedAt`/`lastUpdate`.
 */
export interface MarketIntelligenceSnapshot {
  generatedAt: string;
  /** Aggregate freshness of this snapshot (Phase 4 spec §16). */
  freshness: MarketIntelligenceFreshness;
  /** Symbols in canonical registry order (§22). */
  symbols: MarketSymbolSnapshot[];
  summary: MarketSummary;
  /** True when at least one symbol has usable (fresh or stale) validated data. */
  hasData: boolean;
  /** True when at least one symbol with data is stale. */
  hasStale: boolean;
  /** Newest `lastUpdatedAt` across symbols (a real accepted-price timestamp, never "now"). */
  lastUpdate: string | null;
}

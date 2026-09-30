import {
  Freshness,
  MarketSection,
  PriceDirection,
  PriceUnit,
} from '../../market/market.types';

/**
 * View models (Phase 2 §46).
 *
 * They carry *domain numbers and metadata only* — no formatted strings, no keyboard markup and
 * nothing platform-specific. Rendering them into Persian text is the formatter's job, which
 * keeps the domain layer free of presentation concerns (§45).
 */

export interface PriceView {
  symbol: string;
  label: string;
  section: MarketSection;
  /** Canonical value (as stored by Phase 1 — never converted here). */
  price: number;
  unit: PriceUnit;
  /** Full-precision percentage change from Phase 1 (`null` when unknown). */
  percentageChange: number | null;
  direction: PriceDirection;
  freshness: Freshness;
  /** ISO timestamp of the accepted price. */
  updatedAt: string;
}

export interface PriceSectionView {
  section: MarketSection;
  title: string;
  items: PriceView[];
}

export interface PriceListView {
  sections: PriceSectionView[];
  /** ISO timestamp of the newest accepted price across the shown symbols. */
  lastUpdate: string | null;
  /** True when at least one shown symbol is served from stale state. */
  hasStale: boolean;
  /** Number of symbols in the request scope that have no usable state at all. */
  missing: string[];
}

export interface MarketSnapshotLineView {
  symbol: string;
  label: string;
  section: MarketSection;
  unit: PriceUnit;
  open: number;
  high: number;
  low: number;
  current: number;
  /** `current - open` (from Phase 1 daily statistics). */
  change: number;
  freshness: Freshness;
  updatedAt: string;
}

export interface MarketSnapshotView {
  lines: MarketSnapshotLineView[];
  lastUpdate: string | null;
  hasStale: boolean;
}

export interface FavoriteOptionView {
  symbol: string;
  label: string;
  section: MarketSection;
  selected: boolean;
}

export interface FavoritesManageView {
  options: FavoriteOptionView[];
  limit: number;
  selectedCount: number;
  limitReached: boolean;
}

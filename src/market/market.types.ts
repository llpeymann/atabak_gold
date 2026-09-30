/**
 * Phase 1 domain model — the internal market contract.
 *
 * Raw API payloads never enter this layer: `RawPayloadParser` converts them into the
 * models below, which are the only price objects the rest of the application may use.
 */

/** Canonical unit in which a symbol's value is stored internally. */
export type PriceUnit = 'RIAL' | 'USD';

/** Unit in which the external API expresses a value (before normalization). */
export type SourceUnit = 'RIAL' | 'TOMAN';

export type MarketSection = 'gold' | 'coins' | 'currency';

/** Deterministic direction of an accepted price versus its comparison baseline. */
export type PriceDirection = 'UP' | 'DOWN' | 'UNCHANGED' | 'UNKNOWN';

/** Where the comparison baseline came from. */
export type BaselineSource = 'SAME_DAY' | 'PREVIOUS_DAY' | 'NONE';

/**
 * Rejection reasons — deliberately separated, because operational monitoring must be able to
 * tell an API incident (schema/connection) from a data incident (anomaly/number).
 */
export type RejectionReason =
  | 'INVALID_SCHEMA'
  | 'MISSING_SYMBOL'
  | 'UNKNOWN_SYMBOL'
  | 'INVALID_NUMBER'
  | 'INVALID_PRICE'
  | 'OUT_OF_RANGE'
  | 'EXCESSIVE_CHANGE';

/** A structural failure of the whole API response (no per-symbol evaluation possible). */
export class SchemaValidationError extends Error {
  readonly reason: RejectionReason = 'INVALID_SCHEMA';

  constructor(detail: string) {
    super(`Price API response is structurally invalid: ${detail}`);
    this.name = 'SchemaValidationError';
  }
}

/** A raw API entry after parsing — still untrusted. */
export interface RawPriceEntry {
  symbol: string;
  name: string | null;
  rawPrice: unknown;
  rawChangePercent: unknown;
}

/** A structurally valid, parsed payload. Nothing here is validated numerically yet. */
export interface ParsedRawPayload {
  entries: RawPriceEntry[];
  /** Timestamp reported by the source, when the payload provides one. */
  sourceTimestamp: string | null;
}

/** A normalized price: the internal contract every downstream component consumes. */
export interface NormalizedPrice {
  symbol: string;
  /** Value in the canonical unit of the symbol (see `PriceUnit`). */
  price: number;
  unit: PriceUnit;
  /** Unit the source expressed the value in. */
  sourceUnit: SourceUnit;
  /** Timestamp reported by the API, if any. Never confused with `receivedAt`. */
  sourceTimestamp: string | null;
  /** Timestamp at which this application received the payload. */
  receivedAt: string;
  /** Sanitized source identifier (host + path, no credentials/query string). */
  source: string;
}

/** The deterministic result of evaluating one raw symbol value. */
export interface PriceEvaluation {
  symbol: string;
  label: string;
  section: MarketSection;
  unit: PriceUnit;
  accepted: boolean;
  /** Present when `accepted` is false. */
  reason?: RejectionReason;
  /** Human readable context for logs/alert bodies. */
  detail?: string;
  /** Accepted value in the canonical unit. */
  price?: number;
  /** Value that was rejected (only when it was a usable number). */
  rejectedValue?: number;
  /** Baseline used for the comparison, if any. */
  previousPrice: number | null;
  baseline: BaselineSource;
  /**
   * Percentage threshold applied to this evaluation (the symbol's own documented tolerance,
   * or the configured fallback). `null` only when neither is configured — the percentage
   * check is then skipped and stated as such in the evaluation.
   */
  maxChangePercent: number | null;
  /** Absolute change against the baseline (null when no baseline exists). */
  absoluteChange: number | null;
  /** Full-precision percentage change (never rounded here; rounding happens at display time). */
  percentageChange: number | null;
  direction: PriceDirection;
  evaluatedAt: string;
}

/** Daily statistics for one symbol (reset at the Tehran day boundary). */
export interface SymbolDailyStats {
  open: number;
  high: number;
  low: number;
  current: number;
  /** `current - open`. */
  change: number;
}

export type Freshness = 'FRESH' | 'STALE' | 'UNKNOWN';

/** Complete per-symbol state held by the market state service. */
export interface SymbolMarketState {
  symbol: string;
  label: string;
  section: MarketSection;
  unit: PriceUnit;
  /** Latest accepted valid price. */
  currentPrice: number;
  /** The accepted price that precedes `currentPrice` (within the same Tehran day). */
  previousPrice: number | null;
  /** Most recent valid price — preserved when an update fails or is rejected. */
  lastValidPrice: number;
  /** When `currentPrice` was last written. */
  updatedAt: string;
  /** When the last successful (accepted) update happened — used for staleness. */
  lastSuccessfulUpdate: string;
  /** Tehran day of `currentPrice` (not necessarily the day of the latest cycle). */
  dayKey: string;
  direction: PriceDirection;
  percentageChange: number | null;
  absoluteChange: number | null;
  /**
   * Daily window of the current Tehran day. `null` means "no accepted price yet today":
   * yesterday's close is never used as today's open.
   */
  daily: SymbolDailyStats | null;
  freshness: Freshness;
  /** Milliseconds since `lastSuccessfulUpdate`. */
  ageMs: number;
}

/** A price that has passed the whole reliability pipeline and may be published. */
export interface PublishablePrice {
  symbol: string;
  label: string;
  section: MarketSection;
  unit: PriceUnit;
  price: number;
  /** Full-precision percentage change against the baseline (null when UNKNOWN). */
  percentageChange: number | null;
  direction: PriceDirection;
  dailyChange: number;
  dailyChangePercent: number | null;
}

/** The only object the publisher is allowed to receive. */
export interface PublishableMarketUpdate {
  publishable: boolean;
  /** Reason why nothing may be published (only when `publishable` is false). */
  blockingReason?: string;
  source: string;
  receivedAt: string;
  sourceTimestamp: string | null;
  dayKey: string;
  dateFa: string;
  timeFa: string;
  /** Accepted, publishable prices in registry order. */
  prices: PublishablePrice[];
  accepted: PriceEvaluation[];
  rejected: PriceEvaluation[];
  /** Symbols that are currently served from stale state (state only, never published as fresh). */
  staleSymbols: SymbolMarketState[];
}

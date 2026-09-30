/**
 * Typed market data model.
 *
 * Internal unit convention: every price is stored in **Rial** and therefore named
 * `priceInRial`. Conversion for display happens only in `common/money.ts`.
 */

export interface MarketPriceItem {
  symbol: string;
  name?: string;
  /** Price in the canonical internal unit (Rial). */
  priceInRial: number;
  /** Percentage change as reported by the API, already rounded/validated, or `null`. */
  changePercent: number | null;
}

export interface MarketData {
  gold: MarketPriceItem[];
  currency: MarketPriceItem[];
  /** ISO timestamp of the successful fetch. */
  fetchedAt: string;
}

/** Raw, unvalidated payload as returned by the external price API. */
export type RawMarketPayload = Record<string, unknown>;

import { Injectable } from '@nestjs/common';

/**
 * Day-scoped trend state.
 *
 * Each stored price carries the Tehran calendar day it belongs to, so a price from a
 * previous day can never be used as a comparison baseline. Additionally the state is
 * cleared when the day changes, which keeps memory bounded and makes the behaviour explicit.
 *
 * Chosen Phase 0 semantics:
 *  - first valid update of a new day  → no previous value → trend `unknown` (◽)
 *  - higher than the last *published* price of the same day → `up` (🔺)
 *  - lower  → `down` (🔻)
 *  - equal  → `flat` (🔹)
 */

export type TrendDirection = 'unknown' | 'up' | 'down' | 'flat';

export interface TrendSnapshotEntry {
  symbol: string;
  priceInRial: number;
}

interface TrendEntry extends TrendSnapshotEntry {
  dayKey: string;
}

@Injectable()
export class TrendTracker {
  private readonly lastPublished = new Map<string, TrendEntry>();
  private activeDayKey: string | null = null;

  /** Trend of `priceInRial` compared with the last published price of the same day. */
  trendFor(
    symbol: string,
    priceInRial: number,
    dayKey: string,
  ): TrendDirection {
    const previous = this.lastPublished.get(symbol);

    if (!previous || previous.dayKey !== dayKey) {
      return 'unknown';
    }

    if (priceInRial > previous.priceInRial) {
      return 'up';
    }

    if (priceInRial < previous.priceInRial) {
      return 'down';
    }

    return 'flat';
  }

  /**
   * Store a delivered snapshot as the new comparison baseline.
   * Both the day reset and the write happen here, so a snapshot can never be committed
   * into a stale day bucket.
   */
  commit(snapshot: readonly TrendSnapshotEntry[], dayKey: string): void {
    this.resetForNewDay(dayKey);

    for (const entry of snapshot) {
      this.lastPublished.set(entry.symbol, { ...entry, dayKey });
    }
  }

  /**
   * Drop state from a previous Tehran day.
   * @returns `true` when a reset actually happened (useful for one-time logging).
   */
  resetForNewDay(dayKey: string): boolean {
    if (this.activeDayKey === dayKey) {
      return false;
    }

    const hadState = this.activeDayKey !== null;
    this.lastPublished.clear();
    this.activeDayKey = dayKey;

    return hadState;
  }

  get trackedSymbolCount(): number {
    return this.lastPublished.size;
  }
}

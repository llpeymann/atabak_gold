import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { tehranDayKey } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import {
  PersistedMarketState,
  PersistedSymbolState,
  MarketStateStore,
} from './market-state.store';
import {
  PriceEvaluation,
  PriceUnit,
  SymbolDailyStats,
  SymbolMarketState,
} from './market.types';
import { SymbolDefinition } from './symbols';

interface SymbolStateRecord {
  unit: PriceUnit;
  currentPrice: number;
  previousPrice: number | null;
  lastValidPrice: number;
  updatedAt: string;
  lastSuccessfulUpdate: string;
  dayKey: string;
  direction: SymbolMarketState['direction'];
  percentageChange: number | null;
  absoluteChange: number | null;
  /** `null` until the first accepted price of the current Tehran day. */
  daily: SymbolDailyStats | null;
}

/**
 * Market state — the only component allowed to hold accepted price state.
 *
 * Guarantees (Phase 1):
 *  - only *accepted* prices are committed; rejected ones are ignored completely, so an anomaly can
 *    never touch `currentPrice`, `lastValidPrice`, `previousPrice` or the daily statistics,
 *  - `lastValidPrice` survives API failures, rejections and restarts (via `MarketStateStore`),
 *  - daily statistics (`open`/`high`/`low`/`current`/`change`) exist per symbol and reset at the
 *    Tehran day boundary; the first accepted price of a day becomes `open`,
 *  - staleness (`FRESH`/`STALE`) is derived from `lastSuccessfulUpdate`.
 */
@Injectable()
export class MarketStateService implements OnModuleInit {
  private readonly logger = new Logger(MarketStateService.name);
  private readonly states = new Map<string, SymbolStateRecord>();
  private activeDayKey: string | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly store: MarketStateStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.restore();
  }

  /** Restore persisted state (if any) and align it with the current Tehran day. */
  async restore(): Promise<void> {
    const persisted = await this.store.load();

    if (!persisted) {
      this.activeDayKey = tehranDayKey(new Date());
      return;
    }

    const today = tehranDayKey(new Date());

    for (const symbol of persisted.symbols) {
      if (!this.isPersistedSymbol(symbol)) {
        continue;
      }

      const sameDay = symbol.dayKey === today;

      this.states.set(symbol.symbol, {
        unit: symbol.unit,
        currentPrice: symbol.currentPrice,
        previousPrice: sameDay ? symbol.previousPrice : null,
        lastValidPrice: symbol.lastValidPrice,
        updatedAt: symbol.updatedAt,
        lastSuccessfulUpdate: symbol.lastSuccessfulUpdate,
        dayKey: sameDay ? symbol.dayKey : today,
        direction: 'UNKNOWN',
        percentageChange: null,
        absoluteChange: null,
        // Daily statistics must never be contaminated by another day's data: a restored state
        // from a previous day starts with no daily window at all.
        daily: sameDay ? (symbol.daily ?? null) : null,
      });
    }

    this.activeDayKey = today;

    if (this.states.size > 0) {
      this.logger.log(
        `Restored market state for ${this.states.size} symbol(s) from ` +
          `${this.store.path ?? 'memory'} (day ${today}).`,
      );
    }
  }

  /**
   * Commit an accepted price. Only call this with `evaluation.accepted === true`.
   * @returns the new state of the symbol.
   */
  commit(
    definition: SymbolDefinition,
    evaluation: PriceEvaluation,
    dayKey: string,
  ): SymbolMarketState {
    const price = evaluation.price;

    if (!evaluation.accepted || price === undefined) {
      throw new Error(
        `MarketStateService.commit() called with a rejected price for ${definition.symbol} — ` +
          'rejected prices must never modify market state.',
      );
    }

    this.rollDayIfNeeded(dayKey);

    const existing = this.states.get(definition.symbol);
    // State from another Tehran day may provide `lastValidPrice`, but it must never be used as
    // today's comparison baseline or contaminate today's daily window.
    const sameDay =
      existing && existing.dayKey === dayKey && existing.daily !== null
        ? existing
        : null;
    const updatedAt = evaluation.evaluatedAt;
    const daily = this.applyToDailyWindow(sameDay?.daily ?? null, price);

    // A cross-day baseline is used for anomaly detection only; the direction published to users
    // always compares against the previous accepted price *of the same day*.
    const sameDayComparison = evaluation.baseline === 'SAME_DAY';

    const record: SymbolStateRecord = {
      unit: definition.unit,
      currentPrice: price,
      previousPrice: sameDay ? sameDay.currentPrice : null,
      lastValidPrice: price,
      updatedAt,
      lastSuccessfulUpdate: updatedAt,
      dayKey,
      direction: sameDayComparison ? evaluation.direction : 'UNKNOWN',
      percentageChange: sameDayComparison ? evaluation.percentageChange : null,
      absoluteChange: sameDayComparison ? evaluation.absoluteChange : null,
      daily,
    };

    this.states.set(definition.symbol, record);

    return this.toMarketState(definition, record, new Date());
  }

  /**
   * State of a symbol.
   * `freshness` is derived from the last *successful* update, so a failed API cycle marks the
   * state as stale without destroying the last valid price.
   */
  getState(
    definition: SymbolDefinition,
    now = new Date(),
  ): SymbolMarketState | null {
    const record = this.states.get(definition.symbol);

    return record ? this.toMarketState(definition, record, now) : null;
  }

  /** Latest accepted price of the current day (comparison baseline for same-day moves). */
  getSameDayPrice(symbol: string, dayKey: string): number | null {
    const record = this.states.get(symbol);

    if (!record || record.dayKey !== dayKey || record.daily === null) {
      return null;
    }

    return record.currentPrice;
  }

  /** Most recent valid price, even when it belongs to a previous day. */
  getLastValidPrice(symbol: string): number | null {
    const record = this.states.get(symbol);

    return record ? record.lastValidPrice : null;
  }

  getTrackedSymbolCount(): number {
    return this.states.size;
  }

  /** Re-apply the day boundary for every symbol (used by scheduled jobs). */
  rollDayIfNeeded(dayKey: string): void {
    if (this.activeDayKey === dayKey) {
      return;
    }

    const previousDay = this.activeDayKey;
    this.activeDayKey = dayKey;

    for (const [symbol, record] of this.states) {
      this.states.set(symbol, {
        ...record,
        previousPrice: null,
        direction: 'UNKNOWN',
        percentageChange: null,
        absoluteChange: null,
        // The new day starts without a daily window: its open is the first accepted price.
        daily: null,
      });
    }

    if (previousDay !== null) {
      this.logger.log(
        `New Tehran day (${dayKey}): daily statistics and same-day baselines were reset.`,
      );
    }
  }

  /** Persist the current state (best effort; failures are logged inside the store). */
  async persist(dayKey: string): Promise<void> {
    if (!this.store.enabled || this.states.size === 0) {
      return;
    }

    const symbols: PersistedSymbolState[] = [];

    for (const [symbol, record] of this.states) {
      symbols.push({
        symbol,
        unit: record.unit,
        currentPrice: record.currentPrice,
        previousPrice: record.previousPrice,
        lastValidPrice: record.lastValidPrice,
        updatedAt: record.updatedAt,
        lastSuccessfulUpdate: record.lastSuccessfulUpdate,
        dayKey: record.dayKey,
        daily: record.daily,
      });
    }

    const state: PersistedMarketState = {
      version: 1,
      savedAt: new Date().toISOString(),
      dayKey,
      symbols,
    };

    await this.store.save(state);
  }

  private toMarketState(
    definition: SymbolDefinition,
    record: SymbolStateRecord,
    now: Date,
  ): SymbolMarketState {
    const ageMs = Math.max(
      0,
      now.getTime() - Date.parse(record.lastSuccessfulUpdate),
    );

    return {
      symbol: definition.symbol,
      label: definition.label,
      section: definition.section,
      unit: definition.unit,
      currentPrice: record.currentPrice,
      previousPrice: record.previousPrice,
      lastValidPrice: record.lastValidPrice,
      updatedAt: record.updatedAt,
      lastSuccessfulUpdate: record.lastSuccessfulUpdate,
      dayKey: record.dayKey,
      direction: record.direction,
      percentageChange: record.percentageChange,
      absoluteChange: record.absoluteChange,
      daily: record.daily ? { ...record.daily } : null,
      freshness: this.freshnessFor(ageMs),
      ageMs,
    };
  }

  private freshnessFor(ageMs: number): SymbolMarketState['freshness'] {
    if (ageMs <= this.config.staleAfterMs) {
      return 'FRESH';
    }

    return 'STALE';
  }

  /** First accepted price of a day opens the window; later prices update high/low/current. */
  private applyToDailyWindow(
    window: SymbolDailyStats | null,
    price: number,
  ): SymbolDailyStats {
    const daily = window ? { ...window } : this.freshDaily(price);

    daily.current = price;
    daily.high = Math.max(daily.high, price);
    daily.low = Math.min(daily.low, price);
    daily.change = daily.current - daily.open;

    return daily;
  }

  private freshDaily(price: number): SymbolDailyStats {
    return { open: price, high: price, low: price, current: price, change: 0 };
  }

  private isPersistedSymbol(value: unknown): value is PersistedSymbolState {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<PersistedSymbolState>;

    return (
      typeof candidate.symbol === 'string' &&
      typeof candidate.currentPrice === 'number' &&
      typeof candidate.lastValidPrice === 'number' &&
      typeof candidate.dayKey === 'string'
    );
  }

  /** Debug/diagnostics helper used by logs and tests. */
  describeState(symbol: string): string {
    const record = this.states.get(symbol);

    if (!record) {
      return `${symbol}: no state`;
    }

    try {
      return `${symbol}: current=${record.currentPrice} lastValid=${record.lastValidPrice} day=${record.dayKey}`;
    } catch (error) {
      return `${symbol}: state unavailable (${describeError(error)})`;
    }
  }
}

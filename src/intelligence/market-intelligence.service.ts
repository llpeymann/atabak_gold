import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { calculatePriceChange } from '../market/price-change.calculator';
import { MarketStateService } from '../market/market-state.service';
import { SymbolMarketState } from '../market/market.types';
import { SymbolDefinition } from '../market/symbols';
import { MarketSummary } from './market-intelligence.types';
import { buildMarketSummary } from './market-summary';
import {
  MarketIntelligenceFreshness,
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
  SymbolAvailability,
} from './market-intelligence.types';

/**
 * Phase 4 — Market Intelligence.
 *
 * Reads the validated Phase 1 market state once per symbol and turns it into a read-only,
 * descriptive snapshot (`open/current/high/low`, daily change, market movement, per-symbol
 * timestamp and availability). It is the only market dependency of the `📊 بازار` section.
 *
 * Deliberately not a responsibility (§5, §33, §40, §41):
 *  - fetching or validating prices (Phase 1 owns that),
 *  - holding price state, caching or polling (no second market state),
 *  - deciding validity, anomaly or freshness thresholds (reuses Phase 1),
 *  - triggering anything (alerts are evaluated by Phase 3 from the market cycle).
 *
 * Reused Phase 1 logic: `MarketStateService` for state/freshness/daily statistics and
 * `calculatePriceChange` for both the daily change and the movement, so "no baseline",
 * "unusable baseline" and divide-by-zero have exactly one implementation.
 */
@Injectable()
export class MarketIntelligenceService {
  private readonly logger = new Logger(MarketIntelligenceService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly marketState: MarketStateService,
  ) {}

  /**
   * Build the snapshot. `now` only decides *freshness* (the same rule Phase 1 applies) and the
   * snapshot's `generatedAt`; it never becomes a market timestamp (§12, §15).
   */
  build(now = new Date()): MarketIntelligenceSnapshot {
    // One pass over the canonical registry, one state read per symbol (§22, §42).
    const symbols = this.config.symbolRegistry.map((definition) =>
      this.toSnapshot(definition, now),
    );
    const lastUpdate = this.newestUpdate(
      symbols.map((symbol) => symbol.lastUpdatedAt),
    );
    const summary = buildMarketSummary(symbols);
    const hasData = summary.available + summary.stale > 0;
    const freshness = this.freshnessOf(summary);

    if (!hasData) {
      this.logger.warn(
        'Market intelligence snapshot generated without any validated symbol — no price is invented.',
      );
    }

    this.logger.debug(
      `Market intelligence snapshot generated: ${symbols.length} symbol(s), ` +
        `${summary.available} fresh, ${summary.stale} stale, ` +
        `${summary.unavailable} unavailable (${freshness}).`,
    );

    return {
      generatedAt: now.toISOString(),
      freshness,
      symbols,
      summary,
      hasData,
      hasStale: summary.stale > 0,
      lastUpdate,
    };
  }

  /**
   * Read one symbol from the validated Phase 1 state.
   *
   * A failure of the state read must not take the whole report down: the symbol is reported as
   * unavailable and the technical reason is logged. The reason never reaches the user and the
   * missing value is never replaced by an invented one (§20, §45, §62).
   */
  private readState(
    definition: SymbolDefinition,
    now: Date,
  ): SymbolMarketState | null {
    try {
      return this.marketState.getState(definition, now);
    } catch (error) {
      this.logger.warn(
        `Market state read failed for ${definition.symbol}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Snapshot of a single registry symbol — used by screens that focus on one instrument.
   * Returns `null` for a symbol the registry does not know: an unknown identifier is never turned
   * into an invented entry (§45).
   */
  buildFor(symbol: string, now = new Date()): MarketSymbolSnapshot | null {
    const definition = this.config.symbolRegistry.find(
      (candidate) => candidate.symbol === symbol,
    );

    return definition ? this.toSnapshot(definition, now) : null;
  }

  private toSnapshot(
    definition: SymbolDefinition,
    now: Date,
  ): MarketSymbolSnapshot {
    const state = this.readState(definition, now);

    // No validated state at all: the symbol is listed as unavailable with no numbers (§19, §62).
    if (!state) {
      return {
        symbol: definition.symbol,
        label: definition.label,
        section: definition.section,
        unit: definition.unit,
        availability: 'UNAVAILABLE',
        freshness: null,
        currentPrice: null,
        previousPrice: null,
        open: null,
        high: null,
        low: null,
        dailyChange: null,
        dailyChangePercent: null,
        dailyDirection: 'UNKNOWN',
        movement: null,
        movementPercent: null,
        movementDirection: 'UNKNOWN',
        lastUpdatedAt: null,
        ageMs: null,
      };
    }

    const daily = state.daily;
    // Both calculations reuse the Phase 1 calculator: `null` (never `Infinity`/`NaN`) whenever the
    // baseline is missing or unusable — including `open === 0` and `previous === 0` (§7, §24).
    const dailyChange = daily
      ? calculatePriceChange(daily.current, daily.open)
      : null;
    const movement = calculatePriceChange(
      state.currentPrice,
      state.previousPrice,
    );

    return {
      symbol: definition.symbol,
      label: definition.label,
      section: definition.section,
      unit: definition.unit,
      availability: this.availabilityOf(state),
      freshness: state.freshness,
      currentPrice: state.currentPrice,
      previousPrice: state.previousPrice,
      open: daily?.open ?? null,
      high: daily?.high ?? null,
      low: daily?.low ?? null,
      dailyChange: dailyChange?.absoluteChange ?? null,
      dailyChangePercent: dailyChange?.percentageChange ?? null,
      dailyDirection: dailyChange?.direction ?? 'UNKNOWN',
      movement: movement.absoluteChange,
      movementPercent: movement.percentageChange,
      // `calculatePriceChange` already reports UNKNOWN when there is no usable previous valid
      // price, so the direction is never guessed here (§25, §26).
      movementDirection: movement.direction,
      // The timestamp of the accepted price itself — never the render/refresh time (§12, §54).
      lastUpdatedAt: state.updatedAt,
      ageMs: state.ageMs,
    };
  }

  private availabilityOf(state: SymbolMarketState): SymbolAvailability {
    // Phase 1 already decided freshness; Phase 4 introduces no second threshold (§16).
    return state.freshness === 'STALE' ? 'STALE' : 'AVAILABLE';
  }

  /**
   * Aggregate the per-symbol availability decided by Phase 1 (§16). Pure counting — no new
   * threshold, no new clock rule, no interpretation of the market itself.
   */
  private freshnessOf(summary: MarketSummary): MarketIntelligenceFreshness {
    if (summary.available + summary.stale === 0) {
      return 'UNAVAILABLE';
    }

    if (summary.available === 0) {
      return 'STALE';
    }

    if (summary.stale > 0 || summary.unavailable > 0) {
      return 'PARTIAL';
    }

    return 'FRESH';
  }

  private newestUpdate(timestamps: readonly (string | null)[]): string | null {
    const usable = timestamps.filter(
      (timestamp): timestamp is string => typeof timestamp === 'string',
    );

    if (usable.length === 0) {
      return null;
    }

    return usable.reduce((newest, current) =>
      current > newest ? current : newest,
    );
  }
}

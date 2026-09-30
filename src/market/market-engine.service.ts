import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { sanitizeUrl } from '../common/log-safety';
import {
  tehranDateFa,
  tehranDayKey,
  tehranTimeFa,
} from '../common/tehran-time';
import { formatPriceValue } from './price-format';
import { AnomalyAlertService } from './anomaly-alert.service';
import { MarketStateService } from './market-state.service';
import { PriceNormalizer } from './price-normalizer.service';
import { RawPayloadParser } from './raw-payload.parser';
import { SanityChecker } from './sanity-checker.service';
import { SymbolDefinition, symbolsBySection } from './symbols';
import {
  NormalizedPrice,
  PriceEvaluation,
  PublishableMarketUpdate,
  PublishablePrice,
  SchemaValidationError,
  SymbolMarketState,
} from './market.types';

/**
 * One accepted price that was committed into the market state.
 *
 * This is the *only* thing an interested subsystem (Phase 3 alerts) may consume from the market
 * engine: an accepted, already-validated price together with the comparison baseline Phase 1
 * used. Rejected/anomalous values never produce an event (§50).
 */
export interface MarketPriceCommittedEvent {
  symbol: string;
  label: string;
  section: SymbolDefinition['section'];
  unit: SymbolDefinition['unit'];
  /** Accepted current price in the canonical unit. */
  price: number;
  /** The observation immediately preceding it (same day, or the previous day's last price). */
  previousPrice: number | null;
  baseline: PriceEvaluation['baseline'];
  dayKey: string;
  evaluatedAt: string;
}

/**
 * Listener contract: subsystems register themselves instead of the market engine depending on
 * them, so the Phase 1 pipeline stays free of downstream concerns and the publication path is
 * unaffected by listener failures.
 */
export interface MarketUpdateListener {
  onMarketPricesCommitted(
    events: readonly MarketPriceCommittedEvent[],
  ): Promise<void> | void;
}

export interface MarketCycleResult {
  /** The only object a publisher may use. `publishable: false` means: publish nothing. */
  update: PublishableMarketUpdate;
  /** Symbols whose stored state is stale (kept for monitoring/next phases). */
  staleSymbols: SymbolMarketState[];
}

/**
 * Market reliability engine — orchestrates the whole pipeline:
 *
 *   raw payload → schema validation → symbol registry → normalization → numeric validation
 *   → sanity/anomaly → market state → change calculation → daily statistics → publish/reject
 *
 * The publisher receives a `PublishableMarketUpdate` built exclusively from accepted prices;
 * it can never see raw or rejected data. Everything that fails keeps its explicit reason.
 */
@Injectable()
export class MarketEngineService {
  private readonly logger = new Logger(MarketEngineService.name);

  /** Registered downstream consumers (Phase 3: the alert engine). */
  private readonly listeners: MarketUpdateListener[] = [];

  constructor(
    private readonly config: AppConfigService,
    private readonly parser: RawPayloadParser,
    private readonly normalizer: PriceNormalizer,
    private readonly sanityChecker: SanityChecker,
    private readonly marketState: MarketStateService,
    private readonly anomalyAlerts: AnomalyAlertService,
  ) {}

  /** Add a listener; it is notified once per cycle with the prices committed in that cycle. */
  registerUpdateListener(listener: MarketUpdateListener): void {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
    }
  }

  async evaluateCycle(
    rawPayload: unknown,
    receivedAt = new Date(),
  ): Promise<MarketCycleResult> {
    const registry = this.config.symbolRegistry;
    const dayKey = tehranDayKey(receivedAt);
    const source = sanitizeUrl(this.config.priceApi.url);
    const receivedAtIso = receivedAt.toISOString();

    // A new Tehran day resets daily statistics and same-day baselines before anything is judged.
    this.marketState.rollDayIfNeeded(dayKey);

    let parsed;
    try {
      parsed = this.parser.parse(rawPayload);
    } catch (error) {
      // A structural failure is reported once, for the whole response: no symbol is evaluated.
      const detail =
        error instanceof SchemaValidationError ? error.message : String(error);
      this.logger.error(
        `❌ Price payload rejected (INVALID_SCHEMA): ${detail}`,
      );

      return {
        update: this.emptyUpdate({
          blockingReason: 'INVALID_SCHEMA',
          source,
          receivedAtIso,
          dayKey,
          now: receivedAt,
        }),
        staleSymbols: this.collectStale(registry),
      };
    }

    const { normalized, rejected } = this.normalizer.normalize(
      parsed,
      registry,
      source,
      receivedAtIso,
    );

    const definitions = new Map(
      registry.map((definition) => [definition.symbol, definition]),
    );
    const accepted: PriceEvaluation[] = [];
    const acceptedPrices: NormalizedPrice[] = [];
    const anomalies: PriceEvaluation[] = [];

    for (const price of normalized) {
      const definition = definitions.get(price.symbol);

      if (!definition) {
        continue;
      }

      const baseline = this.sanityChecker.buildBaseline(
        this.marketState.getSameDayPrice(price.symbol, dayKey),
        this.marketState.getLastValidPrice(price.symbol),
      );

      const evaluation = this.sanityChecker.evaluate(
        price,
        definition,
        baseline,
        receivedAtIso,
      );

      if (evaluation.accepted) {
        accepted.push(evaluation);
        acceptedPrices.push(price);
      } else {
        rejected.push(evaluation);

        if (
          evaluation.reason === 'EXCESSIVE_CHANGE' ||
          evaluation.reason === 'OUT_OF_RANGE'
        ) {
          anomalies.push(evaluation);
        }

        this.logRejection(evaluation);
      }
    }

    // Symbols declared in the registry but absent from this payload are reported explicitly.
    const presentSymbols = new Set(parsed.entries.map((entry) => entry.symbol));
    for (const definition of registry) {
      if (
        presentSymbols.has(definition.symbol) ||
        rejected.some((r) => r.symbol === definition.symbol)
      ) {
        continue;
      }

      const missing = this.missingSymbolEvaluation(
        definition,
        dayKey,
        receivedAtIso,
      );
      rejected.push(missing);

      if (definition.required) {
        this.logger.error(
          `❌ Required symbol ${definition.symbol} (${definition.label}) is missing from the API ` +
            'response — reason MISSING_SYMBOL; its last valid state is preserved and it will not ' +
            'be published as fresh.',
        );
      } else {
        this.logger.warn(
          `Symbol ${definition.symbol} (${definition.label}) is absent from the API response ` +
            '(MISSING_SYMBOL) — keeping the previous state.',
        );
      }
    }

    // Commit accepted prices into market state (rejected ones can never reach this line).
    for (let index = 0; index < accepted.length; index += 1) {
      const evaluation = accepted[index];
      const price = acceptedPrices[index];
      const definition = definitions.get(evaluation.symbol);

      if (!definition || !price) {
        continue;
      }

      this.marketState.commit(definition, evaluation, dayKey);
    }

    await this.marketState.persist(dayKey);

    for (const anomaly of anomalies) {
      await this.anomalyAlerts.reportAnomaly(anomaly, receivedAt);
    }

    // Downstream consumers (Phase 3 alerts) only ever see accepted, committed prices.
    await this.notifyListeners(accepted, definitions, dayKey);

    const evaluated = this.buildPublishablePrices(accepted, registry);
    const requiredFresh = this.countFreshRequired(accepted, registry);
    const publishable = requiredFresh > 0 && evaluated.length > 0;
    // The publisher must never receive anything when the cycle is blocked.
    const prices = publishable ? evaluated : [];

    if (!publishable) {
      this.logger.error(
        `❌ No publishable market update: required-fresh=${requiredFresh}, accepted=${prices.length} ` +
          `(accepted=${accepted.map((e) => e.symbol).join(', ') || 'none'}) — nothing will be published.`,
      );
    }

    const staleSymbols = this.collectStale(registry);

    return {
      update: {
        publishable,
        ...(publishable
          ? {}
          : {
              blockingReason:
                evaluated.length === 0
                  ? 'NO_ACCEPTED_PRICES'
                  : 'NO_FRESH_REQUIRED_SYMBOL',
            }),
        source,
        receivedAt: receivedAtIso,
        sourceTimestamp: parsed.sourceTimestamp,
        dayKey,
        dateFa: tehranDateFa(receivedAt),
        timeFa: tehranTimeFa(receivedAt),
        prices,
        accepted,
        rejected,
        staleSymbols,
      },
      staleSymbols,
    };
  }

  /**
   * Notify every listener exactly once per cycle with the accepted prices of that cycle.
   * A listener failure is logged and never propagates: price publication must not depend on
   * an optional downstream subsystem.
   */
  private async notifyListeners(
    accepted: readonly PriceEvaluation[],
    definitions: ReadonlyMap<string, SymbolDefinition>,
    dayKey: string,
  ): Promise<void> {
    if (this.listeners.length === 0 || accepted.length === 0) {
      return;
    }

    const events: MarketPriceCommittedEvent[] = [];

    for (const evaluation of accepted) {
      const definition = definitions.get(evaluation.symbol);

      if (!definition || evaluation.price === undefined) {
        continue;
      }

      events.push({
        symbol: evaluation.symbol,
        label: definition.label,
        section: definition.section,
        unit: definition.unit,
        price: evaluation.price,
        previousPrice: evaluation.previousPrice,
        baseline: evaluation.baseline,
        dayKey,
        evaluatedAt: evaluation.evaluatedAt,
      });
    }

    for (const listener of this.listeners) {
      try {
        await listener.onMarketPricesCommitted(events);
      } catch (error) {
        this.logger.error(
          `Market update listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Publishable prices in registry order, grouped by section order. */
  private buildPublishablePrices(
    accepted: readonly PriceEvaluation[],
    registry: readonly SymbolDefinition[],
  ): PublishablePrice[] {
    const bySymbol = new Map(
      accepted.map((evaluation) => [evaluation.symbol, evaluation]),
    );
    const prices: PublishablePrice[] = [];

    for (const definition of registry) {
      const evaluation = bySymbol.get(definition.symbol);

      if (!evaluation || evaluation.price === undefined) {
        continue;
      }

      const state = this.marketState.getState(definition);
      const daily = state?.daily ?? null;
      const dailyChange = daily ? daily.change : 0;
      const dailyChangePercent =
        daily && daily.open > 0 ? (dailyChange / daily.open) * 100 : null;
      // Display semantics: the user-facing trend is always a same-day comparison. A cross-day
      // baseline is only used to detect anomalies.
      const sameDayComparison = evaluation.baseline === 'SAME_DAY';

      prices.push({
        symbol: definition.symbol,
        label: definition.label,
        section: definition.section,
        unit: definition.unit,
        price: evaluation.price,
        percentageChange: sameDayComparison
          ? evaluation.percentageChange
          : null,
        direction: sameDayComparison ? evaluation.direction : 'UNKNOWN',
        dailyChange,
        dailyChangePercent,
      });
    }

    return prices;
  }

  private countFreshRequired(
    accepted: readonly PriceEvaluation[],
    registry: readonly SymbolDefinition[],
  ): number {
    const acceptedSymbols = new Set(
      accepted.map((evaluation) => evaluation.symbol),
    );

    return registry.filter(
      (definition) =>
        definition.required && acceptedSymbols.has(definition.symbol),
    ).length;
  }

  private collectStale(
    registry: readonly SymbolDefinition[],
  ): SymbolMarketState[] {
    const stale: SymbolMarketState[] = [];

    for (const definition of registry) {
      const state = this.marketState.getState(definition);

      if (state && state.freshness === 'STALE') {
        stale.push(state);
      }
    }

    return stale;
  }

  private missingSymbolEvaluation(
    definition: SymbolDefinition,
    dayKey: string,
    evaluatedAt: string,
  ): PriceEvaluation {
    const lastValid = this.marketState.getLastValidPrice(definition.symbol);

    return {
      symbol: definition.symbol,
      label: definition.label,
      section: definition.section,
      unit: definition.unit,
      accepted: false,
      reason: 'MISSING_SYMBOL',
      detail: `the API response did not contain ${definition.symbol} (day ${dayKey})`,
      previousPrice: lastValid,
      baseline: lastValid === null ? 'NONE' : 'PREVIOUS_DAY',
      maxChangePercent: definition.maxChangePercent,
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
      evaluatedAt,
    };
  }

  private logRejection(evaluation: PriceEvaluation): void {
    const previous =
      evaluation.previousPrice === null
        ? 'n/a'
        : this.describeValue(evaluation.previousPrice, evaluation);
    const received =
      evaluation.rejectedValue === undefined
        ? 'n/a'
        : this.describeValue(evaluation.rejectedValue, evaluation);

    this.logger.warn(
      `⛔️ Rejected ${evaluation.symbol} (${evaluation.label}) | reason=${evaluation.reason ?? 'UNKNOWN'} ` +
        `| previous=${previous} | received=${received} | change=${
          evaluation.percentageChange === null
            ? 'n/a'
            : `${evaluation.percentageChange.toFixed(2)}%`
        } | allowed=${evaluation.maxChangePercent}% | at=${evaluation.evaluatedAt} | ${evaluation.detail ?? ''}`,
    );
  }

  private describeValue(value: number, evaluation: PriceEvaluation): string {
    return formatPriceValue(value, evaluation.unit, this.config.displayUnit);
  }

  private emptyUpdate(options: {
    blockingReason: string;
    source: string;
    receivedAtIso: string;
    dayKey: string;
    now: Date;
  }): PublishableMarketUpdate {
    return {
      publishable: false,
      blockingReason: options.blockingReason,
      source: options.source,
      receivedAt: options.receivedAtIso,
      sourceTimestamp: null,
      dayKey: options.dayKey,
      dateFa: tehranDateFa(options.now),
      timeFa: tehranTimeFa(options.now),
      prices: [],
      accepted: [],
      rejected: [],
      staleSymbols: [],
    };
  }

  /** Registry sections with their definitions — used by presentation code. */
  sectionsFor(
    registry: readonly SymbolDefinition[] = this.config.symbolRegistry,
  ): {
    section: SymbolDefinition['section'];
    definitions: SymbolDefinition[];
  }[] {
    return (['gold', 'coins', 'currency'] as const).map((section) => ({
      section,
      definitions: symbolsBySection(registry, section),
    }));
  }
}

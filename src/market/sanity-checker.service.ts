import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { SymbolDefinition } from './symbols';
import {
  BaselineSource,
  NormalizedPrice,
  PriceEvaluation,
  RejectionReason,
} from './market.types';

interface Baseline {
  price: number;
  source: BaselineSource;
}

/**
 * Sanity / anomaly engine.
 *
 * It is the last gate before a normalized price may modify market state. Three deterministic
 * rules are applied, in this order:
 *
 *   1. range check   — the value must lie inside the configured sanity bounds of the symbol,
 *   2. absolute move — optional second guard for instruments where a percentage alone can hide a
 *                      large absolute jump,
 *   3. relative move — the change against the comparison baseline must stay inside
 *                      `maxChangePercent` (widened by the cross-day multiplier when the baseline
 *                      comes from a previous Tehran day).
 *
 * A failure never throws: it produces a rejected `PriceEvaluation` carrying an explicit reason,
 * so the caller can log it, alert on it and keep market state untouched.
 */
@Injectable()
export class SanityChecker {
  private readonly logger = new Logger(SanityChecker.name);

  constructor(private readonly config: AppConfigService) {}

  evaluate(
    price: NormalizedPrice,
    definition: SymbolDefinition,
    baseline: Baseline | null,
    evaluatedAt: string,
  ): PriceEvaluation {
    const base: Omit<PriceEvaluation, 'accepted' | 'reason' | 'detail'> = {
      symbol: definition.symbol,
      label: definition.label,
      section: definition.section,
      unit: definition.unit,
      price: price.price,
      previousPrice: baseline ? baseline.price : null,
      baseline: baseline ? baseline.source : 'NONE',
      maxChangePercent: definition.maxChangePercent,
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
      evaluatedAt,
    };

    const rangeRejection = this.checkRange(price.price, definition);
    if (rangeRejection) {
      return {
        ...base,
        accepted: false,
        rejectedValue: price.price,
        ...rangeRejection,
      };
    }

    if (!baseline) {
      // First accepted observation for this symbol: nothing to compare against yet.
      return { ...base, accepted: true };
    }

    const change = this.computeChange(price.price, baseline, definition);
    const withChange: Omit<PriceEvaluation, 'accepted' | 'reason' | 'detail'> =
      {
        ...base,
        absoluteChange: change.absoluteChange,
        percentageChange: change.percentageChange,
        direction: change.direction,
      };

    if (change.absoluteRejection) {
      return {
        ...withChange,
        accepted: false,
        rejectedValue: price.price,
        ...change.absoluteRejection,
      };
    }

    if (change.percentRejection) {
      return {
        ...withChange,
        accepted: false,
        rejectedValue: price.price,
        ...change.percentRejection,
      };
    }

    return { ...withChange, accepted: true };
  }

  /** Builds the comparison baseline from the previous state of the symbol. */
  buildBaseline(
    sameDayPrice: number | null,
    previousDayPrice: number | null,
  ): Baseline | null {
    if (sameDayPrice !== null && sameDayPrice > 0) {
      return { price: sameDayPrice, source: 'SAME_DAY' };
    }

    if (previousDayPrice !== null && previousDayPrice > 0) {
      return { price: previousDayPrice, source: 'PREVIOUS_DAY' };
    }

    return null;
  }

  private checkRange(
    value: number,
    definition: SymbolDefinition,
  ): { reason: RejectionReason; detail: string } | null {
    const { minPrice, maxPrice } = definition;

    if (definition.unit === 'USD') {
      // Bounds for USD-quoted instruments are still expressed in USD.
      if (minPrice !== null && value < minPrice) {
        return {
          reason: 'OUT_OF_RANGE',
          detail: `value ${value} ${definition.unit} is below the sanity lower bound ${minPrice}`,
        };
      }
      if (maxPrice !== null && value > maxPrice) {
        return {
          reason: 'OUT_OF_RANGE',
          detail: `value ${value} ${definition.unit} is above the sanity upper bound ${maxPrice}`,
        };
      }
      return null;
    }

    if (minPrice !== null && value < minPrice) {
      return {
        reason: 'OUT_OF_RANGE',
        detail: `value ${value} ${definition.unit} is below the sanity lower bound ${minPrice}`,
      };
    }

    if (maxPrice !== null && value > maxPrice) {
      return {
        reason: 'OUT_OF_RANGE',
        detail: `value ${value} ${definition.unit} is above the sanity upper bound ${maxPrice}`,
      };
    }

    return null;
  }

  private computeChange(
    current: number,
    baseline: Baseline,
    definition: SymbolDefinition,
  ): {
    absoluteChange: number;
    percentageChange: number;
    direction: PriceEvaluation['direction'];
    absoluteRejection: { reason: RejectionReason; detail: string } | null;
    percentRejection: { reason: RejectionReason; detail: string } | null;
  } {
    const absoluteChange = current - baseline.price;
    const percentageChange = (absoluteChange / baseline.price) * 100;
    const direction =
      absoluteChange > 0 ? 'UP' : absoluteChange < 0 ? 'DOWN' : 'UNCHANGED';

    const allowedPercent =
      definition.maxChangePercent === null
        ? null
        : baseline.source === 'PREVIOUS_DAY'
          ? definition.maxChangePercent * this.config.crossDayChangeMultiplier
          : definition.maxChangePercent;

    const absoluteRejection =
      definition.maxAbsoluteChange !== null &&
      Math.abs(absoluteChange) > definition.maxAbsoluteChange
        ? {
            reason: 'EXCESSIVE_CHANGE' as RejectionReason,
            detail:
              `absolute change ${this.formatNumber(absoluteChange)} ${definition.unit} exceeds ` +
              `the limit of ${definition.maxAbsoluteChange} ${definition.unit}`,
          }
        : null;

    const percentRejection =
      allowedPercent !== null && Math.abs(percentageChange) > allowedPercent
        ? {
            reason: 'EXCESSIVE_CHANGE' as RejectionReason,
            detail:
              `change of ${this.formatNumber(percentageChange)}% exceeds the allowed ` +
              `${this.formatNumber(allowedPercent)}%${baseline.source === 'PREVIOUS_DAY' ? ' (cross-day allowance)' : ''}`,
          }
        : null;

    if (percentRejection) {
      this.logger.debug(
        `Anomaly on ${definition.symbol}: baseline ${baseline.price} (${baseline.source}) → ` +
          `${current} (${this.formatNumber(percentageChange)}%)`,
      );
    }

    return {
      absoluteChange,
      percentageChange,
      direction,
      absoluteRejection,
      percentRejection,
    };
  }

  private formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

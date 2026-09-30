import { Injectable, Logger } from '@nestjs/common';

import { parseAmount } from '../common/money';
import { AppConfigService } from '../config/app-config.service';
import { SymbolDefinition } from './symbols';
import {
  NormalizedPrice,
  ParsedRawPayload,
  PriceEvaluation,
  RawPriceEntry,
  SourceUnit,
} from './market.types';

export interface NormalizationResult {
  /** Prices that passed parsing/numeric conversion and unit normalization. */
  normalized: NormalizedPrice[];
  /** Symbols that could not be normalized, with an explicit reason. */
  rejected: PriceEvaluation[];
}

/**
 * Normalizer: converts trusted-shape raw entries into the internal price contract.
 *
 * Responsibilities:
 *  - map API symbols onto the symbol registry (unknown symbols are rejected, never published),
 *  - convert valid numeric representations (number, numeric string) into numbers,
 *  - apply the canonical unit of the symbol — the only place in the application where a
 *    currency unit conversion exists.
 *
 * Numeric validity for a single value is decided here (NaN/Infinity/negative/zero are rejected);
 * price plausibility (bounds, anomalous moves) belongs to the sanity engine.
 */
@Injectable()
export class PriceNormalizer {
  private readonly logger = new Logger(PriceNormalizer.name);

  constructor(private readonly config: AppConfigService) {}

  normalize(
    payload: ParsedRawPayload,
    registry: readonly SymbolDefinition[],
    source: string,
    receivedAt: string,
  ): NormalizationResult {
    const bySymbol = new Map<string, SymbolDefinition>(
      registry.map((definition) => [definition.symbol, definition]),
    );
    const seen = new Set<string>();
    const normalized: NormalizedPrice[] = [];
    const rejected: PriceEvaluation[] = [];

    for (const entry of payload.entries) {
      const definition = bySymbol.get(entry.symbol);

      if (!definition) {
        rejected.push(
          this.rejection(entry, {
            symbol: entry.symbol,
            label: entry.symbol,
            unit: 'RIAL',
            section: 'currency',
            reason: 'UNKNOWN_SYMBOL',
            detail: 'symbol is not part of the supported symbol registry',
          }),
        );
        continue;
      }

      if (seen.has(entry.symbol)) {
        this.logger.warn(
          `Duplicate entry for "${entry.symbol}" in the API payload — keeping the first occurrence.`,
        );
        continue;
      }
      seen.add(entry.symbol);

      const amount = parseAmount(entry.rawPrice);

      if (amount === null) {
        rejected.push(
          this.rejection(entry, {
            symbol: definition.symbol,
            label: definition.label,
            unit: definition.unit,
            section: definition.section,
            reason: 'INVALID_NUMBER',
            detail: `value ${this.describeValue(entry.rawPrice)} is not a finite number`,
          }),
        );
        continue;
      }

      if (amount <= 0) {
        rejected.push(
          this.rejection(entry, {
            symbol: definition.symbol,
            label: definition.label,
            unit: definition.unit,
            section: definition.section,
            reason: 'INVALID_PRICE',
            detail: `value ${amount} is not a positive price`,
            rejectedValue: amount,
          }),
        );
        continue;
      }

      const sourceUnit = this.sourceUnitFor(definition);

      normalized.push({
        symbol: definition.symbol,
        price: this.toCanonicalUnit(amount, sourceUnit, definition),
        unit: definition.unit,
        sourceUnit,
        sourceTimestamp: payload.sourceTimestamp,
        receivedAt,
        source,
      });
    }

    return { normalized, rejected };
  }

  /** Unit conversion lives here only: values are stored in the canonical unit of the symbol. */
  private toCanonicalUnit(
    amount: number,
    sourceUnit: SourceUnit,
    definition: SymbolDefinition,
  ): number {
    if (definition.unit === 'USD') {
      // USD-quoted instruments are stored as-is; the Rial/Toman setting does not apply to them.
      return amount;
    }

    return sourceUnit === 'TOMAN' ? amount * 10 : amount;
  }

  private sourceUnitFor(definition: SymbolDefinition): SourceUnit {
    if (definition.unit === 'USD') {
      return 'RIAL';
    }

    return (
      this.config.priceApi.symbolUnits[definition.symbol] ??
      this.config.priceApi.sourceUnit
    );
  }

  private rejection(
    entry: RawPriceEntry,
    options: {
      symbol: string;
      label: string;
      unit: NormalizedPrice['unit'];
      section: SymbolDefinition['section'];
      reason: PriceEvaluation['reason'];
      detail: string;
      rejectedValue?: number;
    },
  ): PriceEvaluation {
    const evaluation: PriceEvaluation = {
      symbol: options.symbol,
      label: options.label,
      section: options.section,
      unit: options.unit,
      accepted: false,
      reason: options.reason,
      detail: options.detail,
      previousPrice: null,
      baseline: 'NONE',
      maxChangePercent: 0,
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
      evaluatedAt: new Date().toISOString(),
    };

    if (options.rejectedValue !== undefined) {
      evaluation.rejectedValue = options.rejectedValue;
    }

    if (entry.name !== null && options.label === options.symbol) {
      evaluation.label = entry.name;
    }

    return evaluation;
  }

  private describeValue(value: unknown): string {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'string') {
      return `"${value}"`;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return `[${typeof value}]`;
  }
}

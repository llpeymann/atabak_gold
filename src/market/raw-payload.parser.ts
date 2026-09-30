import { Injectable, Logger } from '@nestjs/common';

import {
  ParsedRawPayload,
  RawPriceEntry,
  SchemaValidationError,
} from './market.types';

/**
 * Parser / adapter for the external API payload.
 *
 * Only structural questions are answered here ("is this response shaped like the contract?");
 * numeric and market validity are decided later by the normalizer and the sanity engine.
 * Everything that knows about the *raw* shape lives in this class — no other component may
 * touch the raw payload.
 *
 * Accepted contract:
 *   {
 *     "gold":     [ { "symbol": string, "name"?: string, "price": number|string, "change_percent"?: number|string } ],
 *     "currency": [ … same … ],
 *     "timestamp"?: ISO string        // optional source timestamp
 *   }
 * `cryptocurrency` is ignored (it is part of the upstream feed but not of this product).
 */
@Injectable()
export class RawPayloadParser {
  private readonly logger = new Logger(RawPayloadParser.name);

  parse(payload: unknown): ParsedRawPayload {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new SchemaValidationError(
        'expected a JSON object at the top level',
      );
    }

    const raw = payload as Record<string, unknown>;
    const hasGold = raw.gold !== undefined && raw.gold !== null;
    const hasCurrency = raw.currency !== undefined && raw.currency !== null;

    if (!hasGold && !hasCurrency) {
      throw new SchemaValidationError(
        'neither "gold" nor "currency" is present',
      );
    }

    const entries: RawPriceEntry[] = [
      ...this.parseSection(raw.gold, 'gold'),
      ...this.parseSection(raw.currency, 'currency'),
    ];

    if (entries.length === 0) {
      throw new SchemaValidationError(
        'no symbol entries found in "gold"/"currency"',
      );
    }

    return {
      entries,
      sourceTimestamp: this.parseSourceTimestamp(raw.timestamp),
    };
  }

  private parseSection(section: unknown, sectionName: string): RawPriceEntry[] {
    if (section === undefined || section === null) {
      return [];
    }

    if (!Array.isArray(section)) {
      throw new SchemaValidationError(`"${sectionName}" must be an array`);
    }

    return section.map((item, index) =>
      this.parseEntry(item, sectionName, index),
    );
  }

  private parseEntry(
    item: unknown,
    sectionName: string,
    index: number,
  ): RawPriceEntry {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SchemaValidationError(
        `"${sectionName}[${index}]" must be an object`,
      );
    }

    const entry = item as Record<string, unknown>;

    if (typeof entry.symbol !== 'string' || entry.symbol.trim() === '') {
      throw new SchemaValidationError(
        `"${sectionName}[${index}]" has no usable "symbol" string`,
      );
    }

    if (entry.price === undefined) {
      throw new SchemaValidationError(
        `"${sectionName}[${index}]" (${entry.symbol}) has no "price" field`,
      );
    }

    return {
      symbol: entry.symbol.trim(),
      name:
        typeof entry.name === 'string' && entry.name.trim() !== ''
          ? entry.name.trim()
          : null,
      rawPrice: entry.price,
      rawChangePercent: entry.change_percent ?? null,
    };
  }

  private parseSourceTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }

    const parsed = Date.parse(value);

    if (Number.isNaN(parsed)) {
      this.logger.warn(
        'Ignoring an unparsable source timestamp in the price payload.',
      );
      return null;
    }

    return new Date(parsed).toISOString();
  }
}

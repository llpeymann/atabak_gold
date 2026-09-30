import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import { AppConfigService, PriceApiConfig } from '../config/app-config.service';
import { parseAmount, toRial } from '../common/money';
import { describeError, sanitizeUrl, truncate } from '../common/log-safety';
import {
  MarketData,
  MarketPriceItem,
  RawMarketPayload,
} from './price.interface';
import { PriceApiError } from './price.error';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Price API client.
 *
 * Phase 0 guarantees implemented here:
 *  - configurable, enforced request timeout (no indefinite waits),
 *  - bounded retry with exponential backoff for transient failures only,
 *  - payload validation: malformed or unusable data raises an error instead of being
 *    published, so a failed request can never turn into a fake price.
 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly config: AppConfigService,
  ) {}

  async getMarketData(): Promise<MarketData> {
    const priceApi = this.config.priceApi;
    let lastError: PriceApiError | null = null;

    for (let attempt = 1; attempt <= priceApi.maxAttempts; attempt += 1) {
      try {
        const payload = await this.requestOnce(priceApi, attempt);
        const marketData = this.normalizePayload(payload, priceApi);

        if (attempt > 1) {
          this.logger.log(
            `Price API request succeeded on attempt ${attempt}/${priceApi.maxAttempts}.`,
          );
        }

        return marketData;
      } catch (error) {
        const apiError = this.toPriceApiError(error, priceApi);
        lastError = apiError;

        const hasAttemptsLeft = attempt < priceApi.maxAttempts;
        if (!apiError.retryable || !hasAttemptsLeft) {
          this.logger.error(
            `Price API request permanently failed after ${attempt} attempt(s): ${apiError.message}`,
          );
          break;
        }

        const delayMs = priceApi.retryDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `Price API request failed (attempt ${attempt}/${priceApi.maxAttempts}): ` +
            `${apiError.message} — retrying in ${delayMs}ms`,
        );
        await this.delay(delayMs);
      }
    }

    throw (
      lastError ??
      new PriceApiError('Price API request failed', {
        attempts: priceApi.maxAttempts,
      })
    );
  }

  private async requestOnce(
    priceApi: PriceApiConfig,
    attempt: number,
  ): Promise<unknown> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<unknown>(priceApi.url, {
          timeout: priceApi.timeoutMs,
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        }),
      );

      return response.data;
    } catch (error) {
      throw this.toPriceApiError(error, priceApi, attempt);
    }
  }

  private toPriceApiError(
    error: unknown,
    priceApi: PriceApiConfig,
    attempt = 1,
  ): PriceApiError {
    if (error instanceof PriceApiError) {
      return error;
    }

    const target = sanitizeUrl(priceApi.url);

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      if (status !== undefined) {
        const body = truncate(JSON.stringify(error.response?.data ?? ''));
        return new PriceApiError(
          `Price API responded with HTTP ${status}${body ? ` — ${body}` : ''}`,
          {
            status,
            retryable: status >= 500 || status === 429,
            attempts: attempt,
          },
        );
      }

      // No response at all: connection problem, DNS failure or the configured timeout.
      return new PriceApiError(
        `Price API request to ${target} failed: ${describeError(error)}`,
        { retryable: true, attempts: attempt },
      );
    }

    return new PriceApiError(
      `Unexpected error while calling ${target}: ${describeError(error)}`,
      { retryable: false, attempts: attempt },
    );
  }

  private normalizePayload(
    payload: unknown,
    priceApi: PriceApiConfig,
  ): MarketData {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new PriceApiError(
        'Price API returned an unexpected payload (expected a JSON object)',
      );
    }

    const raw = payload as RawMarketPayload;
    const gold = this.normalizeSection(raw.gold, 'gold', priceApi);
    const currency = this.normalizeSection(raw.currency, 'currency', priceApi);

    if (gold.length === 0 && currency.length === 0) {
      throw new PriceApiError(
        'Price API returned no usable prices — nothing will be published',
      );
    }

    return { gold, currency, fetchedAt: new Date().toISOString() };
  }

  private normalizeSection(
    rawSection: unknown,
    sectionName: 'gold' | 'currency',
    priceApi: PriceApiConfig,
  ): MarketPriceItem[] {
    if (rawSection === undefined || rawSection === null) {
      this.logger.warn(`Price API payload has no "${sectionName}" section.`);
      return [];
    }

    if (!Array.isArray(rawSection)) {
      throw new PriceApiError(
        `Price API payload has an invalid "${sectionName}" section (expected an array)`,
      );
    }

    const items: MarketPriceItem[] = [];

    for (const rawItem of rawSection) {
      const item = this.normalizeItem(rawItem, sectionName, priceApi);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  private normalizeItem(
    rawItem: unknown,
    sectionName: string,
    priceApi: PriceApiConfig,
  ): MarketPriceItem | null {
    if (typeof rawItem !== 'object' || rawItem === null) {
      this.logger.warn(
        `Skipped a malformed item in "${sectionName}" (not an object).`,
      );
      return null;
    }

    const item = rawItem as RawMarketPayload;
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim() : '';

    if (symbol === '') {
      this.logger.warn(`Skipped an item in "${sectionName}" without a symbol.`);
      return null;
    }

    const amount = parseAmount(item.price);
    if (amount === null || amount <= 0) {
      this.logger.warn(
        `Skipped "${symbol}" in "${sectionName}": the API did not provide a usable price.`,
      );
      return null;
    }

    const unit = priceApi.symbolUnits[symbol] ?? priceApi.sourceUnit;
    const changePercent = parseAmount(item.change_percent);

    const normalized: MarketPriceItem = {
      symbol,
      priceInRial: toRial(amount, unit),
      changePercent,
    };

    if (typeof item.name === 'string' && item.name.trim() !== '') {
      normalized.name = item.name.trim();
    }

    return normalized;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

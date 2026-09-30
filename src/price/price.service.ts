import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import { AppConfigService, PriceApiConfig } from '../config/app-config.service';
import { describeError, sanitizeUrl, truncate } from '../common/log-safety';
import { PriceApiError } from './price.error';

/** Raw payload as returned by the provider — deliberately untyped domain-wise. */
export interface RawPriceFetch {
  payload: unknown;
  /** When this application received the response (never the provider's own timestamp). */
  receivedAt: string;
  /** Sanitized source identifier (no credentials, no query string). */
  source: string;
}

/**
 * Price provider.
 *
 * Phase 1 keeps this class focused on *transport only*: fetch the external payload reliably
 * (timeout, bounded retry for transient failures) and hand it over untouched. Parsing, schema
 * validation, normalization and market sanity all live in `src/market/*`, so the provider can
 * never decide on its own what a valid price is.
 */
@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly config: AppConfigService,
  ) {}

  async fetchRawPayload(): Promise<RawPriceFetch> {
    const priceApi = this.config.priceApi;
    let lastError: PriceApiError | null = null;

    for (let attempt = 1; attempt <= priceApi.maxAttempts; attempt += 1) {
      try {
        const payload = await this.requestOnce(priceApi, attempt);

        if (attempt > 1) {
          this.logger.log(
            `Price API request succeeded on attempt ${attempt}/${priceApi.maxAttempts}.`,
          );
        }

        return {
          payload,
          receivedAt: new Date().toISOString(),
          source: sanitizeUrl(priceApi.url),
        };
      } catch (error) {
        const apiError = this.toPriceApiError(error, priceApi, attempt);
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
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    attempt: number,
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

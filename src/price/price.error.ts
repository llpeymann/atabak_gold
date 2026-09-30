/**
 * Error type of the price API client.
 * `retryable` decides whether the retry loop is allowed to try again: transient transport
 * problems, timeouts, HTTP 5xx and HTTP 429 are retryable; configuration/URL/auth and other
 * permanent 4xx failures are not.
 */
export class PriceApiError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly attempts: number;

  constructor(
    message: string,
    options: { retryable?: boolean; status?: number; attempts?: number } = {},
  ) {
    super(message);
    this.name = 'PriceApiError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.attempts = options.attempts ?? 1;
  }
}

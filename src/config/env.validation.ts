import { Logger } from '@nestjs/common';

import { isMoneyUnit, MoneyUnit } from '../common/money';

/**
 * Startup validation for environment variables.
 *
 * Registered as `ConfigModule.forRoot({ validate })`, so the application refuses to start
 * with a clear message when a required variable is missing — instead of starting fine and
 * failing later inside a cron execution.
 *
 * The returned object keeps flat string values (it is merged into the runtime config),
 * while `AppConfigService` exposes a typed view of it.
 */

export class EnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentValidationError';
  }
}

export const REQUIRED_ENVIRONMENT_VARIABLES = [
  'PRICE_API_URL',
  'BALE_BOT_TOKEN',
  'BALE_CHANNEL_ID',
] as const;

export const ENVIRONMENT_DEFAULTS: Readonly<Record<string, string>> = {
  PORT: '3000',
  PRICE_API_TIMEOUT_MS: '20000',
  PRICE_API_MAX_ATTEMPTS: '3',
  PRICE_API_RETRY_DELAY_MS: '1500',
  PRICE_API_UNIT: 'RIAL',
  PRICE_DISPLAY_UNIT: 'RIAL',
  PRICE_SYMBOL_UNITS: '',
  DELIVERY_TIMEOUT_MS: '20000',
  // --- Phase 1: market reliability ---
  // Per-update change tolerance (%) used for symbols without a registry-specific value.
  PRICE_MAX_CHANGE_PERCENT: '8',
  // Optional per-symbol tolerance overrides, e.g. "XAUUSD=10,TRY=12".
  PRICE_THRESHOLD_OVERRIDES: '',
  // Multiplier applied when the comparison baseline comes from a previous Tehran day.
  PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '2',
  // A symbol whose last successful update is older than this is reported as STALE.
  PRICE_STALE_AFTER_MINUTES: '45',
  // Where the minimal market state is persisted (empty string disables persistence).
  MARKET_STATE_FILE: './data/market-state.json',
  // Admin alert destination for rejected anomalies (empty = log-only).
  ANOMALY_ALERT_CHAT_ID: '',
  // De-duplication window per symbol+reason for anomaly alerts.
  ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
};

const logger = new Logger('EnvironmentValidation');

/** Safe conversion to a plain string (objects never end up as `[object Object]`). */
function toPlainString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  return '';
}

function isBlank(value: unknown): boolean {
  return toPlainString(value).trim() === '';
}

function asString(env: Record<string, unknown>, key: string): string {
  return toPlainString(env[key]).trim();
}

function readInteger(
  env: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string {
  const raw = asString(env, key);
  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected an integer between ${min} and ${max}`,
    );
  }

  return raw;
}

/** Read a decimal number (thresholds are percentages, so they are not necessarily integers). */
function readNumber(
  env: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string {
  const raw = asString(env, key);
  const value = Number(raw);

  if (!Number.isFinite(value) || value < min || value > max) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected a number between ${min} and ${max}`,
    );
  }

  return raw;
}

function readMoneyUnit(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key).toUpperCase();

  if (!isMoneyUnit(raw)) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected one of RIAL, TOMAN`,
    );
  }

  return raw;
}

/**
 * Parse `PRICE_SYMBOL_UNITS` (format: `SYMBOL=UNIT,SYMBOL=UNIT`) into a lookup table.
 * Symbols absent from the table are treated as being expressed in `PRICE_API_UNIT`.
 */
export function parseSymbolUnits(raw: unknown): Record<string, MoneyUnit> {
  const result: Record<string, MoneyUnit> = {};

  if (isBlank(raw)) {
    return result;
  }

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (entry === '') {
      continue;
    }

    const [symbolPart, unitPart] = entry.split('=');
    const symbol = (symbolPart ?? '').trim();
    const unit = (unitPart ?? '').trim().toUpperCase();

    if (symbol === '' || !isMoneyUnit(unit)) {
      throw new EnvironmentValidationError(
        `Invalid PRICE_SYMBOL_UNITS entry "${entry}" — expected the format SYMBOL=RIAL|TOMAN`,
      );
    }

    result[symbol] = unit;
  }

  return result;
}

/**
 * Parse `PRICE_THRESHOLD_OVERRIDES` (format: `SYMBOL=PERCENT,SYMBOL=PERCENT`) into a lookup table.
 * Symbols absent from the table keep their registry-defined tolerance.
 */
export function parseThresholdOverrides(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};

  if (isBlank(raw)) {
    return result;
  }

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (entry === '') {
      continue;
    }

    const [symbolPart, percentPart] = entry.split('=');
    const symbol = (symbolPart ?? '').trim();
    const percent = Number((percentPart ?? '').trim());

    if (
      symbol === '' ||
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent > 100
    ) {
      throw new EnvironmentValidationError(
        `Invalid PRICE_THRESHOLD_OVERRIDES entry "${entry}" — expected the format SYMBOL=PERCENT (0 < percent ≤ 100)`,
      );
    }

    result[symbol] = percent;
  }

  return result;
}

export function validateEnvironment(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const env: Record<string, unknown> = { ...rawConfig };

  for (const [key, value] of Object.entries(ENVIRONMENT_DEFAULTS)) {
    if (isBlank(env[key])) {
      env[key] = value;
    }
  }

  for (const key of REQUIRED_ENVIRONMENT_VARIABLES) {
    if (isBlank(env[key])) {
      throw new EnvironmentValidationError(
        `Missing required environment variable: ${key}`,
      );
    }
  }

  const priceApiUrl = asString(env, 'PRICE_API_URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(priceApiUrl);
  } catch {
    throw new EnvironmentValidationError(
      `Invalid PRICE_API_URL: "${priceApiUrl}" is not a valid absolute URL`,
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new EnvironmentValidationError(
      `Invalid PRICE_API_URL: protocol "${parsedUrl.protocol}" is not supported (use http or https)`,
    );
  }

  env.PORT = readInteger(env, 'PORT', 1, 65535);
  env.PRICE_API_TIMEOUT_MS = readInteger(
    env,
    'PRICE_API_TIMEOUT_MS',
    1000,
    300_000,
  );
  env.PRICE_API_MAX_ATTEMPTS = readInteger(
    env,
    'PRICE_API_MAX_ATTEMPTS',
    1,
    10,
  );
  env.PRICE_API_RETRY_DELAY_MS = readInteger(
    env,
    'PRICE_API_RETRY_DELAY_MS',
    0,
    60_000,
  );
  env.DELIVERY_TIMEOUT_MS = readInteger(
    env,
    'DELIVERY_TIMEOUT_MS',
    1000,
    300_000,
  );

  env.PRICE_MAX_CHANGE_PERCENT = readNumber(
    env,
    'PRICE_MAX_CHANGE_PERCENT',
    0.1,
    100,
  );
  env.PRICE_CROSS_DAY_CHANGE_MULTIPLIER = readNumber(
    env,
    'PRICE_CROSS_DAY_CHANGE_MULTIPLIER',
    1,
    20,
  );
  env.PRICE_STALE_AFTER_MINUTES = readInteger(
    env,
    'PRICE_STALE_AFTER_MINUTES',
    1,
    10_080,
  );
  env.ANOMALY_ALERT_COOLDOWN_MINUTES = readInteger(
    env,
    'ANOMALY_ALERT_COOLDOWN_MINUTES',
    0,
    10_080,
  );
  parseThresholdOverrides(env.PRICE_THRESHOLD_OVERRIDES); // validation only

  env.PRICE_API_UNIT = readMoneyUnit(env, 'PRICE_API_UNIT');
  env.PRICE_DISPLAY_UNIT = readMoneyUnit(env, 'PRICE_DISPLAY_UNIT');
  parseSymbolUnits(env.PRICE_SYMBOL_UNITS); // validation only — the raw string is kept as is

  const hasTelegramToken = !isBlank(env.TELEGRAM_BOT_TOKEN);
  const hasTelegramChannel = !isBlank(env.TELEGRAM_CHANNEL_ID);

  if (hasTelegramToken !== hasTelegramChannel) {
    logger.warn(
      'Telegram is only partially configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID): ' +
        'Telegram delivery stays disabled until both are provided.',
    );
  }

  return env;
}

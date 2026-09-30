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

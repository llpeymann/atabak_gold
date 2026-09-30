/**
 * Reusable test doubles (development/test only — excluded from the production build).
 */
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';

import { AppConfigService } from '../config/app-config.service';

export type EnvMap = Record<string, string | undefined>;

export const DEFAULT_TEST_ENV: EnvMap = {
  PORT: '3000',
  PRICE_API_URL: 'https://api.example.test/prices',
  PRICE_API_TIMEOUT_MS: '2000',
  PRICE_API_MAX_ATTEMPTS: '3',
  PRICE_API_RETRY_DELAY_MS: '1',
  PRICE_API_UNIT: 'RIAL',
  PRICE_DISPLAY_UNIT: 'RIAL',
  PRICE_SYMBOL_UNITS: '',
  DELIVERY_TIMEOUT_MS: '2000',
  BALE_BOT_TOKEN: 'bale-token',
  BALE_CHANNEL_ID: 'bale-channel',
};

export function createConfigService(overrides: EnvMap = {}): ConfigService {
  const values: EnvMap = { ...DEFAULT_TEST_ENV, ...overrides };

  return {
    get: (key: string): string | undefined => values[key],
  } as unknown as ConfigService;
}

export function createAppConfigService(
  overrides: EnvMap = {},
): AppConfigService {
  return new AppConfigService(createConfigService(overrides));
}

export interface HttpServiceDouble {
  service: HttpService;
  get: jest.Mock;
  post: jest.Mock;
}

export function createHttpServiceDouble(): HttpServiceDouble {
  const get = jest.fn();
  const post = jest.fn();

  return {
    service: { get, post } as unknown as HttpService,
    get,
    post,
  };
}

/**
 * Reusable test doubles (development/test only — excluded from the production build).
 */
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';

import { BaleService } from '../bale/bale.service';
import { DeliveryResult } from '../bale/delivery-result';
import { AppConfigService } from '../config/app-config.service';
import { AnomalyAlertService } from '../market/anomaly-alert.service';
import { MarketEngineService } from '../market/market-engine.service';
import { MarketStateService } from '../market/market-state.service';
import { MarketStateStore } from '../market/market-state.store';
import { PriceNormalizer } from '../market/price-normalizer.service';
import { RawPayloadParser } from '../market/raw-payload.parser';
import { SanityChecker } from '../market/sanity-checker.service';

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
  PRICE_MAX_CHANGE_PERCENT: '8',
  PRICE_THRESHOLD_OVERRIDES: '',
  PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '2',
  PRICE_STALE_AFTER_MINUTES: '45',
  MARKET_STATE_FILE: '',
  ANOMALY_ALERT_CHAT_ID: '',
  ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
};

export function createConfigService(overrides: EnvMap = {}): ConfigService {
  const values: EnvMap = { ...DEFAULT_TEST_ENV, ...overrides };
  const store = values as Record<string, string | undefined>;

  return {
    get: (key: string): string | undefined => store[key],
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

export interface BaleServiceDouble {
  service: BaleService;
  sendMessage: jest.Mock<Promise<DeliveryResult[]>, [string]>;
  sendMessageTo: jest.Mock<Promise<DeliveryResult[]>, [string, string]>;
}

export function deliverySuccess(
  platform: 'bale' | 'telegram' = 'bale',
): DeliveryResult {
  return {
    platform,
    channel: `${platform}-channel`,
    messageType: 'text',
    timestamp: new Date().toISOString(),
    durationMs: 3,
    success: true,
  };
}

export function createBaleServiceDouble(
  results: DeliveryResult[] = [deliverySuccess()],
): BaleServiceDouble {
  const sendMessage = jest.fn(() => Promise.resolve(results));
  const sendMessageTo = jest.fn(() => Promise.resolve(results));

  return {
    service: {
      sendMessage,
      sendMessageTo,
      platforms: ['bale'],
    } as unknown as BaleService,
    sendMessage,
    sendMessageTo,
  };
}

export interface MarketHarness {
  config: AppConfigService;
  parser: RawPayloadParser;
  normalizer: PriceNormalizer;
  sanityChecker: SanityChecker;
  store: MarketStateStore;
  marketState: MarketStateService;
  alerts: AnomalyAlertService;
  bale: BaleServiceDouble;
  engine: MarketEngineService;
}

/**
 * Builds the complete market reliability pipeline with in-memory defaults
 * (`MARKET_STATE_FILE=''`), so unit tests never touch the filesystem unless they opt in.
 */
export function createMarketHarness(
  env: EnvMap = {},
  options: { alertResults?: DeliveryResult[] } = {},
): MarketHarness {
  const config = createAppConfigService(env);
  const parser = new RawPayloadParser();
  const normalizer = new PriceNormalizer(config);
  const sanityChecker = new SanityChecker(config);
  const store = new MarketStateStore(config);
  const marketState = new MarketStateService(config, store);
  const bale = createBaleServiceDouble(
    options.alertResults ?? [deliverySuccess()],
  );
  const alerts = new AnomalyAlertService(config, bale.service);
  const engine = new MarketEngineService(
    config,
    parser,
    normalizer,
    sanityChecker,
    marketState,
    alerts,
  );

  return {
    config,
    parser,
    normalizer,
    sanityChecker,
    store,
    marketState,
    alerts,
    bale,
    engine,
  };
}

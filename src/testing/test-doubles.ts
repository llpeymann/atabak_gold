/**
 * Reusable test doubles (development/test only — excluded from the production build).
 */
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';

import { BaleService } from '../bale/bale.service';
import { DeliveryResult } from '../bale/delivery-result';
import { AlertNotificationService } from '../alerts/alert-notification.service';
import { AlertService } from '../alerts/alert.service';
import { AlertStore } from '../alerts/alert.store';
import { BotUxService } from '../bot/ux/bot-ux.service';
import { MarketViewService } from '../bot/ux/market-view.service';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { UxEventLogService } from '../bot/ux/ux-event-log.service';
import { BotApiClient } from '../platform/bot-api.client';
import { PlatformRegistry } from '../platform/platform-registry.service';
import {
  InboundUpdate,
  Platform,
  PlatformSendResult,
} from '../platform/platform.types';
import { UserService } from '../users/user.service';
import { UserStore } from '../users/user.store';
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
  // --- Phase 2 (in-memory defaults: no file, no polling) ---
  USER_DATA_FILE: '',
  MAX_FAVORITES: '10',
  CHANNEL_HANDLE: '@tala_atabak',
  CHANNEL_URL: 'https://ble.ir/tala_atabak',
  BOT_POLLING_ENABLED: 'false',
  BOT_POLL_TIMEOUT_SECONDS: '0',
  BOT_POLL_RETRY_DELAY_MS: '1',
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
  get: jest.Mock<unknown, [string, unknown?]>;
  post: jest.Mock<unknown, [string, unknown, unknown?]>;
}

export function createHttpServiceDouble(): HttpServiceDouble {
  const get = jest.fn<unknown, [string, unknown?]>();
  const post = jest.fn<unknown, [string, unknown, unknown?]>();

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
  // The parameters are declared so the mock keeps the real service signature.
  const sendMessage = jest.fn((text: string) => {
    void text;
    return Promise.resolve(results);
  });
  const sendMessageTo = jest.fn((chatId: string, text: string) => {
    void chatId;
    void text;
    return Promise.resolve(results);
  });

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

// ---------------------------------------------------------------------------
// Phase 2 — platform + bot UX harness
// ---------------------------------------------------------------------------

/** Wire shape of the inline keyboard actually handed to the platform. */
export interface WireKeyboard {
  inline_keyboard: {
    text: string;
    callback_data?: string;
    url?: string;
  }[][];
}

/** One call the UX layer made through a platform adapter. */
export interface PlatformCall {
  kind: 'send' | 'edit' | 'ack' | 'poll';
  platform: Platform;
  chatId: string;
  text?: string;
  /** Reply markup as sent over the wire (undefined when the message has no buttons). */
  markup?: WireKeyboard | null;
  messageId?: number | null;
  callbackId?: string;
  alertText?: string;
  /** Present for `send`/`edit`: whether the platform accepted the call. */
  success?: boolean;
}

/** Flatten the buttons of a rendered message (wire level: callback_data/url included). */
export function keyboardButtons(
  call: PlatformCall,
): { text: string; callbackData?: string; url?: string }[] {
  const rows = call.markup?.inline_keyboard ?? [];

  return rows.flat().map((button) => ({
    text: button.text,
    callbackData: button.callback_data,
    url: button.url,
  }));
}

export interface PlatformHarness {
  config: AppConfigService;
  registry: PlatformRegistry;
  client: {
    getUpdates: jest.Mock;
    sendMessage: jest.Mock;
    editMessageText: jest.Mock;
    answerCallbackQuery: jest.Mock;
  };
  calls: PlatformCall[];
  /** Queue inbound updates returned by the next `getUpdates` round. */
  queueUpdates: (updates: InboundUpdate[]) => void;
  /** Make `editMessageText` fail (platforms refuse edits on old messages). */
  failEdits: (fail: boolean) => void;
  /**
   * Make the next `failures` **sends** fail (Phase 3 notification reliability): used to exercise
   * retries and the "bounded attempts" rule without any real platform call.
   */
  failSends: (failures: number) => void;
  /** Reject the next `failures` sends with a thrown transport error instead of a failed result. */
  throwSends: (failures: number) => void;
}

/**
 * Real `PlatformRegistry`/adapters on top of a fake Bot API client: the platform-independent
 * UX core is exercised exactly as in production, without any network access.
 */
export function createPlatformHarness(env: EnvMap = {}): PlatformHarness {
  const config = createAppConfigService({
    BOT_POLLING_ENABLED: 'true',
    ...env,
  });
  const calls: PlatformCall[] = [];
  let queued: InboundUpdate[] = [];
  let messageId = 1000;
  let editsFail = false;
  let sendsToFail = 0;
  let sendsToThrow = 0;

  const getUpdates = jest.fn((platform: Platform, offset: number) => {
    calls.push({ kind: 'poll', platform, chatId: '', messageId: offset });
    const batch = queued.filter((update) => update.updateId >= offset);
    queued = queued.filter((update) => update.updateId < offset);

    return Promise.resolve({
      updates: batch,
      nextOffset: batch.length > 0 ? batch[batch.length - 1].updateId + 1 : 0,
    });
  });

  const sendMessage = jest.fn(
    (
      platform: Platform,
      chatId: string,
      text: string,
      markup?: WireKeyboard | null,
    ): Promise<PlatformSendResult> => {
      const id = ++messageId;
      const failing = sendsToFail > 0;
      const throwing = sendsToThrow > 0;

      if (failing) {
        sendsToFail -= 1;
      }

      if (throwing) {
        sendsToThrow -= 1;
        calls.push({
          kind: 'send',
          platform,
          chatId,
          text,
          markup: markup ?? null,
          messageId: null,
          success: false,
        });
        return Promise.reject(new Error('transport failure'));
      }

      calls.push({
        kind: 'send',
        platform,
        chatId,
        text,
        markup: markup ?? null,
        messageId: failing ? null : id,
        success: !failing,
      });

      return Promise.resolve({
        platform,
        chatId,
        success: !failing,
        edited: false,
        messageId: failing ? null : id,
        ...(failing ? { error: 'HTTP 502 — Bad Gateway' } : {}),
      });
    },
  );

  const editMessageText = jest.fn(
    (
      platform: Platform,
      chatId: string,
      targetId: number,
      text: string,
      markup?: WireKeyboard | null,
    ): Promise<PlatformSendResult> => {
      calls.push({
        kind: 'edit',
        platform,
        chatId,
        text,
        markup: markup ?? null,
        messageId: targetId,
        success: !editsFail,
      });

      if (editsFail) {
        return Promise.resolve({
          platform,
          chatId,
          success: false,
          edited: true,
          messageId: null,
          error: 'HTTP 400 — message can not be edited',
        });
      }

      return Promise.resolve({
        platform,
        chatId,
        success: true,
        edited: true,
        messageId: targetId,
      });
    },
  );

  const answerCallbackQuery = jest.fn(
    (platform: Platform, callbackId: string, text?: string) => {
      calls.push({
        kind: 'ack',
        platform,
        chatId: '',
        callbackId,
        alertText: text,
      });
      return Promise.resolve();
    },
  );

  const client = {
    getUpdates,
    sendMessage,
    editMessageText,
    answerCallbackQuery,
  } as unknown as BotApiClient;

  return {
    config,
    registry: new PlatformRegistry(config, client),
    client: { getUpdates, sendMessage, editMessageText, answerCallbackQuery },
    calls,
    queueUpdates: (updates) => {
      queued = [...queued, ...updates];
    },
    failEdits: (fail) => {
      editsFail = fail;
    },
    failSends: (failures) => {
      sendsToFail = failures;
    },
    throwSends: (failures) => {
      sendsToThrow = failures;
    },
  };
}

export interface UxHarness {
  config: AppConfigService;
  platform: PlatformHarness;
  market: MarketHarness;
  store: UserStore;
  users: UserService;
  views: MarketViewService;
  events: UxEventLogService;
  alerts: AlertService;
  alertStore: AlertStore;
  notifications: AlertNotificationService;
  botUx: BotUxService;
  /** Rendered platform calls of a given kind. */
  rendered: () => PlatformCall[];
  /** Newest rendered message (send or edit). */
  last: () => PlatformCall;
  /** Buttons of the newest rendered message. */
  buttons: () => { text: string; callbackData?: string; url?: string }[];
}

/** Complete Phase 2 UX stack (user store → views → router → platform adapters). */
export function createUxHarness(
  env: EnvMap = {},
  options: { store?: UserStore; alertStore?: AlertStore } = {},
): UxHarness {
  const config = createAppConfigService(env);
  const market = createMarketHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const platform = createPlatformHarness({
    ...env,
    BOT_POLLING_ENABLED: 'false',
  });
  const store = options.store ?? new UserStore(config);
  const users = new UserService(config, store);
  const intelligence = new MarketIntelligenceService(
    config,
    market.marketState,
  );
  const views = new MarketViewService(
    config,
    market.marketState,
    intelligence,
    users,
  );
  const events = new UxEventLogService();
  const alertStore = options.alertStore ?? new AlertStore(config);
  const alerts = new AlertService(
    config,
    alertStore,
    market.marketState,
    store,
  );
  const notifications = new AlertNotificationService(
    config,
    alerts,
    alertStore,
    platform.registry,
    store,
  );
  const botUx = new BotUxService(
    config,
    platform.registry,
    views,
    users,
    events,
    alerts,
  );

  const rendered = (): PlatformCall[] =>
    platform.calls.filter(
      (call) => call.kind === 'send' || call.kind === 'edit',
    );

  return {
    config,
    platform,
    market,
    store,
    users,
    views,
    events,
    alerts,
    alertStore,
    notifications,
    botUx,
    rendered,
    last: () => {
      const all = rendered();
      if (all.length === 0) {
        throw new Error('No message has been rendered yet.');
      }
      return all[all.length - 1];
    },
    buttons: () => {
      const all = rendered();
      if (all.length === 0) {
        throw new Error('No message has been rendered yet.');
      }
      return keyboardButtons(all[all.length - 1]);
    },
  };
}

export interface SeedOptions {
  receivedAt?: Date;
  /** Symbol values to override (RIAL for Iranian instruments, USD for XAUUSD). */
  prices?: Record<string, number>;
  /** When true, `prices` replaces the defaults instead of extending them. */
  replace?: boolean;
}

/** Sane defaults for every registry symbol (used to seed market state in UX tests). */
export const DEFAULT_SEED_PRICES: Record<string, number> = {
  XAUUSD: 4_025,
  IR_GOLD_18K: 17_500_000,
  IR_GOLD_24K: 23_300_000,
  IR_GOLD_MELTED: 16_900_000,
  IR_COIN_EMAMI: 92_000_000,
  IR_COIN_BAHAR: 85_000_000,
  IR_COIN_HALF: 47_000_000,
  IR_COIN_QUARTER: 29_000_000,
  IR_COIN_1G: 9_800_000,
  USDT_IRT: 1_050_000,
  USD: 1_055_000,
  EUR: 1_240_000,
  GBP: 1_420_000,
  TRY: 31_000,
  AED: 287_000,
  CNY: 148_000,
};

const SEED_SECTIONS: Record<string, 'gold' | 'coins' | 'currency'> = {
  XAUUSD: 'gold',
  IR_GOLD_18K: 'gold',
  IR_GOLD_24K: 'gold',
  IR_GOLD_MELTED: 'gold',
  IR_COIN_EMAMI: 'coins',
  IR_COIN_BAHAR: 'coins',
  IR_COIN_HALF: 'coins',
  IR_COIN_QUARTER: 'coins',
  IR_COIN_1G: 'coins',
  USDT_IRT: 'currency',
  USD: 'currency',
  EUR: 'currency',
  GBP: 'currency',
  TRY: 'currency',
  AED: 'currency',
  CNY: 'currency',
};

/** Build a raw API payload (the exact shape the provider returns). */
export function rawPricePayload(
  prices: Record<string, number> = DEFAULT_SEED_PRICES,
  sourceTimestamp: string | null = null,
): unknown {
  const gold: unknown[] = [];
  const currency: unknown[] = [];

  for (const [symbol, price] of Object.entries(prices)) {
    const entry = { symbol, price };
    if (SEED_SECTIONS[symbol] === 'gold') {
      gold.push(entry);
    } else {
      currency.push(entry);
    }
  }

  return {
    ...(sourceTimestamp ? { timestamp: sourceTimestamp } : {}),
    gold,
    currency,
  };
}

/**
 * Run one market cycle so the UX layer has validated state to display.
 * Accepts either a `MarketHarness` or an object that carries one (`UxHarness`).
 */
export async function seedMarketState(
  harness: MarketHarness | { market: MarketHarness },
  options: SeedOptions = {},
): Promise<void> {
  const engine = 'market' in harness ? harness.market.engine : harness.engine;
  const receivedAt = options.receivedAt ?? new Date('2026-09-30T09:00:00.000Z');
  const prices = options.replace
    ? { ...(options.prices ?? {}) }
    : { ...DEFAULT_SEED_PRICES, ...(options.prices ?? {}) };

  await engine.evaluateCycle(
    rawPricePayload(prices, receivedAt.toISOString()),
    receivedAt,
  );
}

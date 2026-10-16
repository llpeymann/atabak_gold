/**
 * Reusable test doubles (development/test only — excluded from the production build).
 */
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';

import { BaleService } from '../bale/bale.service';
import { DeliveryResult } from '../bale/delivery-result';
import { AlertNotificationService } from '../alerts/alert-notification.service';
import { AlertCapacityService } from '../alerts/alert-capacity.service';
import { ReferralService } from '../referrals/referral.service';
import { AlertService } from '../alerts/alert.service';
import { AlertStore } from '../alerts/alert.store';
import { BotUxService } from '../bot/ux/bot-ux.service';
import { CampaignAdminService } from '../bot/campaign/campaign-admin.service';
import { SalesAdminService } from '../bot/sales/sales-admin.service';
import { SalesNotificationService } from '../sales/sales-notification.service';
import { SalesService } from '../sales/sales.service';
import { SalesStore } from '../sales/sales.store';
import { SalesUxService } from '../bot/sales/sales-ux.service';
// Phase 10 — admin system
import { AdminStore } from '../admin/admin.store';
import { AdminAccessService } from '../admin/admin-access.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminActivityService } from '../admin/admin-activity.service';
import { AdminErrorService } from '../admin/admin-error.service';
import { AdminMetricsService } from '../admin/admin-metrics.service';
import { AdminBroadcastService } from '../admin/admin-broadcast.service';
import { AdminService } from '../bot/admin/admin.service';
import { CampaignConversionService } from '../campaigns/campaign-conversion.service';
import { CampaignMetricsService } from '../campaigns/campaign-metrics.service';
import { CampaignService } from '../campaigns/campaign.service';
import { CampaignStore } from '../campaigns/campaign.store';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';
import { PriceMessageBuilder } from '../bot/price-message.builder';
import { ContentAdminService } from '../bot/content/content-admin.service';
import { ChannelEngineService } from '../channel/channel-engine.service';
import { ChannelPolicyService } from '../channel/channel-policy.service';
import { CtaPolicyService } from '../channel/cta-policy.service';
import { BotDestinationService } from '../bot/destination.service';
import { ChannelPublisher } from '../channel/channel-publisher.service';
import { ContentService } from '../channel/content.service';
import { PublicationStore } from '../channel/publication.store';
import { PosterService } from '../poster/poster.service';
import { MarketViewService } from '../bot/ux/market-view.service';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import {
  MarketIntelligenceFreshness,
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
} from '../intelligence/market-intelligence.types';
import { UxEventLogService } from '../bot/ux/ux-event-log.service';
import { BotApiClient } from '../platform/bot-api.client';
import { PlatformRegistry } from '../platform/platform-registry.service';
import {
  InboundUpdate,
  Keyboard,
  Platform,
  PlatformFailureKind,
  PlatformPublishResult,
  PlatformSendResult,
} from '../platform/platform.types';
import { toReplyMarkup } from '../platform/platform-adapter';
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
  // --- Phase 5 (in-memory channel state, no admin surface) ---
  CHANNEL_DATA_FILE: '',
  CHANNEL_ADMIN_USER_IDS: '',
  CHANNEL_HISTORY_LIMIT: '500',
  CHANNEL_PUBLICATION_MAX_ATTEMPTS: '3',
  CHANNEL_PUBLICATION_RETRY_DELAY_MS: '1',
  CHANNEL_MISSED_JOB_GRACE_MINUTES: '30',
  CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1',
  CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES: '',
  CHANNEL_MOVEMENT_COOLDOWN_MINUTES: '120',
  CHANNEL_DAILY_RANGE_ENABLED: 'false',
  CHANNEL_DAILY_RANGE_TIME: '21:00',
  CHANNEL_DAILY_RANGE_EVENTS_ENABLED: 'false',
  CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES: '90',
  CHANNEL_DAILY_REPORT_ENABLED: 'false',
  CHANNEL_DAILY_REPORT_TIME: '23:00',
  // Phase 8: in-memory campaign store, explicit tracking config (no test ever touches `data/`).
  CAMPAIGN_DATA_FILE: '',
  CAMPAIGN_TRACKING_ENABLED: 'true',
  CAMPAIGN_ATTRIBUTION_WINDOW_DAYS: '30',
  CAMPAIGN_TRACKING_BASE_URL: '',
  CAMPAIGN_CHANNEL_JOIN_VERIFICATION: 'disabled',
  CAMPAIGN_RAW_EVENT_RETENTION_DAYS: '90',
  CAMPAIGN_MAX_RAW_EVENTS: '20000',
  // Phase 10: in-memory admin state (no file), broadcast *off* by default — a test must opt in
  // explicitly before anything can be sent, and no test ever reaches a live platform.
  ADMIN_DATA_FILE: '',
  ADMIN_OWNER_IDS: '',
  ADMIN_USER_IDS: '',
  ADMIN_PAGE_SIZE: '8',
  ADMIN_REPORT_MAX_DAYS: '90',
  ADMIN_ACTIVITY_RETENTION_DAYS: '120',
  ADMIN_MAX_AUDIT_RECORDS: '0',
  ADMIN_INCIDENT_RETENTION_DAYS: '30',
  ADMIN_MAX_INCIDENTS: '500',
  ADMIN_BROADCAST_ENABLED: 'false',
  ADMIN_BROADCAST_BATCH_SIZE: '20',
  ADMIN_BROADCAST_MIN_INTERVAL_MS: '0',
  ADMIN_BROADCAST_MAX_ATTEMPTS: '2',
  ADMIN_BROADCAST_MAX_MANUAL_RETRIES: '2',
  ADMIN_BROADCAST_BACKOFF_MS: '60000',
  ADMIN_BROADCAST_MAX_RECIPIENTS: '500',
  ADMIN_BROADCAST_MAX_LENGTH: '3000',
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
  kind: 'send' | 'edit' | 'ack' | 'poll' | 'publish';
  platform: Platform;
  chatId: string;
  text?: string;
  /** Reply markup as sent over the wire (undefined when the message has no buttons). */
  markup?: WireKeyboard | null;
  messageId?: number | null;
  callbackId?: string;
  alertText?: string;
  /** Present for `send`/`edit`/`publish`: whether the platform accepted the call. */
  success?: boolean;
  /** Present for `publish`: how the platform failed, when it did (§14). */
  failureKind?: PlatformFailureKind | null;
  /** Present for a photo publication: the media url that was sent. */
  media?: string | null;
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
    publishText: jest.Mock;
    publishPhoto: jest.Mock;
    /** Phase 8 — `getChatMember` double (channel-join verification). */
    getChatMember: jest.Mock;
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
  /**
   * Fail the next `times` channel publications with a classified failure (§13, §14).
   * `platform` scopes the failure to one destination, so partial delivery can be exercised.
   */
  failPublish: (
    kind: PlatformFailureKind,
    times?: number,
    platform?: Platform,
  ) => void;
  /** Fail the next `times` photo publications (media failure is tracked separately, §14). */
  failMedia: (kind: PlatformFailureKind, times?: number) => void;
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
  let publishFailure: PlatformFailureKind | null = null;
  let publishFailuresLeft = 0;
  let publishFailurePlatform: Platform | null = null;
  let mediaFailure: PlatformFailureKind | null = null;
  let mediaFailuresLeft = 0;
  let nextPublishId = 5000;

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

  /**
   * Phase 5 publication double (§27.2): the *classified* failure is returned exactly like the real
   * client does, so retry/ambiguous behaviour can be tested without any network access.
   */
  const publish = (
    kind: 'text' | 'photo',
    platform: Platform,
    chatId: string,
    text: string,
    photoUrl?: string,
    keyboard?: Keyboard,
  ): Promise<PlatformPublishResult> => {
    // Phase 6: the Channel → Bot CTA travels as a real reply markup, so the double records it the same
    // way the wire would carry it (§27.2 — assertions stay at the API level).
    const markup: WireKeyboard | null =
      keyboard === undefined ? null : (toReplyMarkup(keyboard) as WireKeyboard);
    const platformScoped =
      kind === 'photo' ||
      publishFailurePlatform === null ||
      publishFailurePlatform === platform;
    const failure =
      kind === 'photo' ? mediaFailure : platformScoped ? publishFailure : null;
    const failuresLeft =
      kind === 'photo' ? mediaFailuresLeft : publishFailuresLeft;

    if (failure !== null && failuresLeft > 0) {
      if (kind === 'photo') {
        mediaFailuresLeft -= 1;
      } else if (platformScoped) {
        publishFailuresLeft -= 1;
      }

      calls.push({
        kind: 'publish',
        platform,
        chatId,
        text,
        markup,
        messageId: null,
        success: false,
        failureKind: failure,
        media: kind === 'photo' ? (photoUrl ?? null) : null,
      });

      return Promise.resolve({
        platform,
        chatId,
        success: false,
        messageId: null,
        failureKind: failure,
        error:
          failure === 'AMBIGUOUS'
            ? 'timeout of 2000ms exceeded'
            : failure === 'RETRYABLE'
              ? 'HTTP 502 — Bad Gateway'
              : 'HTTP 400 — Bad Request: chat not found',
      });
    }

    const id = ++nextPublishId;

    calls.push({
      kind: 'publish',
      platform,
      chatId,
      text,
      markup,
      messageId: id,
      success: true,
      failureKind: null,
      media: kind === 'photo' ? (photoUrl ?? null) : null,
    });

    return Promise.resolve({
      platform,
      chatId,
      success: true,
      messageId: id,
      failureKind: null,
      error: null,
    });
  };

  const publishText = jest.fn(
    (platform: Platform, chatId: string, text: string, keyboard?: Keyboard) =>
      publish('text', platform, chatId, text, undefined, keyboard),
  );

  const publishPhoto = jest.fn(
    (
      platform: Platform,
      chatId: string,
      photoUrl: string,
      caption?: string,
      keyboard?: Keyboard,
    ) => publish('photo', platform, chatId, caption ?? '', photoUrl, keyboard),
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

  /**
   * Phase 8 — membership query double. The conservative default (`left`, answered by the platform)
   * means a test that forgets to set it can never fabricate a verified channel join.
   */
  const getChatMember = jest.fn((platform: Platform) =>
    Promise.resolve({
      platform,
      supported: true,
      answered: true,
      status: 'left',
      error: null,
    }),
  );

  const client = {
    getUpdates,
    sendMessage,
    editMessageText,
    answerCallbackQuery,
    publishText,
    publishPhoto,
    getChatMember,
  } as unknown as BotApiClient;

  return {
    config,
    registry: new PlatformRegistry(config, client),
    client: {
      getUpdates,
      sendMessage,
      editMessageText,
      answerCallbackQuery,
      getChatMember,
      publishText,
      publishPhoto,
    },
    failPublish: (
      kind: PlatformFailureKind,
      times = 1,
      platform?: Platform,
    ) => {
      publishFailure = kind;
      publishFailuresLeft = times;
      publishFailurePlatform = platform ?? null;
    },
    failMedia: (kind: PlatformFailureKind, times = 1) => {
      mediaFailure = kind;
      mediaFailuresLeft = times;
    },
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

/** One symbol of a hand-built Phase 4 snapshot (test-only). */
export interface SnapshotSymbolSeed {
  symbol: string;
  label?: string;
  unit?: 'RIAL' | 'USD';
  availability?: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE';
  freshness?: 'FRESH' | 'STALE' | null;
  currentPrice?: number | null;
  previousPrice?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  dailyChangePercent?: number | null;
  movementPercent?: number | null;
  lastUpdatedAt?: string | null;
}

/**
 * Build a Phase 4 snapshot for tests without involving Phase 1.
 *
 * When a value is not supplied it stays `null` (or `UNKNOWN`) — exactly the rule the real snapshot
 * follows — so a test that forgets to provide data can never accidentally assert against a
 * fabricated zero.
 */
export function makeSnapshot(
  seeds: readonly SnapshotSymbolSeed[],
  options: {
    freshness?: MarketIntelligenceFreshness;
    lastUpdate?: string | null;
    now?: Date;
  } = {},
): MarketIntelligenceSnapshot {
  const symbols: MarketSymbolSnapshot[] = seeds.map((seed) => {
    const currentPrice = seed.currentPrice ?? null;
    const previousPrice = seed.previousPrice ?? null;
    const open = seed.open ?? null;
    const movement =
      currentPrice !== null && previousPrice !== null
        ? currentPrice - previousPrice
        : null;
    const movementPercent =
      movement !== null && previousPrice !== null && previousPrice !== 0
        ? (movement / previousPrice) * 100
        : null;
    const dailyChange =
      currentPrice !== null && open !== null ? currentPrice - open : null;
    const dailyChangePercent =
      dailyChange !== null && open !== null && open !== 0
        ? (dailyChange / open) * 100
        : null;
    const direction = (
      value: number | null,
    ): 'UP' | 'DOWN' | 'UNCHANGED' | 'UNKNOWN' =>
      value === null
        ? 'UNKNOWN'
        : value > 0
          ? 'UP'
          : value < 0
            ? 'DOWN'
            : 'UNCHANGED';

    return {
      symbol: seed.symbol,
      label: seed.label ?? seed.symbol,
      section: 'gold',
      unit: seed.unit ?? 'RIAL',
      availability: seed.availability ?? 'AVAILABLE',
      freshness: seed.freshness === undefined ? 'FRESH' : seed.freshness,
      currentPrice,
      previousPrice,
      open,
      high: seed.high ?? null,
      low: seed.low ?? null,
      dailyChange,
      dailyChangePercent:
        seed.dailyChangePercent === undefined
          ? dailyChangePercent
          : seed.dailyChangePercent,
      dailyDirection: direction(dailyChange),
      movement,
      movementPercent:
        seed.movementPercent === undefined
          ? movementPercent
          : seed.movementPercent,
      movementDirection: direction(movement),
      lastUpdatedAt: seed.lastUpdatedAt ?? '2026-09-30T08:00:00.000Z',
      ageMs: 0,
    };
  });

  const increasing = symbols.filter(
    (symbol) => symbol.dailyDirection === 'UP',
  ).length;
  const decreasing = symbols.filter(
    (symbol) => symbol.dailyDirection === 'DOWN',
  ).length;
  const unchanged = symbols.filter(
    (symbol) => symbol.dailyDirection === 'UNCHANGED',
  ).length;
  const unknown = symbols.length - increasing - decreasing - unchanged;

  return {
    generatedAt: (
      options.now ?? new Date('2026-09-30T08:00:00.000Z')
    ).toISOString(),
    freshness: options.freshness ?? 'FRESH',
    symbols,
    summary: {
      increasing,
      decreasing,
      unchanged,
      unknown,
      available: symbols.filter((symbol) => symbol.availability === 'AVAILABLE')
        .length,
      stale: symbols.filter((symbol) => symbol.availability === 'STALE').length,
      unavailable: symbols.filter(
        (symbol) => symbol.availability === 'UNAVAILABLE',
      ).length,
    },
    hasData: currentPricesOf(symbols) > 0,
    hasStale: symbols.some((symbol) => symbol.availability === 'STALE'),
    lastUpdate: options.lastUpdate ?? '2026-09-30T08:00:00.000Z',
  };
}

function currentPricesOf(symbols: readonly MarketSymbolSnapshot[]): number {
  return symbols.filter((symbol) => symbol.currentPrice !== null).length;
}

/** A `MarketIntelligenceService` stand-in that returns one fixed snapshot. */
export function createIntelligenceStub(
  snapshot: MarketIntelligenceSnapshot | (() => MarketIntelligenceSnapshot),
): MarketIntelligenceService {
  const build = typeof snapshot === 'function' ? snapshot : () => snapshot;

  return { build } as unknown as MarketIntelligenceService;
}

export interface ChannelHarness {
  config: AppConfigService;
  market: MarketHarness;
  platform: PlatformHarness;
  store: PublicationStore;
  publisher: ChannelPublisher;
  policy: ChannelPolicyService;
  /** Phase 6 — CTA policy used by the engine (exposed for policy-level assertions). */
  ctaPolicy: CtaPolicyService;
  /** Phase 6 — destination builder (deep links / channel links), config-driven. */
  destinations: BotDestinationService;
  engine: ChannelEngineService;
  content: ContentService;
  contentAdmin: ContentAdminService;
  /** Publication calls the publisher made, in order (per destination, §14). */
  publishes: () => PlatformCall[];
  /** Rendered platform calls (screens sent by the admin surface). */
  messages: () => PlatformCall[];
  load: () => Promise<void>;
}

/**
 * Complete Phase 5 stack on top of the Phase 1/4 doubles: real store, policy, publisher, engine and
 * content service — only the transport and the clock are controlled by the test.
 *
 * Nothing here talks to a network: `publishText`/`publishPhoto` are doubles, and the market state is
 * seeded through the Phase 1 harness, so no test can ever send a real channel message (§27).
 */
export function createChannelHarness(
  env: EnvMap = {},
  options: {
    market?: MarketHarness;
    platform?: PlatformHarness;
    config?: AppConfigService;
    store?: PublicationStore;
    /** Replace the Phase 4 projection (pure snapshot tests, no Phase 1 seeding needed). */
    intelligence?: MarketIntelligenceService;
  } = {},
): ChannelHarness {
  const config = options.config ?? createAppConfigService(env);
  const market =
    options.market ??
    createMarketHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const platform =
    options.platform ??
    createPlatformHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const store = options.store ?? new PublicationStore(config);
  const intelligence =
    options.intelligence ??
    new MarketIntelligenceService(config, market.marketState);
  const destinations = new BotDestinationService(config);
  const publisher = new ChannelPublisher(
    config,
    platform.client as unknown as BotApiClient,
    destinations,
  );
  const policy = new ChannelPolicyService(config, store);
  const ctaPolicy = new CtaPolicyService(config);
  const engine = new ChannelEngineService(
    config,
    store,
    publisher,
    policy,
    ctaPolicy,
    intelligence,
    new PriceMessageBuilder(config),
    new PosterService(config),
  );
  const content = new ContentService(config, store);
  const contentAdmin = new ContentAdminService(
    config,
    content,
    engine,
    ctaPolicy,
  );

  return {
    config,
    market,
    platform,
    store,
    publisher,
    policy,
    ctaPolicy,
    destinations,
    engine,
    content,
    contentAdmin,
    publishes: () => platform.calls.filter((call) => call.kind === 'publish'),
    messages: () => platform.calls.filter((call) => call.kind === 'send'),
    load: () => store.ensureLoaded(),
  };
}

/**
 * Phase 9 stack (lead store → lead lifecycle → notification outbox → customer/operator surfaces).
 *
 * It is built on the *same* campaign stack, the same user store and the same platform registry the
 * application uses, so a test observes real attribution and real (doubled) transport instead of a
 * parallel wiring. `views` is the Phase 2 read-only market projection the purchase flow shows as a
 * reference price. The user store is only read through the notification outbox, which resolves the
 * chat a stored lead came from; it is never used to invent an identity.
 */
export function createSalesHarness(
  env: EnvMap = {},
  options: {
    config?: AppConfigService;
    userStore?: UserStore;
    platform?: PlatformHarness;
    campaigns?: CampaignHarness;
    views?: MarketViewService;
  } = {},
): SalesHarness {
  const config = options.config ?? createAppConfigService(env);
  const platform =
    options.platform ??
    createPlatformHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const campaigns =
    options.campaigns ?? createCampaignHarness(env, { config, platform });
  const userStore = options.userStore ?? new UserStore(config);
  const views = options.views;

  if (!views) {
    throw new Error(
      'createSalesHarness needs the UX view stack (views/users) to render the purchase flow.',
    );
  }

  const store = new SalesStore(config);
  const service = new SalesService(
    config,
    store,
    campaigns.tracking,
    campaigns.service,
    campaigns.conversions,
  );
  const notifications = new SalesNotificationService(
    config,
    store,
    service,
    platform.registry,
    userStore,
  );

  return {
    config,
    store,
    service,
    notifications,
    ux: new SalesUxService(config, service, notifications, views),
    admin: new SalesAdminService(config, service, notifications),
    load: () => store.ensureLoaded(),
  };
}

export interface SalesHarness {
  config: AppConfigService;
  store: SalesStore;
  service: SalesService;
  notifications: SalesNotificationService;
  /** Phase 9 — the customer purchase flow (form + screens). */
  ux: SalesUxService;
  /** Phase 9 — the operator surface (commands + buttons). */
  admin: SalesAdminService;
  load: () => Promise<void>;
}

export interface CampaignHarness {
  config: AppConfigService;
  /** Platform harness the tracking service talks to (membership queries included). */
  platform: PlatformHarness;
  store: CampaignStore;
  destinations: BotDestinationService;
  service: CampaignService;
  tracking: CampaignTrackingService;
  conversions: CampaignConversionService;
  metrics: CampaignMetricsService;
  admin: CampaignAdminService;
  load: () => Promise<void>;
}

/**
 * Phase 8 stack (store → management → tracking → conversions → metrics → dashboard surface).
 *
 * The store is in-memory by default (`CAMPAIGN_DATA_FILE` empty) exactly like every other harness, and
 * the existing user store / platform client are reused rather than rebuilt, so a test observes the
 * same wiring the application uses.
 */
export function createCampaignHarness(
  env: EnvMap = {},
  options: {
    config?: AppConfigService;
    userStore?: UserStore;
    platform?: PlatformHarness;
    destinations?: BotDestinationService;
  } = {},
): CampaignHarness {
  const config = options.config ?? createAppConfigService(env);
  const platform =
    options.platform ??
    createPlatformHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const destinations =
    options.destinations ?? new BotDestinationService(config);
  const store = new CampaignStore(config);
  const service = new CampaignService(config, store, destinations);
  const tracking = new CampaignTrackingService(
    config,
    store,
    service,
    platform.client as unknown as BotApiClient,
  );
  const conversions = new CampaignConversionService(
    store,
    service,
    tracking,
    options.userStore ?? new UserStore(config),
  );
  const metrics = new CampaignMetricsService(config, store);
  const admin = new CampaignAdminService(config, service, conversions, metrics);

  return {
    config,
    platform,
    store,
    destinations,
    service,
    tracking,
    conversions,
    metrics,
    admin,
    load: () => store.ensureLoaded(),
  };
}

export interface AdminHarness {
  config: AppConfigService;
  platform: PlatformHarness;
  store: AdminStore;
  access: AdminAccessService;
  audit: AdminAuditService;
  activity: AdminActivityService;
  errors: AdminErrorService;
  metrics: AdminMetricsService;
  broadcast: AdminBroadcastService;
  service: AdminService;
  load: () => Promise<void>;
}

/**
 * Phase 10 stack (admin document → authorization/audit/errors/metrics → broadcast worker → surface).
 *
 * Every dependency is the *real* service built the same way the application builds it: in-memory by
 * default (`ADMIN_DATA_FILE=''`), broadcast off unless the test turns it on, and delivery through the
 * same publisher/platform-client double the other phases use. A test therefore exercises the real
 * authorization, the real stores and the real worker — never a bespoke stub.
 */
export function createAdminHarness(
  env: EnvMap = {},
  options: {
    config?: AppConfigService;
    platform?: PlatformHarness;
    market?: MarketHarness;
    userStore?: UserStore;
    alertStore?: AlertStore;
    publicationStore?: PublicationStore;
    campaignStore?: CampaignStore;
    salesStore?: SalesStore;
  } = {},
): AdminHarness {
  const config = options.config ?? createAppConfigService(env);
  const market =
    options.market ??
    createMarketHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const platform =
    options.platform ??
    createPlatformHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  const userStore = options.userStore ?? new UserStore(config);
  const alertStore = options.alertStore ?? new AlertStore(config);
  const publicationStore =
    options.publicationStore ?? new PublicationStore(config);
  const campaignStore = options.campaignStore ?? new CampaignStore(config);
  const salesStore = options.salesStore ?? new SalesStore(config);

  // Phase 3 stack (alert service + notifications) — the *only* owner of alert state.
  const capacity = new AlertCapacityService(config, userStore);
  const alerts = new AlertService(
    config,
    alertStore,
    market.marketState,
    userStore,
    capacity,
  );
  const alertNotifications = new AlertNotificationService(
    config,
    alerts,
    alertStore,
    platform.registry,
    userStore,
  );

  // Phase 5/6 stack (publisher + engine) — the *only* owner of publications.
  const destinations = new BotDestinationService(config);
  const publisher = new ChannelPublisher(
    config,
    platform.client as unknown as BotApiClient,
    destinations,
  );
  const engine = new ChannelEngineService(
    config,
    publicationStore,
    publisher,
    new ChannelPolicyService(config, publicationStore),
    new CtaPolicyService(config),
    new MarketIntelligenceService(config, market.marketState),
    new PriceMessageBuilder(config),
    new PosterService(config),
  );

  // Phase 8/9 stacks (campaign reporting + the sales engine the admin screens read and act through).
  const campaignService = new CampaignService(
    config,
    campaignStore,
    destinations,
  );
  const campaignTracking = new CampaignTrackingService(
    config,
    campaignStore,
    campaignService,
    platform.client as unknown as BotApiClient,
  );
  const campaignMetrics = new CampaignMetricsService(config, campaignStore);
  const campaignConversions = new CampaignConversionService(
    campaignStore,
    campaignService,
    campaignTracking,
    userStore,
  );
  const salesService = new SalesService(
    config,
    salesStore,
    campaignTracking,
    campaignService,
    campaignConversions,
  );
  const salesNotifications = new SalesNotificationService(
    config,
    salesStore,
    salesService,
    platform.registry,
    userStore,
  );

  // Phase 10 itself.
  const store = new AdminStore(config);
  const access = new AdminAccessService(config);
  const audit = new AdminAuditService(config, store);
  const activity = new AdminActivityService(config, store);
  const errors = new AdminErrorService(config, store);
  const metrics = new AdminMetricsService(
    config,
    userStore,
    activity,
    alertStore,
    alertNotifications,
    publicationStore,
    campaignStore,
    campaignTracking,
    salesService,
    salesNotifications,
    market.marketState,
    errors,
  );
  const broadcast = new AdminBroadcastService(
    config,
    store,
    userStore,
    platform.registry,
    activity,
    audit,
    errors,
  );
  const service = new AdminService(
    config,
    platform.registry,
    access,
    activity,
    audit,
    errors,
    metrics,
    broadcast,
    userStore,
    alertStore,
    alerts,
    alertNotifications,
    publicationStore,
    publisher,
    engine,
    salesService,
    salesNotifications,
    campaignStore,
    campaignMetrics,
    campaignTracking,
  );

  return {
    config,
    platform,
    store,
    access,
    audit,
    activity,
    errors,
    metrics,
    broadcast,
    service,
    load: async () => {
      await store.ensureLoaded();
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
  channel: ChannelHarness;
  botUx: BotUxService;
  /** Phase 7 — growth engine (referral codes, attribution, rewards, statistics). */
  growth: ReferralService;
  /** Phase 7 — effective alert capacity derived from the reward ledger. */
  capacity: AlertCapacityService;
  /** Phase 8 — campaign tracking & attribution stack. */
  campaigns: CampaignHarness;
  /** Phase 9 — sales engine (lead store, lead lifecycle and the two bot surfaces). */
  sales: SalesHarness;
  /** Phase 10 — admin system (document store, authorization, audit, errors, metrics, broadcast). */
  admin: AdminHarness;
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
  options: {
    store?: UserStore;
    alertStore?: AlertStore;
    campaignStore?: CampaignStore;
  } = {},
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
  // Phase 5: the content surface is part of the same bot (in-memory by default).
  const channel = createChannelHarness(
    { ...env, BOT_POLLING_ENABLED: 'false' },
    { market, platform, config },
  );
  const alertStore = options.alertStore ?? new AlertStore(config);
  const capacity = new AlertCapacityService(config, store);
  const growth = new ReferralService(config, store, capacity);
  const alerts = new AlertService(
    config,
    alertStore,
    market.marketState,
    store,
    capacity,
  );
  const notifications = new AlertNotificationService(
    config,
    alerts,
    alertStore,
    platform.registry,
    store,
  );
  // Phase 8: the campaign stack shares this harness' destination service, so every public link is
  // built by the same code the application uses.
  const campaigns = createCampaignHarness(
    { ...env, BOT_POLLING_ENABLED: 'false' },
    {
      config,
      userStore: store,
      platform,
      destinations: channel.destinations,
    },
  );
  // Phase 9: the sales engine reuses the same campaign tracking stack (the only source of campaign
  // attribution) and the same platform registry for delivery.
  const salesStack = createSalesHarness(
    { ...env, BOT_POLLING_ENABLED: 'false' },
    {
      config,
      userStore: store,
      platform,
      campaigns,
      views,
    },
  );

  // Phase 10: the admin system is wired before the UX service, which dispatches admin commands and
  // callbacks through it (and keeps the admin row hidden from non-admins).
  const adminStack = createAdminHarness(
    { ...env, BOT_POLLING_ENABLED: 'false' },
    {
      config,
      platform,
      market,
      userStore: store,
      alertStore,
      publicationStore: channel.store,
      campaignStore: campaigns.store,
      salesStore: salesStack.store,
    },
  );

  const botUx = new BotUxService(
    config,
    platform.registry,
    views,
    users,
    events,
    alerts,
    channel.contentAdmin,
    channel.destinations,
    growth,
    campaigns.tracking,
    campaigns.admin,
    salesStack.ux,
    salesStack.admin,
    adminStack.service,
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
    channel,
    botUx,
    growth,
    capacity,
    campaigns,
    sales: salesStack,
    admin: adminStack,
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

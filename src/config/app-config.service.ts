import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isMoneyUnit, MoneyUnit } from '../common/money';
import { buildSymbolRegistry, SymbolDefinition } from '../market/symbols';
import { parseSymbolUnits, parseThresholdOverrides } from './env.validation';

export interface PlatformCredentials {
  botToken: string;
  channelId: string;
}

export interface PriceApiConfig {
  url: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  /** Unit in which the price API expresses its values. */
  sourceUnit: MoneyUnit;
  /** Optional per-symbol unit overrides (`PRICE_SYMBOL_UNITS`). */
  symbolUnits: Record<string, MoneyUnit>;
}

/**
 * Typed, validated view over the environment.
 *
 * All values are already validated at startup (`validateEnvironment`); the guards here are
 * defensive so a misuse of the config never results in `NaN` silently flowing into a message.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get port(): number {
    return this.readInteger('PORT', 3000);
  }

  get displayUnit(): MoneyUnit {
    return this.readMoneyUnit('PRICE_DISPLAY_UNIT', 'RIAL');
  }

  get deliveryTimeoutMs(): number {
    return this.readInteger('DELIVERY_TIMEOUT_MS', 20_000);
  }

  // --- Phase 1: market reliability ------------------------------------------

  /** Symbol registry with the configured threshold overrides applied. */
  get symbolRegistry(): readonly SymbolDefinition[] {
    return buildSymbolRegistry({
      defaultMaxChangePercent: this.readNumber('PRICE_MAX_CHANGE_PERCENT', 8),
      maxChangePercentBySymbol: parseThresholdOverrides(
        this.configService.get<string>('PRICE_THRESHOLD_OVERRIDES'),
      ),
    });
  }

  /** Extra tolerance applied when the comparison baseline is from a previous Tehran day. */
  get crossDayChangeMultiplier(): number {
    return this.readNumber('PRICE_CROSS_DAY_CHANGE_MULTIPLIER', 2);
  }

  /** Age after which a symbol's state is reported as STALE. */
  get staleAfterMs(): number {
    return this.readInteger('PRICE_STALE_AFTER_MINUTES', 45) * 60_000;
  }

  /** Optional admin chat for operational anomaly alerts (`null` = log only). */
  get anomalyAlertChatId(): string | null {
    const value = this.configService.get<string>('ANOMALY_ALERT_CHAT_ID');

    return value === undefined || value === null || String(value).trim() === ''
      ? null
      : String(value).trim();
  }

  /** De-duplication window for identical anomaly alerts. */
  get anomalyAlertCooldownMinutes(): number {
    return this.readInteger('ANOMALY_ALERT_COOLDOWN_MINUTES', 30);
  }

  /** Market state file path (`null` disables persistence). */
  get marketStateFile(): string | null {
    const value = this.configService.get<string>('MARKET_STATE_FILE');

    if (value === undefined || value === null) {
      return null;
    }

    const trimmed = String(value).trim();

    return trimmed === '' ? null : trimmed;
  }

  // --- Phase 2: bot UX -------------------------------------------------------

  /** Where users and their favorites are persisted (`null` disables persistence). */
  get userDataFile(): string | null {
    return this.optionalPath('USER_DATA_FILE');
  }

  /** Maximum favorites per user — the only place this limit is defined (§31, §62). */
  get maxFavorites(): number {
    return this.readInteger('MAX_FAVORITES', 10);
  }

  /** Official channel handle, used for display. */
  get channelHandle(): string {
    return this.readString('CHANNEL_HANDLE', '@tala_atabak');
  }

  /** Official channel URL used by the CTA button (single declaration, §35). */
  get channelUrl(): string {
    return this.readString('CHANNEL_URL', 'https://ble.ir/tala_atabak');
  }

  // --- Phase 3: price alerts -------------------------------------------------

  /** Where alerts and delivery records are persisted (`null` disables persistence). */
  get alertsDataFile(): string | null {
    return this.optionalPath('ALERTS_DATA_FILE');
  }

  /** Maximum live alerts per user (the only place this limit is defined, §35). */
  get maxAlertsPerUser(): number {
    return this.readInteger('MAX_ALERTS_PER_USER', 5);
  }

  /** Extra attempts after the first delivery failure (total attempts = 1 + retries). */
  get alertNotificationMaxRetries(): number {
    // `0` is a meaningful value here ("no retry"), so it must not fall back to the default.
    return this.readNonNegativeInteger('ALERT_NOTIFICATION_MAX_RETRIES', 3);
  }

  /** Delay between two notification attempts, in milliseconds (`0` = immediate). */
  get alertNotificationRetryDelayMs(): number {
    return this.readNonNegativeInteger(
      'ALERT_NOTIFICATION_RETRY_DELAY_MS',
      5_000,
    );
  }

  /** Lower bound of a percentage alert magnitude (documented safety bound, §90). */
  get alertMinTargetPercent(): number {
    return this.readNumber('ALERT_MIN_TARGET_PERCENT', 0.01);
  }

  /** Upper bound of a percentage alert magnitude (documented safety bound, §90). */
  get alertMaxTargetPercent(): number {
    return this.readNumber('ALERT_MAX_TARGET_PERCENT', 100);
  }

  /** In-memory alert wizard lifetime; an abandoned wizard is dropped after this. */
  get alertWizardTtlMs(): number {
    return this.readInteger('ALERT_WIZARD_TTL_MINUTES', 15) * 60_000;
  }

  /** Inbound interaction switch: `false` keeps the pre-Phase-2 publish-only behaviour. */
  get botPollingEnabled(): boolean {
    return (
      this.readString('BOT_POLLING_ENABLED', 'true').toLowerCase() === 'true'
    );
  }

  /** Long-poll wait handed to the platform on every `getUpdates` call. */
  get botPollTimeoutSeconds(): number {
    const value = Number(
      this.configService.get<string>('BOT_POLL_TIMEOUT_SECONDS'),
    );

    return Number.isInteger(value) && value >= 0 && value <= 120 ? value : 25;
  }

  /** Delay between polling attempts after a transport failure. */
  get botPollRetryDelayMs(): number {
    return this.readInteger('BOT_POLL_RETRY_DELAY_MS', 3000);
  }

  /**
   * Bot tokens available for inbound and outbound calls. Bale is required (validated at
   * startup); Telegram is optional and reuses the same token as the channel mirroring.
   */
  get botTokens(): { platform: 'bale' | 'telegram'; botToken: string }[] {
    const tokens: { platform: 'bale' | 'telegram'; botToken: string }[] = [
      { platform: 'bale', botToken: this.requireString('BALE_BOT_TOKEN') },
    ];

    const telegram = this.telegram;
    if (telegram) {
      tokens.push({ platform: 'telegram', botToken: telegram.botToken });
    }

    return tokens;
  }

  /** Bale is a required platform: missing credentials fail fast here too. */
  get bale(): PlatformCredentials {
    return {
      botToken: this.requireString('BALE_BOT_TOKEN'),
      channelId: this.requireString('BALE_CHANNEL_ID'),
    };
  }

  /** Telegram is optional and only enabled when both values are present. */
  get telegram(): PlatformCredentials | null {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const channelId = this.configService.get<string>('TELEGRAM_CHANNEL_ID');

    if (!botToken || !channelId) {
      return null;
    }

    return { botToken, channelId };
  }

  get priceApi(): PriceApiConfig {
    return {
      url: this.requireString('PRICE_API_URL'),
      timeoutMs: this.readInteger('PRICE_API_TIMEOUT_MS', 20_000),
      maxAttempts: this.readInteger('PRICE_API_MAX_ATTEMPTS', 3),
      retryDelayMs: this.readInteger('PRICE_API_RETRY_DELAY_MS', 1500),
      sourceUnit: this.readMoneyUnit('PRICE_API_UNIT', 'RIAL'),
      symbolUnits: parseSymbolUnits(
        this.configService.get<string>('PRICE_SYMBOL_UNITS'),
      ),
    };
  }

  private requireString(key: string): string {
    const value = this.configService.get<string>(key);

    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`Missing required configuration value: ${key}`);
    }

    return String(value).trim();
  }

  /** Optional filesystem path: a blank value disables the feature (returns `null`). */
  private optionalPath(key: string): string | null {
    const value = this.configService.get<string>(key);

    if (value === undefined || value === null) {
      return null;
    }

    const trimmed = String(value).trim();

    return trimmed === '' ? null : trimmed;
  }

  private readString(key: string, fallback: string): string {
    const value = this.configService.get<string>(key);

    return value === undefined || value === null || String(value).trim() === ''
      ? fallback
      : String(value).trim();
  }

  private readInteger(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const value = Number(raw);

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  /**
   * Like {@link readInteger}, but `0` is a valid configured value (used where "off"/"immediately"
   * is a documented option, e.g. notification retries).
   */
  private readNonNegativeInteger(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const value = Number(raw);

    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private readNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const value = Number(raw);

    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private readMoneyUnit(key: string, fallback: MoneyUnit): MoneyUnit {
    const raw = this.configService.get<string>(key)?.toUpperCase();

    return isMoneyUnit(raw) ? raw : fallback;
  }
}

import { AppConfigService } from './app-config.service';
import { createAppConfigService } from '../testing/test-doubles';

describe('AppConfigService', () => {
  it('exposes typed scalar values', () => {
    const config = createAppConfigService({
      PORT: '4321',
      DELIVERY_TIMEOUT_MS: '5000',
    });

    expect(config.port).toBe(4321);
    expect(config.deliveryTimeoutMs).toBe(5000);
    expect(config.displayUnit).toBe('RIAL');
  });

  it('exposes the price API configuration as numbers, not strings', () => {
    const config = createAppConfigService({
      PRICE_API_TIMEOUT_MS: '9000',
      PRICE_API_MAX_ATTEMPTS: '5',
      PRICE_API_RETRY_DELAY_MS: '250',
      PRICE_API_UNIT: 'TOMAN',
      PRICE_SYMBOL_UNITS: 'USDT_IRT=TOMAN',
    });

    expect(config.priceApi).toEqual({
      url: 'https://api.example.test/prices',
      timeoutMs: 9000,
      maxAttempts: 5,
      retryDelayMs: 250,
      sourceUnit: 'TOMAN',
      symbolUnits: { USDT_IRT: 'TOMAN' },
    });
  });

  it('returns the Bale credentials', () => {
    expect(createAppConfigService().bale).toEqual({
      botToken: 'bale-token',
      channelId: 'bale-channel',
    });
  });

  it('disables Telegram unless both values are present', () => {
    expect(createAppConfigService().telegram).toBeNull();
    expect(
      createAppConfigService({ TELEGRAM_BOT_TOKEN: 'tg-token' }).telegram,
    ).toBeNull();
    expect(
      createAppConfigService({
        TELEGRAM_BOT_TOKEN: 'tg-token',
        TELEGRAM_CHANNEL_ID: 'tg-channel',
      }).telegram,
    ).toEqual({ botToken: 'tg-token', channelId: 'tg-channel' });
  });

  it('fails loudly when a required value is missing at read time', () => {
    const config = new AppConfigService({
      get: () => undefined,
    } as unknown as ConstructorParameters<typeof AppConfigService>[0]);

    expect(() => config.bale).toThrow(
      'Missing required configuration value: BALE_BOT_TOKEN',
    );
  });
  describe('Phase 1 market reliability settings', () => {
    it('exposes numeric reliability settings with documented defaults', () => {
      const config = createAppConfigService();

      expect(config.crossDayChangeMultiplier).toBe(2);
      expect(config.staleAfterMs).toBe(45 * 60_000);
      expect(config.anomalyAlertCooldownMinutes).toBe(30);
      expect(config.anomalyAlertChatId).toBeNull();
      expect(config.symbolRegistry).toHaveLength(16);
    });

    it('reads the overrides from the environment', () => {
      const config = createAppConfigService({
        PRICE_STALE_AFTER_MINUTES: '10',
        PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '3',
        ANOMALY_ALERT_CHAT_ID: 'admin-chat',
        ANOMALY_ALERT_COOLDOWN_MINUTES: '5',
        MARKET_STATE_FILE: './tmp/state.json',
      });

      expect(config.staleAfterMs).toBe(10 * 60_000);
      expect(config.crossDayChangeMultiplier).toBe(3);
      expect(config.anomalyAlertChatId).toBe('admin-chat');
      expect(config.anomalyAlertCooldownMinutes).toBe(5);
      expect(config.marketStateFile).toBe('./tmp/state.json');
    });

    it('disables persistence when MARKET_STATE_FILE is empty', () => {
      expect(
        createAppConfigService({ MARKET_STATE_FILE: '' }).marketStateFile,
      ).toBeNull();
    });

    it('falls back to safe defaults for invalid numeric values', () => {
      const config = createAppConfigService({
        PRICE_STALE_AFTER_MINUTES: 'abc',
        PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '0',
      });

      expect(config.staleAfterMs).toBe(45 * 60_000);
      expect(config.crossDayChangeMultiplier).toBe(2);
    });
  });
});

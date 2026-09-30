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
});

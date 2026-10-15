import { Logger } from '@nestjs/common';

import { PriceApiError } from '../price/price.error';
import { PriceService } from '../price/price.service';
import {
  createChannelHarness,
  createMarketHarness,
  createPlatformHarness,
} from '../testing/test-doubles';
import { BotService } from './bot.service';

/**
 * Phase 5 (§27.2 / §27.8): the scheduling service is now a *thin* caller of the Channel Engine.
 *
 * These tests therefore assert the externally observable behaviour — what reaches a destination —
 * instead of mocking a publisher: a rejected cycle publishes nothing, a failed fetch publishes
 * nothing, a partial delivery is reported as partial, and the same market window is never published
 * twice (which is now guaranteed by the engine's persisted job identity, not by a boolean).
 *
 * No network is involved: the platform client is a double and prices come from the Phase 1 harness.
 */

const payload = () => ({
  gold: [
    { symbol: 'XAUUSD', price: 2650.75 },
    { symbol: 'IR_GOLD_18K', price: 17_000_000 },
  ],
  currency: [{ symbol: 'USD', price: 1_032_000 }],
});

const createHarness = (env: Record<string, string> = {}) => {
  const fetchRawPayload = jest.fn<
    Promise<{ payload: unknown; receivedAt: string; source: string }>,
    []
  >();
  const priceService = { fetchRawPayload } as unknown as PriceService;

  const market = createMarketHarness(env);
  const platform = createPlatformHarness({
    ...env,
    BOT_POLLING_ENABLED: 'false',
  });
  const channel = createChannelHarness(env, { market, platform });

  const service = new BotService(priceService, market.engine, channel.engine);

  return { service, fetchRawPayload, market, platform, channel };
};

const fetchResult = (
  body: unknown,
  receivedAt = '2026-09-30T08:00:00.000Z',
) => ({
  payload: body,
  receivedAt,
  source: 'https://api.example.test/prices',
});

describe('BotService (Phase 5: delegates every publication to the Channel Engine)', () => {
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes only after the reliability pipeline approved the prices', async () => {
    const { service, fetchRawPayload, channel } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    await service.handleHalfHourlyPriceUpdate();

    const publishes = channel.publishes();
    expect(publishes).toHaveLength(1);
    expect(publishes[0].text).toContain('گزارش لحظه‌ای بازار');
    expect(publishes[0].text).toContain('@tala_atabak');
    expect(publishes[0].platform).toBe('bale');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('approved for publication'),
    );
  });

  it('does not publish when every price is rejected (no fake success)', async () => {
    const { service, fetchRawPayload, channel } = createHarness();
    fetchRawPayload.mockResolvedValue(
      fetchResult({ currency: [{ symbol: 'AED', price: 'abc' }] }),
    );

    await service.handlePosterReport();

    expect(channel.publishes()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no publishable prices'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('✅'));
  });

  it('does not publish anything when the payload is structurally invalid', async () => {
    const { service, fetchRawPayload, channel } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult({ unexpected: true }));

    await service.handleHalfHourlyPriceUpdate();

    expect(channel.publishes()).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no publishable prices'),
    );
  });

  it('logs a failed price API fetch without publishing (last valid state preserved)', async () => {
    const { service, fetchRawPayload, channel, market } = createHarness();

    fetchRawPayload.mockResolvedValueOnce(fetchResult(payload()));
    await service.handleHalfHourlyPriceUpdate();

    const gold = market.config.symbolRegistry.find(
      (definition) => definition.symbol === 'IR_GOLD_18K',
    )!;
    const before = market.marketState.getState(gold)?.lastValidPrice;

    fetchRawPayload.mockRejectedValueOnce(
      new PriceApiError('timeout of 20000ms exceeded'),
    );
    await service.handleHalfHourlyPriceUpdate();

    expect(channel.publishes()).toHaveLength(1); // only the first cycle
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Price update (half-hourly) failed'),
    );
    expect(market.marketState.getState(gold)?.lastValidPrice).toBe(before);
  });

  it('reports a partial delivery per destination instead of pretending everything worked', async () => {
    const { service, fetchRawPayload, platform, channel } = createHarness({
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHANNEL_ID: 'telegram-channel',
    });
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    // Bale is down for the whole retry budget; Telegram is healthy.
    platform.failPublish('RETRYABLE', 10, 'bale');

    await service.handleHalfHourlyPriceUpdate();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FAILED on bale'),
    );
    const deliveries = channel.engine.history(5)[0];
    expect(deliveries.status).toBe('PUBLISHED');
    const perDestination = channel.engine.deliveriesOf(deliveries.id);
    expect(
      perDestination.find((delivery) => delivery.platform === 'telegram')
        ?.status,
    ).toBe('SENT');
    expect(
      perDestination.find((delivery) => delivery.platform === 'bale')?.status,
    ).toBe('FAILED');
  });

  it('does not publish the same market window twice', async () => {
    const { service, fetchRawPayload, channel } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    await service.handleHalfHourlyPriceUpdate();
    await service.handleHalfHourlyPriceUpdate();

    expect(channel.publishes()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate publication prevented'),
    );
  });

  it('keeps the poster report on the same validated pipeline', async () => {
    const { service, fetchRawPayload, market, channel } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    await service.handlePosterReport();

    const publishes = channel.publishes();
    expect(publishes[0].text).toContain('💰');
    expect(market.marketState.getTrackedSymbolCount()).toBeGreaterThan(0);
  });
});

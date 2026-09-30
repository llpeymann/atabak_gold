import { Logger } from '@nestjs/common';

import { DeliveryResult } from '../bale/delivery-result';
import { PriceApiError } from '../price/price.error';
import { PriceService } from '../price/price.service';
import { PosterService } from '../poster/poster.service';
import {
  createAppConfigService,
  createBaleServiceDouble,
  createMarketHarness,
} from '../testing/test-doubles';
import { BotService } from './bot.service';
import { PriceMessageBuilder } from './price-message.builder';

const payload = () => ({
  gold: [
    { symbol: 'XAUUSD', price: 2650.75 },
    { symbol: 'IR_GOLD_18K', price: 17_000_000 },
  ],
  currency: [{ symbol: 'USD', price: 1_032_000 }],
});

const deliveryResult = (
  platform: 'bale' | 'telegram',
  success: boolean,
  error?: string,
): DeliveryResult => ({
  platform,
  channel: `${platform}-channel`,
  messageType: 'text',
  timestamp: new Date().toISOString(),
  durationMs: 5,
  success,
  ...(error ? { error } : {}),
});

const createHarness = () => {
  const fetchRawPayload = jest.fn<
    Promise<{ payload: unknown; receivedAt: string; source: string }>,
    []
  >();
  const priceService = { fetchRawPayload } as unknown as PriceService;

  const market = createMarketHarness();
  const bale = createBaleServiceDouble([deliveryResult('bale', true)]);
  const config = createAppConfigService();
  const poster = new PosterService(config);
  const builder = new PriceMessageBuilder(config);

  const service = new BotService(
    priceService,
    market.engine,
    bale.service,
    poster,
    builder,
  );

  return { service, fetchRawPayload, bale, market };
};

const fetchResult = (body: unknown) => ({
  payload: body,
  receivedAt: '2026-09-30T08:00:00.000Z',
  source: 'https://api.example.test/prices',
});

describe('BotService', () => {
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
    const { service, fetchRawPayload, bale } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    await service.handleHalfHourlyPriceUpdate();

    expect(bale.sendMessage).toHaveBeenCalledTimes(1);
    const [text] = bale.sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('گزارش لحظه‌ای بازار');
    expect(text).toContain('@tala_atabak');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('approved for publication'),
    );
  });

  it('does not publish when every price is rejected (no fake success)', async () => {
    const { service, fetchRawPayload, bale } = createHarness();
    // Only optional symbols, all with unusable values.
    fetchRawPayload.mockResolvedValue(
      fetchResult({ currency: [{ symbol: 'AED', price: 'abc' }] }),
    );

    await service.handlePosterReport();

    expect(bale.sendMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no publishable prices'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('✅'));
  });

  it('does not publish anything when the payload is structurally invalid', async () => {
    const { service, fetchRawPayload, bale } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult({ unexpected: true }));

    await service.handleHalfHourlyPriceUpdate();

    expect(bale.sendMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no publishable prices'),
    );
  });

  it('logs a failed price API fetch without publishing (last valid state preserved)', async () => {
    const { service, fetchRawPayload, bale, market } = createHarness();

    fetchRawPayload.mockResolvedValueOnce(fetchResult(payload()));
    await service.handleHalfHourlyPriceUpdate();
    const gold = market.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    )!;
    const before = market.marketState.getState(gold)?.lastValidPrice;

    fetchRawPayload.mockRejectedValueOnce(
      new PriceApiError('timeout of 20000ms exceeded'),
    );
    await service.handleHalfHourlyPriceUpdate();

    expect(bale.sendMessage).toHaveBeenCalledTimes(1); // still only the first cycle
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Price update (half-hourly) failed'),
    );
    expect(market.marketState.getState(gold)?.lastValidPrice).toBe(before);
  });

  it('reports a partial delivery instead of pretending everything worked', async () => {
    const { service, fetchRawPayload, bale } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));
    bale.sendMessage.mockResolvedValue([
      deliveryResult('bale', true),
      deliveryResult('telegram', false, 'HTTP 400'),
    ]);

    await service.handleHalfHourlyPriceUpdate();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivered to bale, FAILED on telegram'),
    );
  });

  it('does not publish twice when a previous publication is still running', async () => {
    const { service, fetchRawPayload, bale } = createHarness();

    let resolveFetch: (value: {
      payload: unknown;
      receivedAt: string;
      source: string;
    }) => void = () => undefined;
    fetchRawPayload.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    bale.sendMessage.mockResolvedValue([deliveryResult('bale', true)]);

    const firstRun = service.handleHalfHourlyPriceUpdate();
    await Promise.resolve();

    const overlappingRun = service.handleDailyClosingPriceUpdate();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no duplicate publication'),
    );

    resolveFetch(fetchResult(payload()));
    await Promise.all([firstRun, overlappingRun]);

    expect(bale.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the poster report on the same validated pipeline', async () => {
    const { service, fetchRawPayload, bale, market } = createHarness();
    fetchRawPayload.mockResolvedValue(fetchResult(payload()));

    await service.handlePosterReport();

    const [text] = bale.sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('💰');
    expect(market.marketState.getTrackedSymbolCount()).toBeGreaterThan(0);
  });
});

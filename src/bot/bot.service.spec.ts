import { Logger } from '@nestjs/common';

import { BaleService } from '../bale/bale.service';
import { DeliveryPlatform, DeliveryResult } from '../bale/delivery-result';
import { PosterService } from '../poster/poster.service';
import { MarketData } from '../price/price.interface';
import { PriceService } from '../price/price.service';
import { PriceApiError } from '../price/price.error';
import { createAppConfigService } from '../testing/test-doubles';
import { BotService } from './bot.service';
import { PriceMessageBuilder } from './price-message.builder';
import { TrendTracker } from './trend-tracker';

const marketData = (): MarketData => ({
  gold: [
    { symbol: 'IR_GOLD_18K', priceInRial: 17_981_900, changePercent: 1.25 },
  ],
  currency: [{ symbol: 'USD', priceInRial: 1_000_000, changePercent: null }],
  fetchedAt: '2026-09-30T09:00:00.000Z',
});

const deliveryResult = (
  platform: DeliveryPlatform,
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
  const getMarketData = jest.fn<Promise<MarketData>, []>();
  const sendMessage = jest.fn<Promise<DeliveryResult[]>, [string]>();

  const priceService = { getMarketData } as unknown as PriceService;
  const baleService = {
    sendMessage,
    platforms: ['bale', 'telegram'] as DeliveryPlatform[],
  } as unknown as BaleService;

  const config = createAppConfigService();
  const trends = new TrendTracker();
  const commitSpy = jest.spyOn(trends, 'commit');
  const builder = new PriceMessageBuilder(config, trends);
  const poster = new PosterService(config);

  const service = new BotService(
    priceService,
    baleService,
    poster,
    builder,
    trends,
  );

  return { service, getMarketData, sendMessage, trends, commitSpy };
};

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes a price message and advances the trend baseline', async () => {
    const { service, getMarketData, sendMessage, commitSpy } = createHarness();
    getMarketData.mockResolvedValue(marketData());
    sendMessage.mockResolvedValue([
      deliveryResult('bale', true),
      deliveryResult('telegram', true),
    ]);

    await service.handleHalfHourlyPriceUpdate();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [text] = sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('گزارش لحظه‌ای بازار');
    expect(text).toContain('@tala_atabak');
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivered to bale, telegram'),
    );
  });

  it('publishes nothing when the price API fails (no fake success)', async () => {
    const { service, getMarketData, sendMessage } = createHarness();
    getMarketData.mockRejectedValue(
      new PriceApiError('Price API responded with HTTP 503'),
    );

    await service.handleHalfHourlyPriceUpdate();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Price update (half-hourly) failed'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('✅'));
  });

  it('does not advance the trend baseline when every delivery failed', async () => {
    const { service, getMarketData, sendMessage, commitSpy } = createHarness();
    getMarketData.mockResolvedValue(marketData());
    sendMessage.mockResolvedValue([
      deliveryResult('bale', false, 'HTTP 500'),
      deliveryResult('telegram', false, 'HTTP 500'),
    ]);

    await service.handleHalfHourlyPriceUpdate();

    expect(commitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivery FAILED on every platform'),
    );
  });

  it('reports a partial delivery instead of pretending everything worked', async () => {
    const { service, getMarketData, sendMessage } = createHarness();
    getMarketData.mockResolvedValue(marketData());
    sendMessage.mockResolvedValue([
      deliveryResult('bale', true),
      deliveryResult('telegram', false, 'HTTP 400'),
    ]);

    await service.handleHalfHourlyPriceUpdate();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivered to bale, FAILED on telegram'),
    );
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('✅'));
  });

  it('publishes the poster report through the same delivery gate', async () => {
    const { service, getMarketData, sendMessage } = createHarness();
    getMarketData.mockResolvedValue(marketData());
    sendMessage.mockResolvedValue([deliveryResult('bale', true)]);

    await service.handlePosterReport();

    const [text] = sendMessage.mock.calls[0] ?? [];
    expect(text).toContain('💰');
    expect(text).toContain('@tala_atabak');
  });

  it('does not publish twice when a previous publication is still running', async () => {
    const { service, getMarketData, sendMessage } = createHarness();

    let resolveFetch: (data: MarketData) => void = () => undefined;
    getMarketData.mockReturnValue(
      new Promise<MarketData>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    sendMessage.mockResolvedValue([deliveryResult('bale', true)]);

    const firstRun = service.handleHalfHourlyPriceUpdate();
    await Promise.resolve(); // let the first run reach the in-flight state

    const overlappingRun = service.handleDailyClosingPriceUpdate();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no duplicate publication'),
    );

    resolveFetch(marketData());
    await Promise.all([firstRun, overlappingRun]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('logs the trend baseline reset once per new Tehran day', async () => {
    const { service, getMarketData, sendMessage, trends } = createHarness();
    getMarketData.mockResolvedValue(marketData());
    sendMessage.mockResolvedValue([deliveryResult('bale', true)]);

    // Pretend the baseline still belongs to yesterday.
    trends.resetForNewDay('2026-09-29');

    await service.handleHalfHourlyPriceUpdate();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('trend baseline reset'),
    );
  });
});

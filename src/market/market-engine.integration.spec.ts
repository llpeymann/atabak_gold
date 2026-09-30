import { Logger } from '@nestjs/common';

import { createMarketHarness } from '../testing/test-doubles';
import { formatPriceValue } from './price-format';

/**
 * Integration coverage for the whole Phase 1 pipeline:
 *
 *   raw API response → parser → normalizer → numeric validation → sanity/anomaly
 *   → market state → change calculation → daily statistics → publish / reject
 */
const basePayload = (overrides: Record<string, unknown> = {}) => ({
  gold: [
    { symbol: 'XAUUSD', price: 2650.75, change_percent: 0.42 },
    { symbol: 'IR_GOLD_18K', price: 17_000_000, change_percent: 1.15 },
    { symbol: 'IR_GOLD_24K', price: 22_600_000, change_percent: -0.33 },
    { symbol: 'IR_GOLD_MELTED', price: 16_900_000, change_percent: 0 },
  ],
  currency: [
    { symbol: 'USDT_IRT', price: 1_035_000, change_percent: 0.6 },
    { symbol: 'USD', price: 1_032_000, change_percent: 0.55 },
    { symbol: 'EUR', price: 1_125_000, change_percent: 0.3 },
  ],
  ...overrides,
});

const at = (iso: string) => new Date(iso);

describe('MarketEngineService (integration)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts, updates state and allows publication for a valid response', async () => {
    const harness = createMarketHarness();

    const { update } = await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );

    expect(update.publishable).toBe(true);
    expect(update.accepted.map((evaluation) => evaluation.symbol)).toEqual([
      'XAUUSD',
      'IR_GOLD_18K',
      'IR_GOLD_24K',
      'IR_GOLD_MELTED',
      'USDT_IRT',
      'USD',
      'EUR',
    ]);
    expect(update.prices).toHaveLength(7);
    expect(update.rejected.map((evaluation) => evaluation.symbol)).toEqual(
      expect.arrayContaining(['IR_COIN_EMAMI', 'GBP', 'TRY', 'AED', 'CNY']),
    );

    // Market state was updated for an accepted symbol…
    const gold = harness.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    );
    expect(gold).toBeDefined();
    expect(harness.marketState.getState(gold!)?.currentPrice).toBe(17_000_000);
  });

  it('calculates change, direction and daily statistics on the second cycle', async () => {
    const harness = createMarketHarness();

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );
    const second = await harness.engine.evaluateCycle(
      basePayload({
        gold: [
          { symbol: 'XAUUSD', price: 2660.5 },
          { symbol: 'IR_GOLD_18K', price: 17_100_000 },
          { symbol: 'IR_GOLD_24K', price: 22_600_000 },
          { symbol: 'IR_GOLD_MELTED', price: 16_900_000 },
        ],
      }),
      at('2026-09-30T08:30:00Z'),
    );

    const goldPrice = second.update.prices.find(
      (price) => price.symbol === 'IR_GOLD_18K',
    );
    expect(goldPrice?.direction).toBe('UP');
    expect(goldPrice?.percentageChange).toBeCloseTo(0.588235, 4);
    expect(goldPrice?.dailyChange).toBe(100_000);

    const unchanged = second.update.prices.find(
      (price) => price.symbol === 'IR_GOLD_24K',
    );
    expect(unchanged?.direction).toBe('UNCHANGED');
  });

  it('rejects an excessive change, alerts the admin, and leaves state untouched', async () => {
    const harness = createMarketHarness({
      ANOMALY_ALERT_CHAT_ID: 'admin-chat',
    });

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );

    const anomaly = await harness.engine.evaluateCycle(
      basePayload({
        gold: [
          { symbol: 'XAUUSD', price: 2650.75 },
          { symbol: 'IR_GOLD_18K', price: 23_000_000 }, // +35% — anomaly
          { symbol: 'IR_GOLD_24K', price: 22_600_000 },
          { symbol: 'IR_GOLD_MELTED', price: 16_900_000 },
        ],
      }),
      at('2026-09-30T08:30:00Z'),
    );

    const rejected = anomaly.update.rejected.find(
      (e) => e.symbol === 'IR_GOLD_18K',
    );
    expect(rejected).toMatchObject({
      accepted: false,
      reason: 'EXCESSIVE_CHANGE',
    });
    expect(rejected?.rejectedValue).toBe(23_000_000);

    // The publisher never receives the anomaly…
    expect(
      anomaly.update.prices.some((price) => price.price === 23_000_000),
    ).toBe(false);

    // …the admin is alerted…
    expect(harness.bale.sendMessageTo).toHaveBeenCalledTimes(1);
    const [chatId, message] = harness.bale.sendMessageTo.mock.calls[0] ?? [];
    expect(chatId).toBe('admin-chat');
    expect(message).toContain('هشدار ناهنجاری');
    expect(message).toContain('EXCESSIVE_CHANGE');

    // …and market state / daily statistics are unchanged.
    const gold = harness.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    )!;
    const state = harness.marketState.getState(gold);
    expect(state?.currentPrice).toBe(17_000_000);
    expect(state?.lastValidPrice).toBe(17_000_000);
    expect(state?.daily?.high).toBe(17_000_000);
  });

  it('recovers automatically after an anomaly', async () => {
    const harness = createMarketHarness();

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );
    await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: 23_000_000 }] }),
      at('2026-09-30T08:30:00Z'),
    );
    const recovery = await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: 17_100_000 }] }),
      at('2026-09-30T09:00:00Z'),
    );

    const gold = harness.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    )!;
    expect(recovery.update.publishable).toBe(true);
    expect(
      recovery.update.prices.find((p) => p.symbol === 'IR_GOLD_18K')?.price,
    ).toBe(17_100_000);
    expect(harness.marketState.getState(gold)?.lastValidPrice).toBe(17_100_000);
  });

  it('reports a missing required symbol and preserves its previous state', async () => {
    const harness = createMarketHarness();

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );
    const partial = await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_24K', price: 22_600_000 }] }),
      at('2026-09-30T08:30:00Z'),
    );

    const missingGold = partial.update.rejected.find(
      (e) => e.symbol === 'IR_GOLD_18K',
    );
    expect(missingGold).toMatchObject({
      accepted: false,
      reason: 'MISSING_SYMBOL',
    });
    expect(missingGold?.previousPrice).toBe(17_000_000);

    // Partial policy: the symbols that are present are still published.
    expect(partial.update.publishable).toBe(true);
    // Partial policy: every symbol present in the payload is still published.
    expect(partial.update.prices.map((price) => price.symbol)).toEqual([
      'IR_GOLD_24K',
      'USDT_IRT',
      'USD',
      'EUR',
    ]);

    const gold = harness.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    )!;
    expect(harness.marketState.getState(gold)?.lastValidPrice).toBe(17_000_000);
  });

  it('rejects the whole response when the schema is invalid and publishes nothing', async () => {
    const harness = createMarketHarness();

    const result = await harness.engine.evaluateCycle(
      { nonsense: true },
      at('2026-09-30T08:00:00Z'),
    );

    expect(result.update.publishable).toBe(false);
    expect(result.update.blockingReason).toBe('INVALID_SCHEMA');
    expect(result.update.prices).toHaveLength(0);
    expect(harness.marketState.getTrackedSymbolCount()).toBe(0);
  });

  it('drops malformed numbers per symbol without harming the rest of the payload', async () => {
    const harness = createMarketHarness();

    const result = await harness.engine.evaluateCycle(
      basePayload({
        gold: [
          { symbol: 'XAUUSD', price: 2650.75 },
          { symbol: 'IR_GOLD_18K', price: 'not-a-number' },
          { symbol: 'IR_GOLD_24K', price: null },
          { symbol: 'IR_GOLD_MELTED', price: -5 },
        ],
      }),
      at('2026-09-30T08:00:00Z'),
    );

    expect(result.update.publishable).toBe(true);
    expect(
      result.update.rejected.map((e) => `${e.symbol}:${e.reason}`),
    ).toEqual(
      expect.arrayContaining([
        'IR_GOLD_18K:INVALID_NUMBER',
        'IR_GOLD_24K:INVALID_NUMBER',
        'IR_GOLD_MELTED:INVALID_PRICE',
      ]),
    );
    expect(
      result.update.prices.some((price) => price.symbol === 'IR_GOLD_18K'),
    ).toBe(false);
  });

  it('normalizes numeric strings before validation', async () => {
    const harness = createMarketHarness();

    const result = await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: '17000000' }] }),
      at('2026-09-30T08:00:00Z'),
    );

    expect(
      result.update.prices.find((price) => price.symbol === 'IR_GOLD_18K')
        ?.price,
    ).toBe(17_000_000);
  });

  it('blocks publication when no required symbol is fresh', async () => {
    const harness = createMarketHarness();

    // Only optional symbols are present → nothing meaningful can be published.
    const result = await harness.engine.evaluateCycle(
      { currency: [{ symbol: 'AED', price: 281_000 }] },
      at('2026-09-30T08:00:00Z'),
    );

    expect(result.update.publishable).toBe(false);
    expect(result.update.blockingReason).toBe('NO_FRESH_REQUIRED_SYMBOL');
    expect(result.update.prices).toHaveLength(0);
  });

  it('starts a fresh daily window on a new Tehran day', async () => {
    const harness = createMarketHarness();

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    ); // 11:30 Tehran
    await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: 17_200_000 }] }),
      at('2026-09-30T18:00:00Z'),
    ); // 21:30 Tehran

    const nextDay = await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: 17_100_000 }] }),
      at('2026-10-01T04:30:00Z'), // 08:00 Tehran on the next day
    );

    const gold = nextDay.update.prices.find(
      (price) => price.symbol === 'IR_GOLD_18K',
    );
    expect(gold?.direction).toBe('UNKNOWN'); // no false comparison with yesterday
    expect(gold?.dailyChange).toBe(0); // today's open is today's first accepted price

    const definition = harness.config.symbolRegistry.find(
      (d) => d.symbol === 'IR_GOLD_18K',
    )!;
    const state = harness.marketState.getState(definition);
    expect(state?.dayKey).toBe('2026-10-01');
    expect(state?.daily?.open).toBe(17_100_000);
    expect(state?.daily?.high).toBe(17_100_000);
    expect(state?.lastValidPrice).toBe(17_100_000);
  });

  it('keeps working (and marks state stale) when a cycle only contains partial data', async () => {
    const harness = createMarketHarness({ PRICE_STALE_AFTER_MINUTES: '1' });

    await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );
    const later = await harness.engine.evaluateCycle(
      basePayload({ gold: [{ symbol: 'IR_GOLD_18K', price: 17_050_000 }] }),
      at('2026-09-30T09:30:00Z'),
    );

    expect(later.update.publishable).toBe(true);
    const usd = later.staleSymbols.find((state) => state.symbol === 'USD');
    expect(usd?.freshness).toBe('STALE');
    expect(usd?.lastValidPrice).toBe(1_032_000);
  });

  it('renders every accepted price with an explicit unit', async () => {
    const harness = createMarketHarness();

    const result = await harness.engine.evaluateCycle(
      basePayload(),
      at('2026-09-30T08:00:00Z'),
    );
    const goldPrice = result.update.prices.find(
      (price) => price.symbol === 'IR_GOLD_18K',
    )!;
    const ounce = result.update.prices.find(
      (price) => price.symbol === 'XAUUSD',
    )!;

    expect(formatPriceValue(goldPrice.price, goldPrice.unit, 'RIAL')).toBe(
      '۱۷٬۰۰۰٬۰۰۰ ریال',
    );
    expect(formatPriceValue(ounce.price, ounce.unit, 'RIAL')).toContain('دلار');
  });
});

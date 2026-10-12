import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tehranDayKey } from '../common/tehran-time';
import { calculatePriceChange } from '../market/price-change.calculator';
import { MarketStateService } from '../market/market-state.service';
import { MarketStateStore } from '../market/market-state.store';
import {
  createAppConfigService,
  createMarketHarness,
  DEFAULT_SEED_PRICES,
  MarketHarness,
  rawPricePayload,
} from '../testing/test-doubles';
import { MarketIntelligenceService } from './market-intelligence.service';
import { MarketSymbolSnapshot } from './market-intelligence.types';

/**
 * Phase 4 unit matrix (§46–§56).
 *
 * Every test drives the *real* Phase 1 pipeline (`evaluateCycle` → accept/reject → commit), so the
 * assertions describe behaviour a production cycle would produce — no hand-written market state.
 */

const GOLD = 'IR_GOLD_18K';

const harnessFor = (env: Record<string, string> = {}): MarketHarness =>
  createMarketHarness(env);

const intelligenceFor = (harness: MarketHarness): MarketIntelligenceService =>
  new MarketIntelligenceService(harness.config, harness.marketState);

/** One accepted cycle at `at` (defaults to now, so the state stays fresh). */
const cycle = async (
  harness: MarketHarness,
  prices: Record<string, number>,
  at = new Date(),
): Promise<void> => {
  await harness.engine.evaluateCycle(
    rawPricePayload(prices, at.toISOString()),
    at,
  );
};

const goldOf = (
  service: MarketIntelligenceService,
  now = new Date(),
): MarketSymbolSnapshot => {
  const snapshot = service.build(now);
  const gold = snapshot.symbols.find((symbol) => symbol.symbol === GOLD);

  if (!gold) {
    throw new Error('gold must always be part of a snapshot');
  }

  return gold;
};

describe('MarketIntelligenceService — daily report (§6–§8, §46, §48, §50)', () => {
  it('opens the daily window on the first accepted price of the day', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_500_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.open).toBe(17_500_000);
    expect(gold.high).toBe(17_500_000);
    expect(gold.low).toBe(17_500_000);
    expect(gold.currentPrice).toBe(17_500_000);
    expect(gold.dailyChange).toBe(0);
    expect(gold.dailyChangePercent).toBe(0);
    expect(gold.dailyDirection).toBe('UNCHANGED');
  });

  it('reports a positive daily change', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_250_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.open).toBe(17_200_000);
    expect(gold.currentPrice).toBe(17_250_000);
    expect(gold.dailyChange).toBe(50_000);
    expect(gold.dailyChangePercent).toBeCloseTo(
      (50_000 / 17_200_000) * 100,
      10,
    );
    expect(gold.dailyDirection).toBe('UP');
  });

  it('reports a negative daily change', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_150_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.dailyChange).toBe(-50_000);
    expect(gold.dailyChangePercent).toBeLessThan(0);
    expect(gold.dailyDirection).toBe('DOWN');
  });

  it('keeps full precision internally and never rounds the percentage', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_250_000 });

    const gold = goldOf(intelligenceFor(harness));
    const expected = ((17_250_000 - 17_200_000) / 17_200_000) * 100;

    expect(gold.dailyChangePercent).toBe(expected);
    expect(String(gold.dailyChangePercent)).not.toBe('0.29'); // 0.2906976… stays unrounded
  });

  it('tracks high and low over the day (§50)', async () => {
    const harness = harnessFor();
    for (const price of [17_200_000, 17_300_000, 17_250_000, 17_150_000]) {
      await cycle(harness, { [GOLD]: price });
    }

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.open).toBe(17_200_000);
    expect(gold.high).toBe(17_300_000);
    expect(gold.low).toBe(17_150_000);
    expect(gold.currentPrice).toBe(17_150_000);
  });

  it('starts the daily window over on the first accepted price of the new Tehran day (§51)', async () => {
    const harness = harnessFor({ PRICE_STALE_AFTER_MINUTES: '1440' });
    const service = intelligenceFor(harness);

    // Day 1: a full daily window (open 17,000,000 / high 17,200,000 / low 17,150,000).
    await cycle(
      harness,
      { [GOLD]: 17_000_000 },
      new Date('2026-09-30T19:00:00Z'),
    );
    await cycle(
      harness,
      { [GOLD]: 17_200_000 },
      new Date('2026-09-30T19:30:00Z'),
    );
    const day1 = goldOf(service, new Date('2026-09-30T19:31:00Z'));
    expect(day1.open).toBe(17_000_000);
    expect(day1.high).toBe(17_200_000);

    // Day 2 (Tehran): the first accepted price becomes open = high = low = current.
    await cycle(
      harness,
      { [GOLD]: 17_050_000 },
      new Date('2026-10-01T05:00:00Z'),
    );

    const day2 = goldOf(service, new Date('2026-10-01T05:01:00Z'));

    expect(day2.open).toBe(17_050_000);
    expect(day2.high).toBe(17_050_000);
    expect(day2.low).toBe(17_050_000);
    expect(day2.currentPrice).toBe(17_050_000);
    expect(day2.dailyChange).toBe(0);
    expect(day2.dailyChangePercent).toBe(0);
    // The previous valid price of the previous day is not a same-day baseline (§23).
    expect(day2.movement).toBeNull();
    expect(day2.movementDirection).toBe('UNKNOWN');
  });

  it('reports the daily change percentage as null instead of dividing by zero', () => {
    // `open = 0` cannot be produced by the Phase 1 pipeline (a zero price never passes the sanity
    // checker), so the guard is exercised directly on the shared calculator.
    expect(calculatePriceChange(100, 0)).toEqual({
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
    });
  });

  it('leaves the daily fields empty while the new day has no accepted price for the symbol', async () => {
    // A long threshold keeps the (still recent) last valid price *fresh*, so the test isolates the
    // daily-window behaviour from staleness.
    const harness = harnessFor({ PRICE_STALE_AFTER_MINUTES: '1440' });
    const service = intelligenceFor(harness);

    // Day 1: gold has a full daily window.
    await cycle(
      harness,
      { [GOLD]: 17_200_000 },
      new Date('2026-09-30T19:00:00Z'),
    );

    // Day 2 rollover: the first cycle of the new Tehran day has no accepted gold price (missing
    // from the payload), so Phase 1 resets the daily window and keeps only the last valid price.
    await cycle(harness, { USD: 1_055_000 }, new Date('2026-10-01T05:00:00Z'));

    const gold = goldOf(service, new Date('2026-10-01T05:01:00Z'));

    expect(gold.availability).toBe('AVAILABLE');
    expect(gold.open).toBeNull();
    expect(gold.high).toBeNull();
    expect(gold.low).toBeNull();
    expect(gold.dailyChange).toBeNull();
    expect(gold.dailyChangePercent).toBeNull();
    expect(gold.dailyDirection).toBe('UNKNOWN');
    expect(gold.currentPrice).toBe(17_200_000); // last valid price is never lost
    expect(gold.movement).toBeNull(); // no same-day baseline either
  });
});

describe('MarketIntelligenceService — market movement (§23–§27, §47)', () => {
  it('reports UP with absolute and percentage movement', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_220_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.previousPrice).toBe(17_200_000);
    expect(gold.movement).toBe(20_000);
    expect(gold.movementPercent).toBeCloseTo((20_000 / 17_200_000) * 100, 10);
    expect(gold.movementDirection).toBe('UP');
  });

  it('reports DOWN', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_180_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.movement).toBe(-20_000);
    expect(gold.movementDirection).toBe('DOWN');
  });

  it('reports UNCHANGED for an identical accepted price', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_200_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.movement).toBe(0);
    expect(gold.movementPercent).toBe(0);
    expect(gold.movementDirection).toBe('UNCHANGED');
  });

  it('reports UNKNOWN without a previous valid price', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.previousPrice).toBeNull();
    expect(gold.movement).toBeNull();
    expect(gold.movementPercent).toBeNull();
    expect(gold.movementDirection).toBe('UNKNOWN');
  });

  it('handles a zero previous price without dividing by zero', () => {
    expect(calculatePriceChange(100, 0)).toMatchObject({
      percentageChange: null,
      direction: 'UNKNOWN',
    });
  });

  it('keeps movement and daily change strictly separate (§23)', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 }); // open
    await cycle(harness, { [GOLD]: 17_260_000 }); // +60,000 vs open
    await cycle(harness, { [GOLD]: 17_250_000 }); // -10,000 vs previous

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.dailyChange).toBe(50_000);
    expect(gold.movement).toBe(-10_000);
    expect(gold.dailyDirection).toBe('UP');
    expect(gold.movementDirection).toBe('DOWN');
  });
});

describe('MarketIntelligenceService — data integrity (§9, §49, §62)', () => {
  it('ignores a rejected (anomalous) price completely', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_200_000 });
    await cycle(harness, { [GOLD]: 17_250_000 });
    const before = goldOf(intelligenceFor(harness));

    // 999,999,999 is far outside the gold acceptance range and an excessive change: Phase 1 rejects it.
    await cycle(harness, { [GOLD]: 999_999_999 });

    const after = goldOf(intelligenceFor(harness));

    expect(after.currentPrice).toBe(before.currentPrice);
    expect(after.open).toBe(before.open);
    expect(after.high).toBe(before.high);
    expect(after.low).toBe(before.low);
    expect(after.previousPrice).toBe(before.previousPrice);
    expect(after.movement).toBe(before.movement);
    expect(after.dailyChange).toBe(before.dailyChange);
    expect(after.lastUpdatedAt).toBe(before.lastUpdatedAt);
  });

  it('never invents data for a symbol Phase 1 has not accepted', () => {
    const harness = harnessFor();
    const service = intelligenceFor(harness);

    const snapshot = service.build();

    const unavailable = snapshot.symbols.filter(
      (symbol) => symbol.availability === 'UNAVAILABLE',
    );
    expect(unavailable.length).toBeGreaterThan(0);
    for (const symbol of unavailable) {
      expect(symbol.currentPrice).toBeNull();
      expect(symbol.open).toBeNull();
      expect(symbol.high).toBeNull();
      expect(symbol.low).toBeNull();
      expect(symbol.movement).toBeNull();
      expect(symbol.lastUpdatedAt).toBeNull();
      expect(symbol.freshness).toBeNull();
    }
    expect(snapshot.hasData).toBe(false);
    expect(snapshot.lastUpdate).toBeNull();
  });

  it('publishes the newest per-symbol timestamp, never the render time', async () => {
    const harness = harnessFor();
    const early = new Date('2026-09-30T09:00:00Z');
    await cycle(harness, { XAUUSD: 4_025 }, early);
    await cycle(
      harness,
      { [GOLD]: 17_500_000 },
      new Date('2026-09-30T09:02:00Z'),
    );

    const service = intelligenceFor(harness);
    const snapshot = service.build(new Date('2026-09-30T09:30:00Z'));

    expect(snapshot.lastUpdate).toBe('2026-09-30T09:02:00.000Z');
    expect(snapshot.generatedAt).toBe('2026-09-30T09:30:00.000Z');
    expect(snapshot.generatedAt).not.toBe(snapshot.lastUpdate);
  });
});

describe('MarketIntelligenceService — freshness (§16–§18, §53)', () => {
  it('marks a symbol stale without dropping its last valid price', async () => {
    const harness = harnessFor({ PRICE_STALE_AFTER_MINUTES: '1' });
    await cycle(
      harness,
      { [GOLD]: 17_200_000 },
      new Date(Date.now() - 30 * 60_000),
    );

    const snapshot = intelligenceFor(harness).build();
    const gold = snapshot.symbols.find((symbol) => symbol.symbol === GOLD);

    expect(gold?.availability).toBe('STALE');
    expect(gold?.freshness).toBe('STALE');
    expect(gold?.currentPrice).toBe(17_200_000);
    expect(snapshot.hasStale).toBe(true);
    expect(snapshot.summary.stale).toBeGreaterThan(0);
  });

  it('uses the Phase 1 threshold only (no second staleness rule)', async () => {
    const harness = harnessFor({ PRICE_STALE_AFTER_MINUTES: '45' });
    await cycle(
      harness,
      { [GOLD]: 17_200_000 },
      new Date(Date.now() - 10 * 60_000),
    );

    const gold = goldOf(intelligenceFor(harness));

    expect(gold.availability).toBe('AVAILABLE');
    expect(gold.freshness).toBe('FRESH');
  });
});

describe('MarketIntelligenceService — snapshot shape (§21, §22, §55)', () => {
  it('follows the canonical registry order, not the API response order', async () => {
    const harness = harnessFor();
    await cycle(harness, {
      USD: 1_055_000,
      [GOLD]: 17_500_000,
      IR_COIN_EMAMI: 92_000_000,
    });

    const snapshot = intelligenceFor(harness).build();

    expect(snapshot.symbols.map((symbol) => symbol.symbol)).toEqual(
      harness.config.symbolRegistry.map((definition) => definition.symbol),
    );
    expect(snapshot.symbols.length).toBe(harness.config.symbolRegistry.length);
  });

  it('keeps the canonical unit of every symbol (no conversion inside Phase 4)', async () => {
    const harness = harnessFor();
    await cycle(harness, { XAUUSD: 4_025, [GOLD]: 17_500_000 });

    const snapshot = intelligenceFor(harness).build();
    const gold = snapshot.symbols.find((symbol) => symbol.symbol === GOLD);
    const ounce = snapshot.symbols.find((symbol) => symbol.symbol === 'XAUUSD');

    expect(gold?.unit).toBe('RIAL');
    expect(ounce?.unit).toBe('USD');
    expect(ounce?.currentPrice).toBe(4_025);
  });

  it('summarises movement counts deterministically', async () => {
    const harness = harnessFor();
    const prices = {
      [GOLD]: 17_500_000,
      IR_COIN_EMAMI: 92_000_000,
      USD: 1_055_000,
    };
    await cycle(harness, prices);
    await cycle(harness, {
      [GOLD]: 17_550_000, // up
      IR_COIN_EMAMI: 91_900_000, // down
      USD: 1_055_000, // unchanged
    });

    const snapshot = intelligenceFor(harness).build();

    expect(snapshot.summary.increasing).toBe(1);
    expect(snapshot.summary.decreasing).toBe(1);
    expect(snapshot.summary.unchanged).toBe(1);
    expect(snapshot.summary.unknown).toBe(
      harness.config.symbolRegistry.length - 3,
    );
  });

  it('reads the market state once per symbol per build', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_500_000 });
    const spy = jest.spyOn(harness.marketState, 'getState');

    intelligenceFor(harness).build();

    expect(spy).toHaveBeenCalledTimes(harness.config.symbolRegistry.length);
  });
});

describe('MarketIntelligenceService — failure isolation (§45)', () => {
  it('reports a symbol as unavailable when its state read fails, without inventing data', () => {
    const harness = harnessFor();
    const service = intelligenceFor(harness);
    jest.spyOn(harness.marketState, 'getState').mockImplementation(() => {
      throw new Error('store offline');
    });

    const gold = goldOf(service);

    expect(gold.availability).toBe('UNAVAILABLE');
    expect(gold.currentPrice).toBeNull();
    expect(gold.lastUpdatedAt).toBeNull();
  });

  it('builds a single symbol on demand and rejects an unknown identifier', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_500_000 });
    const service = intelligenceFor(harness);

    expect(service.buildFor(GOLD)?.currentPrice).toBe(17_500_000);
    expect(service.buildFor('NOT_IN_REGISTRY')).toBeNull();
  });
});

describe('MarketIntelligenceService — partial data and restart (§52, §56)', () => {
  it('supports a market where only some symbols have valid data', async () => {
    const harness = harnessFor();
    await cycle(harness, { [GOLD]: 17_250_000, IR_COIN_EMAMI: 45_350_000 });

    const snapshot = intelligenceFor(harness).build();
    const bySymbol = new Map(
      snapshot.symbols.map((symbol) => [symbol.symbol, symbol]),
    );

    expect(bySymbol.get(GOLD)?.availability).toBe('AVAILABLE');
    expect(bySymbol.get('IR_COIN_EMAMI')?.availability).toBe('AVAILABLE');
    expect(bySymbol.get('USD')?.availability).toBe('UNAVAILABLE');
    expect(snapshot.hasData).toBe(true);
    expect(snapshot.summary.available).toBe(2);
  });

  it('restores daily statistics and movement from persisted Phase 1 state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atabak-intel-'));
    const file = join(directory, 'market-state.json');
    const env = { MARKET_STATE_FILE: file };

    try {
      const first = createMarketHarness(env);
      await cycle(first, { [GOLD]: 17_200_000 });
      await cycle(first, { [GOLD]: 17_260_000 });
      await first.marketState.persist(tehranDayKey(new Date()));

      // A brand-new service instance over the same file (simulated restart).
      const config = createAppConfigService(env);
      const restored = new MarketStateService(
        config,
        new MarketStateStore(config),
      );
      await restored.restore();

      const snapshot = new MarketIntelligenceService(config, restored).build();
      const gold = snapshot.symbols.find((symbol) => symbol.symbol === GOLD);

      expect(gold?.open).toBe(17_200_000);
      expect(gold?.currentPrice).toBe(17_260_000);
      expect(gold?.dailyChange).toBe(60_000);
      expect(gold?.movement).toBe(60_000);
      expect(gold?.lastUpdatedAt).not.toBeNull();
      expect(gold?.availability).toBe('AVAILABLE');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exposes the default seed prices unchanged for the other symbols (§9 no fabrication)', async () => {
    const harness = harnessFor();
    await cycle(harness, DEFAULT_SEED_PRICES);

    const snapshot = intelligenceFor(harness).build();
    const coin = snapshot.symbols.find(
      (symbol) => symbol.symbol === 'IR_COIN_EMAMI',
    );

    expect(coin?.currentPrice).toBe(DEFAULT_SEED_PRICES.IR_COIN_EMAMI);
    expect(coin?.availability).toBe('AVAILABLE');
    expect(snapshot.summary.unavailable).toBe(0);
  });
});

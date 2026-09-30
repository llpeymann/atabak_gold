import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { tehranDayKey } from '../common/tehran-time';
import { createAppConfigService } from '../testing/test-doubles';
import { MarketStateService } from './market-state.service';
import { MarketStateStore } from './market-state.store';
import { PriceEvaluation } from './market.types';
import { SYMBOL_DEFINITIONS, SymbolDefinition } from './symbols';

const DAY_ONE = '2026-09-30';
const DAY_TWO = '2026-10-01';

const gold = SYMBOL_DEFINITIONS.find(
  (definition) => definition.symbol === 'IR_GOLD_18K',
) as SymbolDefinition;

const evaluationOf = (
  price: number,
  evaluatedAt: string,
  extra: Partial<PriceEvaluation> = {},
): PriceEvaluation => ({
  symbol: gold.symbol,
  label: gold.label,
  section: gold.section,
  unit: gold.unit,
  accepted: true,
  price,
  previousPrice: null,
  baseline: 'NONE',
  maxChangePercent: gold.maxChangePercent,
  absoluteChange: null,
  percentageChange: null,
  direction: 'UNKNOWN',
  evaluatedAt,
  ...extra,
});

const createService = (env = {}) => {
  const config = createAppConfigService(env);
  const store = new MarketStateStore(config);

  return { service: new MarketStateService(config, store), store, config };
};

describe('MarketStateService', () => {
  it('refuses to commit a rejected price (defensive guard)', () => {
    const { service } = createService();

    expect(() =>
      service.commit(
        gold,
        evaluationOf(23_000_000, '2026-09-30T09:00:00.000Z', {
          accepted: false,
        }),
        DAY_ONE,
      ),
    ).toThrow(/rejected prices must never modify market state/);
  });

  it('tracks currentPrice, previousPrice and lastValidPrice', () => {
    const { service } = createService();

    service.commit(
      gold,
      evaluationOf(17_000_000, '2026-09-30T08:00:00.000Z'),
      DAY_ONE,
    );
    const state = service.commit(
      gold,
      evaluationOf(17_100_000, '2026-09-30T08:30:00.000Z', {
        previousPrice: 17_000_000,
        baseline: 'SAME_DAY',
        absoluteChange: 100_000,
        percentageChange: 0.588,
        direction: 'UP',
      }),
      DAY_ONE,
    );

    expect(state.currentPrice).toBe(17_100_000);
    expect(state.previousPrice).toBe(17_000_000);
    expect(state.lastValidPrice).toBe(17_100_000);
    expect(state.updatedAt).toBe('2026-09-30T08:30:00.000Z');
    expect(state.lastSuccessfulUpdate).toBe('2026-09-30T08:30:00.000Z');
    expect(state.direction).toBe('UP');
  });

  describe('daily statistics', () => {
    it('makes the first valid price of the day the open/high/low/current', () => {
      const { service } = createService();

      const state = service.commit(
        gold,
        evaluationOf(17_100_000, '2026-09-30T08:00:00.000Z'),
        DAY_ONE,
      );

      expect(state.daily).toEqual({
        open: 17_100_000,
        high: 17_100_000,
        low: 17_100_000,
        current: 17_100_000,
        change: 0,
      });
    });

    it('maintains open/high/low/current/change across the day', () => {
      const { service } = createService();

      service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:00:00.000Z'),
        DAY_ONE,
      );
      service.commit(
        gold,
        evaluationOf(17_100_000, '2026-09-30T10:00:00.000Z'),
        DAY_ONE,
      );
      service.commit(
        gold,
        evaluationOf(16_950_000, '2026-09-30T13:00:00.000Z'),
        DAY_ONE,
      );
      const state = service.commit(
        gold,
        evaluationOf(17_200_000, '2026-09-30T18:00:00.000Z'),
        DAY_ONE,
      );

      expect(state.daily).toEqual({
        open: 17_000_000,
        high: 17_200_000,
        low: 16_950_000,
        current: 17_200_000,
        change: 200_000,
      });
    });

    it('is unaffected by rejected values (the engine never commits them)', () => {
      const { service } = createService();

      service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:00:00.000Z'),
        DAY_ONE,
      );
      service.commit(
        gold,
        evaluationOf(17_100_000, '2026-09-30T08:30:00.000Z'),
        DAY_ONE,
      );
      // 23,000,000 is rejected by the sanity engine → never committed → stats stay clean.
      service.commit(
        gold,
        evaluationOf(17_200_000, '2026-09-30T09:00:00.000Z'),
        DAY_ONE,
      );

      const state = service.getState(gold);
      expect(state?.daily?.high).toBe(17_200_000);
      expect(state?.daily?.low).toBe(17_000_000);
      expect(state?.daily?.current).toBe(17_200_000);
    });

    it('resets daily statistics when the Tehran day changes', () => {
      const { service } = createService();

      service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:00:00.000Z'),
        DAY_ONE,
      );
      service.commit(
        gold,
        evaluationOf(17_500_000, '2026-09-30T20:00:00.000Z'),
        DAY_ONE,
      );

      service.rollDayIfNeeded(DAY_TWO);
      const state = service.commit(
        gold,
        evaluationOf(17_100_000, '2026-10-01T08:00:00.000Z'),
        DAY_TWO,
      );

      // Yesterday's close must never become today's open.
      expect(state.daily).toEqual({
        open: 17_100_000,
        high: 17_100_000,
        low: 17_100_000,
        current: 17_100_000,
        change: 0,
      });
      expect(state.dayKey).toBe(DAY_TWO);
      expect(state.previousPrice).toBeNull();
      expect(state.direction).toBe('UNKNOWN');
    });

    it('keeps the previous day price available as lastValidPrice after the reset', () => {
      const { service } = createService();

      service.commit(
        gold,
        evaluationOf(17_500_000, '2026-09-30T20:00:00.000Z'),
        DAY_ONE,
      );
      service.rollDayIfNeeded(DAY_TWO);

      expect(service.getLastValidPrice(gold.symbol)).toBe(17_500_000);
      expect(service.getSameDayPrice(gold.symbol, DAY_TWO)).toBeNull();
    });
  });

  describe('freshness / staleness', () => {
    it('reports state newer than the threshold as FRESH', () => {
      const { service } = createService({ PRICE_STALE_AFTER_MINUTES: '45' });
      const now = new Date('2026-09-30T09:00:00.000Z');

      service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:30:00.000Z'),
        DAY_ONE,
      );

      expect(service.getState(gold, now)?.freshness).toBe('FRESH');
    });

    it('reports older state as STALE while preserving lastValidPrice', () => {
      const { service } = createService({ PRICE_STALE_AFTER_MINUTES: '45' });
      const now = new Date('2026-09-30T12:00:00.000Z');

      service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:30:00.000Z'),
        DAY_ONE,
      );
      const state = service.getState(gold, now);

      expect(state?.freshness).toBe('STALE');
      expect(state?.lastValidPrice).toBe(17_000_000);
      expect(state?.ageMs).toBe(3.5 * 60 * 60 * 1000);
    });
  });

  describe('persistence and restart', () => {
    const stateFile = join(
      tmpdir(),
      `atabak-state-${process.pid}-${Math.random()}.json`,
    );
    const env = { MARKET_STATE_FILE: stateFile };

    afterEach(async () => {
      await rm(stateFile, { force: true });
      await rm(`${stateFile}.tmp`, { force: true });
    });

    it('persists state and restores it in a new instance (simulated restart)', async () => {
      // The restore logic resets the daily window when the persisted day is not the current
      // Tehran day, so this test must use *today* — otherwise it would only pass on one date.
      const today = tehranDayKey(new Date());
      const first = createService(env);
      first.service.commit(
        gold,
        evaluationOf(17_000_000, '2026-09-30T08:00:00.000Z'),
        today,
      );
      first.service.commit(
        gold,
        evaluationOf(17_100_000, '2026-09-30T08:30:00.000Z'),
        today,
      );
      await first.service.persist(today);

      const second = createService(env);
      await second.service.restore();
      const state = second.service.getState(gold);

      expect(state?.currentPrice).toBe(17_100_000);
      expect(state?.lastValidPrice).toBe(17_100_000);
      expect(state?.daily?.open).toBe(17_000_000);
      expect(state?.daily?.high).toBe(17_100_000);
    });

    it('does not let a previous day contaminate the restored daily statistics', async () => {
      const first = createService(env);
      // Day one at 23:00 Tehran (19:30 UTC) — well inside a different Tehran day than "now".
      first.service.commit(
        gold,
        evaluationOf(17_500_000, '2020-01-01T19:30:00.000Z'),
        '2020-01-01',
      );
      await first.service.persist('2020-01-01');

      const second = createService(env);
      await second.service.restore();

      const state = second.service.getState(gold);
      expect(state?.lastValidPrice).toBe(17_500_000); // valuable state survives…
      expect(state?.daily).toBeNull(); // …but today has no daily window yet (no contamination)
      expect(state?.previousPrice).toBeNull();
      expect(state?.direction).toBe('UNKNOWN');

      // The first accepted price of today opens the new window.
      const reopened = second.service.commit(
        gold,
        evaluationOf(17_600_000, '2026-09-30T08:00:00.000Z'),
        '2026-09-30',
      );
      expect(reopened.daily).toEqual({
        open: 17_600_000,
        high: 17_600_000,
        low: 17_600_000,
        current: 17_600_000,
        change: 0,
      });
    });

    it('starts from empty state when the file is missing or corrupted', async () => {
      const missing = createService(env);
      await missing.service.restore();
      expect(missing.service.getTrackedSymbolCount()).toBe(0);
    });
  });
});

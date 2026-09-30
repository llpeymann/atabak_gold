import { NormalizedPrice } from './market.types';
import { SanityChecker } from './sanity-checker.service';
import { SYMBOL_DEFINITIONS, SymbolDefinition } from './symbols';
import { createAppConfigService } from '../testing/test-doubles';

const EVALUATED_AT = '2026-09-30T09:00:00.000Z';

const goldDefinition = (
  overrides: Partial<SymbolDefinition> = {},
): SymbolDefinition => ({
  ...(SYMBOL_DEFINITIONS.find(
    (definition) => definition.symbol === 'IR_GOLD_18K',
  ) as SymbolDefinition),
  ...overrides,
});

const priceOf = (
  value: number,
  unit: NormalizedPrice['unit'] = 'RIAL',
): NormalizedPrice => ({
  symbol: 'IR_GOLD_18K',
  price: value,
  unit,
  sourceUnit: 'RIAL',
  sourceTimestamp: null,
  receivedAt: EVALUATED_AT,
  source: 'https://api.example.test/prices',
});

const createChecker = (env = {}) =>
  new SanityChecker(createAppConfigService(env));

describe('SanityChecker', () => {
  it('accepts a small, plausible move', () => {
    const checker = createChecker();
    const evaluation = checker.evaluate(
      priceOf(17_120_000),
      goldDefinition(),
      { price: 17_000_000, source: 'SAME_DAY' },
      EVALUATED_AT,
    );

    expect(evaluation.accepted).toBe(true);
    expect(evaluation.direction).toBe('UP');
    expect(evaluation.percentageChange).toBeCloseTo(0.70588, 4);
    expect(evaluation.absoluteChange).toBe(120_000);
  });

  it('accepts the first observation of a symbol (no baseline)', () => {
    const evaluation = createChecker().evaluate(
      priceOf(17_000_000),
      goldDefinition(),
      null,
      EVALUATED_AT,
    );

    expect(evaluation.accepted).toBe(true);
    expect(evaluation.baseline).toBe('NONE');
    expect(evaluation.direction).toBe('UNKNOWN');
    expect(evaluation.percentageChange).toBeNull();
  });

  it('rejects an excessive move as EXCESSIVE_CHANGE', () => {
    const evaluation = createChecker().evaluate(
      priceOf(23_000_000),
      goldDefinition(),
      { price: 17_000_000, source: 'SAME_DAY' },
      EVALUATED_AT,
    );

    expect(evaluation.accepted).toBe(false);
    expect(evaluation.reason).toBe('EXCESSIVE_CHANGE');
    expect(evaluation.percentageChange).toBeCloseTo(35.29, 2);
    expect(evaluation.detail).toContain('exceeds the allowed');
  });

  it('rejects values below/above the sanity bounds as OUT_OF_RANGE', () => {
    const checker = createChecker();

    const tooSmall = checker.evaluate(
      priceOf(100),
      goldDefinition(),
      null,
      EVALUATED_AT,
    );
    const tooBig = checker.evaluate(
      priceOf(9_000_000_000),
      goldDefinition(),
      null,
      EVALUATED_AT,
    );

    expect(tooSmall).toMatchObject({ accepted: false, reason: 'OUT_OF_RANGE' });
    expect(tooBig).toMatchObject({ accepted: false, reason: 'OUT_OF_RANGE' });
  });

  it('applies the cross-day multiplier when the baseline is from a previous day', () => {
    const checker = createChecker({ PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '2' });
    const definition = goldDefinition({ maxChangePercent: 10 }); // cross-day allowance = 20%

    const withinAllowance = checker.evaluate(
      priceOf(20_000_000), // +17.6%
      definition,
      { price: 17_000_000, source: 'PREVIOUS_DAY' },
      EVALUATED_AT,
    );
    const beyondAllowance = checker.evaluate(
      priceOf(21_000_000), // +23.5%
      definition,
      { price: 17_000_000, source: 'PREVIOUS_DAY' },
      EVALUATED_AT,
    );

    expect(withinAllowance.accepted).toBe(true);
    expect(beyondAllowance).toMatchObject({
      accepted: false,
      reason: 'EXCESSIVE_CHANGE',
    });
  });

  it('honours a per-symbol threshold override coming from the environment', () => {
    const registry = createAppConfigService({
      PRICE_THRESHOLD_OVERRIDES: 'IR_GOLD_18K=50',
    }).symbolRegistry;
    const definition = registry.find(
      (entry) => entry.symbol === 'IR_GOLD_18K',
    ) as SymbolDefinition;

    const evaluation = createChecker().evaluate(
      priceOf(23_000_000), // +35%
      definition,
      { price: 17_000_000, source: 'SAME_DAY' },
      EVALUATED_AT,
    );

    expect(definition.maxChangePercent).toBe(50);
    expect(evaluation.accepted).toBe(true);
  });

  it('applies the optional absolute-change guard (XAUUSD)', () => {
    const definition = SYMBOL_DEFINITIONS.find(
      (d) => d.symbol === 'XAUUSD',
    ) as SymbolDefinition;
    const price: NormalizedPrice = {
      ...priceOf(3_000, 'USD'),
      symbol: 'XAUUSD',
    };

    const evaluation = createChecker().evaluate(
      price,
      definition,
      { price: 2_650, source: 'SAME_DAY' }, // +350 USD, +13.2% → both guards trip
      EVALUATED_AT,
    );

    expect(evaluation.accepted).toBe(false);
    expect(['EXCESSIVE_CHANGE', 'OUT_OF_RANGE']).toContain(evaluation.reason);
  });

  describe('tolerance resolution', () => {
    it('uses the documented per-symbol tolerance, not the global fallback', () => {
      const checker = createChecker({ PRICE_MAX_CHANGE_PERCENT: '3' });
      // IR_GOLD_18K documents 10%: a 7% move is allowed even though the fallback says 3%.
      const evaluation = checker.evaluate(
        priceOf(17_000_000 * 1.07),
        goldDefinition(),
        { price: 17_000_000, source: 'SAME_DAY' },
        EVALUATED_AT,
      );

      expect(evaluation.maxChangePercent).toBe(10);
      expect(evaluation.accepted).toBe(true);
    });

    it('skips the percentage guard when no tolerance is configured at all', () => {
      const checker = createChecker();
      const evaluation = checker.evaluate(
        priceOf(17_000_000 * 1.5),
        goldDefinition({ maxChangePercent: null }),
        { price: 17_000_000, source: 'SAME_DAY' },
        EVALUATED_AT,
      );

      // No documented tolerance and no fallback available → stated as such, not silently passed.
      expect(evaluation.maxChangePercent).toBeNull();
      expect(evaluation.accepted).toBe(true);
      expect(evaluation.reason).toBeUndefined();
    });

    it('still applies the range guard when the percentage guard is skipped', () => {
      const checker = createChecker();
      const evaluation = checker.evaluate(
        priceOf(999),
        goldDefinition({ maxChangePercent: null }),
        { price: 1_000, source: 'SAME_DAY' },
        EVALUATED_AT,
      );

      expect(evaluation.accepted).toBe(false);
      expect(evaluation.reason).toBe('OUT_OF_RANGE');
    });
  });

  describe('buildBaseline', () => {
    it('prefers the same-day price', () => {
      expect(createChecker().buildBaseline(17_000_000, 16_000_000)).toEqual({
        price: 17_000_000,
        source: 'SAME_DAY',
      });
    });

    it('falls back to the previous day price', () => {
      expect(createChecker().buildBaseline(null, 16_000_000)).toEqual({
        price: 16_000_000,
        source: 'PREVIOUS_DAY',
      });
    });

    it('has no baseline when nothing valid is known', () => {
      expect(createChecker().buildBaseline(null, null)).toBeNull();
    });

    it('ignores a non-positive baseline', () => {
      expect(createChecker().buildBaseline(0, 0)).toBeNull();
    });
  });
});

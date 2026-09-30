import { SymbolDefinition } from './market.types';
import {
  buildSymbolRegistry,
  symbolsBySection,
  SYMBOL_DEFINITIONS,
} from './symbols';
import { createAppConfigService } from '../testing/test-doubles';

describe('symbol registry (single source of truth)', () => {
  it('declares every supported symbol exactly once', () => {
    const symbols = SYMBOL_DEFINITIONS.map((definition) => definition.symbol);

    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols).toEqual(
      expect.arrayContaining([
        'XAUUSD',
        'IR_GOLD_18K',
        'IR_GOLD_24K',
        'IR_GOLD_MELTED',
        'IR_COIN_EMAMI',
        'IR_COIN_BAHAR',
        'IR_COIN_HALF',
        'IR_COIN_QUARTER',
        'IR_COIN_1G',
        'USDT_IRT',
        'USD',
        'EUR',
        'GBP',
        'TRY',
        'AED',
        'CNY',
      ]),
    );
  });

  it('documents a rationale and thresholds for every symbol', () => {
    for (const definition of SYMBOL_DEFINITIONS) {
      expect(definition.rationale.length).toBeGreaterThan(20);
      expect(definition.maxChangePercent).toBeGreaterThan(0);
      expect(definition.maxChangePercent).toBeLessThanOrEqual(100);
      expect(definition.minPrice === null || definition.minPrice > 0).toBe(
        true,
      );
      expect(
        definition.maxPrice === null ||
          (definition.minPrice !== null &&
            definition.maxPrice > definition.minPrice),
      ).toBe(true);
    }
  });

  it('marks the section anchors as required', () => {
    const required = SYMBOL_DEFINITIONS.filter(
      (definition) => definition.required,
    ).map((definition) => definition.symbol);

    expect(required.sort()).toEqual(['IR_COIN_EMAMI', 'IR_GOLD_18K', 'USD']);
  });

  it('keeps USD-quoted instruments in the USD unit', () => {
    const ounce = SYMBOL_DEFINITIONS.find(
      (definition) => definition.symbol === 'XAUUSD',
    );

    expect(ounce?.unit).toBe('USD');
  });

  it('orders symbols inside a section', () => {
    expect(
      symbolsBySection(SYMBOL_DEFINITIONS, 'gold').map((d) => d.symbol),
    ).toEqual(['XAUUSD', 'IR_GOLD_18K', 'IR_GOLD_24K', 'IR_GOLD_MELTED']);
    expect(symbolsBySection(SYMBOL_DEFINITIONS, 'coins')).toHaveLength(5);
    expect(symbolsBySection(SYMBOL_DEFINITIONS, 'currency')).toHaveLength(7);
  });

  describe('threshold overrides', () => {
    it('keeps the documented per-symbol tolerance when only a global default is configured', () => {
      const registry = buildSymbolRegistry({ defaultMaxChangePercent: 3 });

      // The documented thresholds stay authoritative — the global value is a fallback only.
      expect(registry.find((d) => d.symbol === 'USD')?.maxChangePercent).toBe(
        8,
      );
      expect(
        registry.find((d) => d.symbol === 'IR_GOLD_18K')?.maxChangePercent,
      ).toBe(10);
      expect(registry.every((d) => d.maxChangePercent !== 3)).toBe(true);
    });

    it('applies explicit per-symbol overrides on top of the documented tolerances', () => {
      const registry = buildSymbolRegistry({
        defaultMaxChangePercent: 3,
        maxChangePercentBySymbol: { USD: 6 },
      });

      expect(registry.find((d) => d.symbol === 'USD')?.maxChangePercent).toBe(
        6,
      );
      expect(registry.find((d) => d.symbol === 'EUR')?.maxChangePercent).toBe(
        8,
      );
    });

    it('uses the global default only for symbols without a documented tolerance', () => {
      const undocumented: SymbolDefinition = {
        ...SYMBOL_DEFINITIONS[0],
        symbol: 'NO_TOLERANCE',
        maxChangePercent: null,
      };

      const withFallback = buildSymbolRegistry({ defaultMaxChangePercent: 3 }, [
        ...SYMBOL_DEFINITIONS,
        undocumented,
      ]);
      expect(
        withFallback.find((d) => d.symbol === 'NO_TOLERANCE')?.maxChangePercent,
      ).toBe(3);

      const withoutFallback = buildSymbolRegistry({}, [
        ...SYMBOL_DEFINITIONS,
        undocumented,
      ]);
      expect(
        withoutFallback.find((d) => d.symbol === 'NO_TOLERANCE')
          ?.maxChangePercent,
      ).toBeNull();
    });

    it('ignores invalid override values', () => {
      const registry = buildSymbolRegistry({
        defaultMaxChangePercent: Number.NaN,
        maxChangePercentBySymbol: { USD: -1 },
      });

      expect(registry.find((d) => d.symbol === 'USD')?.maxChangePercent).toBe(
        8,
      );
    });

    it('is applied through the configuration service', () => {
      const registry = createAppConfigService({
        PRICE_MAX_CHANGE_PERCENT: '6',
        PRICE_THRESHOLD_OVERRIDES: 'XAUUSD=20',
      }).symbolRegistry;

      expect(
        registry.find((d) => d.symbol === 'XAUUSD')?.maxChangePercent,
      ).toBe(20);
      // Documented tolerances are untouched by the global fallback…
      expect(registry.find((d) => d.symbol === 'USD')?.maxChangePercent).toBe(
        8,
      );
      expect(
        registry.find((d) => d.symbol === 'IR_COIN_EMAMI')?.maxChangePercent,
      ).toBe(12);
    });
  });
});

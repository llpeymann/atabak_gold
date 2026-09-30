import { PriceNormalizer } from './price-normalizer.service';
import { RawPayloadParser } from './raw-payload.parser';
import { SYMBOL_DEFINITIONS } from './symbols';
import { createAppConfigService } from '../testing/test-doubles';

const SOURCE = 'https://api.example.test/prices';
const RECEIVED_AT = '2026-09-30T09:00:00.000Z';

const createNormalizer = (env = {}) =>
  new PriceNormalizer(createAppConfigService(env));

const normalize = (
  payload: Record<string, unknown>,
  env = {},
): ReturnType<PriceNormalizer['normalize']> => {
  const parser = new RawPayloadParser();
  const normalizer = createNormalizer(env);

  return normalizer.normalize(
    parser.parse(payload),
    SYMBOL_DEFINITIONS,
    SOURCE,
    RECEIVED_AT,
  );
};

describe('PriceNormalizer', () => {
  it('normalizes a numeric price into the internal contract', () => {
    const result = normalize({
      gold: [{ symbol: 'IR_GOLD_18K', price: 17981900 }],
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.normalized).toEqual([
      {
        symbol: 'IR_GOLD_18K',
        price: 17981900,
        unit: 'RIAL',
        sourceUnit: 'RIAL',
        sourceTimestamp: null,
        receivedAt: RECEIVED_AT,
        source: SOURCE,
      },
    ]);
  });

  it('normalizes a numeric string', () => {
    const result = normalize({
      currency: [{ symbol: 'USD', price: '17000000' }],
    });

    expect(result.normalized[0]?.price).toBe(17000000);
  });

  it('rejects a zero price (INVALID_PRICE)', () => {
    const result = normalize({ currency: [{ symbol: 'USD', price: 0 }] });

    expect(result.normalized).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({
      symbol: 'USD',
      reason: 'INVALID_PRICE',
    });
  });

  it.each([
    ['null', null],
    ['NaN string', 'abc'],
    ['empty string', ''],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative value', -17000000],
    ['a boolean', true],
    ['an object', { value: 1 }],
  ])('rejects %s as INVALID_NUMBER or INVALID_PRICE', (_label, value) => {
    const result = normalize({ currency: [{ symbol: 'USD', price: value }] });

    expect(result.normalized).toHaveLength(0);
    expect(['INVALID_NUMBER', 'INVALID_PRICE']).toContain(
      result.rejected[0]?.reason,
    );
  });

  it('rejects a symbol that is not in the registry', () => {
    const result = normalize({ currency: [{ symbol: 'BTC', price: 1000 }] });

    expect(result.normalized).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({
      symbol: 'BTC',
      reason: 'UNKNOWN_SYMBOL',
    });
  });

  it('converts Toman values into the canonical Rial value (single conversion point)', () => {
    const result = normalize(
      { currency: [{ symbol: 'USD', price: 103200 }] },
      {
        PRICE_API_UNIT: 'TOMAN',
      },
    );

    expect(result.normalized[0]).toMatchObject({
      price: 1032000,
      sourceUnit: 'TOMAN',
      unit: 'RIAL',
    });
  });

  it('honours per-symbol unit overrides', () => {
    const result = normalize(
      { currency: [{ symbol: 'USDT_IRT', price: 103500 }] },
      { PRICE_API_UNIT: 'RIAL', PRICE_SYMBOL_UNITS: 'USDT_IRT=TOMAN' },
    );

    expect(result.normalized[0]).toMatchObject({
      price: 1035000,
      sourceUnit: 'TOMAN',
    });
  });

  it('keeps USD-quoted instruments (XAUUSD) in their own unit, without FX conversion', () => {
    const result = normalize(
      { gold: [{ symbol: 'XAUUSD', price: 2650.75 }] },
      {
        PRICE_API_UNIT: 'TOMAN',
      },
    );

    expect(result.normalized[0]).toMatchObject({
      price: 2650.75,
      unit: 'USD',
      sourceUnit: 'RIAL',
    });
  });

  it('keeps the first occurrence when the payload repeats a symbol', () => {
    const result = normalize({
      currency: [
        { symbol: 'USD', price: 1032000 },
        { symbol: 'USD', price: 9999999 },
      ],
    });

    expect(result.normalized).toHaveLength(1);
    expect(result.normalized[0]?.price).toBe(1032000);
  });

  it('separates valid and invalid symbols in the same payload', () => {
    const result = normalize({
      gold: [
        { symbol: 'IR_GOLD_18K', price: 17981900 },
        { symbol: 'IR_GOLD_24K', price: 'not-a-number' },
      ],
    });

    expect(result.normalized.map((price) => price.symbol)).toEqual([
      'IR_GOLD_18K',
    ]);
    expect(result.rejected.map((evaluation) => evaluation.symbol)).toEqual([
      'IR_GOLD_24K',
    ]);
  });
});

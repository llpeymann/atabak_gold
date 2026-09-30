import { RawPayloadParser } from './raw-payload.parser';
import { SchemaValidationError } from './market.types';

describe('RawPayloadParser (schema validation)', () => {
  const parser = new RawPayloadParser();

  const validPayload = () => ({
    gold: [
      {
        symbol: 'IR_GOLD_18K',
        name: 'طلای ۱۸ عیار',
        price: 17981900,
        change_percent: 1.15,
      },
    ],
    currency: [{ symbol: 'USD', price: '1032000' }],
  });

  it('parses a well-formed payload', () => {
    const parsed = parser.parse(validPayload());

    expect(parsed.entries).toEqual([
      {
        symbol: 'IR_GOLD_18K',
        name: 'طلای ۱۸ عیار',
        rawPrice: 17981900,
        rawChangePercent: 1.15,
      },
      {
        symbol: 'USD',
        name: null,
        rawPrice: '1032000',
        rawChangePercent: null,
      },
    ]);
    expect(parsed.sourceTimestamp).toBeNull();
  });

  it('accepts a payload with only one section', () => {
    expect(
      parser.parse({ gold: [{ symbol: 'XAUUSD', price: 2650 }] }).entries,
    ).toHaveLength(1);
  });

  it('reads an optional source timestamp and normalizes it to ISO', () => {
    const parsed = parser.parse({
      ...validPayload(),
      timestamp: '2026-09-30T09:00:00+03:30',
    });

    expect(parsed.sourceTimestamp).toBe('2026-09-30T05:30:00.000Z');
  });

  it('ignores an unparsable source timestamp', () => {
    expect(
      parser.parse({ ...validPayload(), timestamp: 'not-a-date' })
        .sourceTimestamp,
    ).toBeNull();
  });

  describe('rejects structurally invalid payloads with INVALID_SCHEMA', () => {
    it.each([
      ['null', null],
      ['a string', 'unexpected'],
      ['an array', []],
      ['an empty object', {}],
    ])('%s', (_label, payload) => {
      expect(() => parser.parse(payload)).toThrow(SchemaValidationError);
    });

    it('without any symbol entry', () => {
      expect(() => parser.parse({ gold: [], currency: [] })).toThrow(
        /no symbol entries/,
      );
    });

    it('when a section is not an array', () => {
      expect(() =>
        parser.parse({ gold: { symbol: 'IR_GOLD_18K', price: 1 } }),
      ).toThrow(/"gold" must be an array/);
    });

    it('when an item is not an object', () => {
      expect(() => parser.parse({ gold: [42] })).toThrow(
        /"gold\[0\]" must be an object/,
      );
    });

    it('when an item has no symbol', () => {
      expect(() => parser.parse({ gold: [{ price: 1 }] })).toThrow(
        /no usable "symbol" string/,
      );
    });

    it('when an item has no price field at all', () => {
      expect(() => parser.parse({ gold: [{ symbol: 'IR_GOLD_18K' }] })).toThrow(
        /has no "price" field/,
      );
    });
  });

  it('reports the reason as INVALID_SCHEMA on the thrown error', () => {
    try {
      parser.parse({});
      fail('expected the parser to reject an empty payload');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).reason).toBe('INVALID_SCHEMA');
    }
  });

  it('keeps a null price in the parsed output (numeric validation happens later)', () => {
    const parsed = parser.parse({
      gold: [{ symbol: 'IR_GOLD_18K', price: null }],
    });

    expect(parsed.entries[0]?.rawPrice).toBeNull();
  });
});

import {
  parsePercentInput,
  parsePriceInput,
  parseUserNumber,
} from './number-input';

/**
 * Strict numeric input (Phase 3 §27/§28).
 *
 * The wizard accepts Persian/Latin digits and the common separators, and must refuse everything
 * ambiguous: a misread number would create an alert with a wrong target.
 */
describe('parseUserNumber', () => {
  it.each([
    ['17500000', 17_500_000],
    ['17,500,000', 17_500_000],
    ['17٬500٬000', 17_500_000],
    ['۱۷٬۵۰۰٬۰۰۰', 17_500_000],
    ['۱۷۵۰۰۰۰۰', 17_500_000],
    ['17 500 000', 17_500_000],
    ['1,234.56', 1234.56],
    ['  17,500,000  ', 17_500_000],
    ['1.5', 1.5],
    ['۱٫۵', 1.5],
    ['١٢٣٤', 1234],
    ['+42', 42],
  ])('parses %s', (raw, expected) => {
    expect(parseUserNumber(raw)?.value).toBe(expected);
  });

  it('reports integrality', () => {
    expect(parseUserNumber('17,500,000')?.integer).toBe(true);
    expect(parseUserNumber('4.5')?.integer).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['abc', 'letters'],
    ['123abc', 'trailing junk'],
    ['12.3.4', 'two decimal separators'],
    ['1,2,3,4', 'wrong group width is ambiguous'],
    ['12,34', 'a two-digit group is ambiguous'],
    ['1,2345', 'a four-digit group is ambiguous'],
    ['1e5', 'scientific notation'],
    ['0x10', 'hex notation'],
    ['--5', 'double sign'],
    ['۵ ریال', 'unit suffix'],
    ['1/2', 'fraction'],
    ['NaN', 'NaN text'],
    ['Infinity', 'Infinity text'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseUserNumber(raw)).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(parseUserNumber(null)).toBeNull();
    expect(parseUserNumber(undefined)).toBeNull();
  });

  it('rejects a value that overflows to infinity', () => {
    expect(parseUserNumber('9'.repeat(400))).toBeNull();
  });

  it('keeps the sign of a negative number (the domain layer rejects it later)', () => {
    expect(parseUserNumber('-5')).toEqual({ value: -5, integer: true });
  });
});

describe('parsePercentInput', () => {
  it('parses Persian digits and decimals', () => {
    expect(parsePercentInput('۵')).toBe(5);
    expect(parsePercentInput('0.75')).toBe(0.75);
    expect(parsePercentInput('۲٫۵')).toBe(2.5);
  });

  it('rejects a signed input: the direction is chosen explicitly, never inferred', () => {
    expect(parsePercentInput('-5')).toBeNull();
    expect(parsePercentInput('+5')).toBeNull();
    expect(parsePercentInput('−5')).toBeNull(); // U+2212 minus
  });

  it('returns the magnitude for an unsigned input', () => {
    expect(parsePercentInput('  12  ')).toBe(12);
  });

  it('rejects junk', () => {
    expect(parsePercentInput('')).toBeNull();
    expect(parsePercentInput(null)).toBeNull();
    expect(parsePercentInput('پنج')).toBeNull();
    expect(parsePercentInput('5%')).toBeNull();
  });

  it('passes zero and negative results to the domain layer unchanged for rejection', () => {
    // The parser must not invent a policy: `0` is a syntactically valid number, and the alert
    // service refuses it with a Persian message (`ALERT_MIN_TARGET_PERCENT`).
    expect(parsePercentInput('0')).toBe(0);
  });
});

describe('parsePriceInput', () => {
  it('parses grouped and decimal prices', () => {
    expect(parsePriceInput('17,500,000')).toBe(17_500_000);
    expect(parsePriceInput('۴٫۵')).toBe(4.5);
  });

  it('returns null for anything unparsable', () => {
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput(null)).toBeNull();
    expect(parsePriceInput('درباره')).toBeNull();
    expect(parsePriceInput('1e9')).toBeNull();
  });

  it('preserves a negative sign for the domain layer to reject', () => {
    expect(parsePriceInput('-17,500,000')).toBe(-17_500_000);
  });
});

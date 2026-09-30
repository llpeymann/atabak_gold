import {
  formatMoney,
  formatPercentFa,
  fromRial,
  isUsableMarketAmount,
  parseAmount,
  toRial,
} from './money';

describe('money helpers (Rial/Toman single source of truth)', () => {
  describe('toRial / fromRial', () => {
    it('converts Toman into the canonical Rial value', () => {
      expect(toRial(1500, 'TOMAN')).toBe(15000);
    });

    it('keeps Rial values untouched', () => {
      expect(toRial(1500, 'RIAL')).toBe(1500);
    });

    it('round-trips a Toman value', () => {
      expect(fromRial(toRial(2500, 'TOMAN'), 'TOMAN')).toBe(2500);
    });
  });

  describe('parseAmount', () => {
    it('accepts finite numbers', () => {
      expect(parseAmount(1200)).toBe(1200);
    });

    it('accepts numeric strings with separators', () => {
      expect(parseAmount('1,798,190')).toBe(1798190);
      expect(parseAmount('۱۷٬۹۸۱٬۹۰۰')).toBe(17981900);
    });

    it('accepts Persian digits', () => {
      expect(parseAmount('۱۷۹۸۱۹۰۰')).toBe(17981900);
    });

    it('rejects unusable values', () => {
      expect(parseAmount(null)).toBeNull();
      expect(parseAmount(undefined)).toBeNull();
      expect(parseAmount('')).toBeNull();
      expect(parseAmount('not-a-number')).toBeNull();
      expect(parseAmount(Number.POSITIVE_INFINITY)).toBeNull();
    });
  });

  describe('isUsableMarketAmount', () => {
    it('requires a positive finite value', () => {
      expect(isUsableMarketAmount(1)).toBe(true);
      expect(isUsableMarketAmount(0)).toBe(false);
      expect(isUsableMarketAmount(-5)).toBe(false);
      expect(isUsableMarketAmount(null)).toBe(false);
    });
  });

  describe('formatMoney', () => {
    it('always renders the unit so a value can never be ambiguous', () => {
      expect(formatMoney(17981900, 'RIAL')).toBe('۱۷٬۹۸۱٬۹۰۰ ریال');
      expect(formatMoney(17981900, 'TOMAN')).toBe('۱٬۷۹۸٬۱۹۰ تومان');
    });
  });

  describe('formatPercentFa', () => {
    it('rounds to two decimals and keeps the sign', () => {
      expect(formatPercentFa(1.23456)).toBe('+۱٫۲۳%');
      expect(formatPercentFa(-2.5)).toBe('−۲٫۵%');
      expect(formatPercentFa(0)).toBe('۰%');
    });

    it('returns null for unusable values', () => {
      expect(formatPercentFa(null)).toBeNull();
      expect(formatPercentFa('abc')).toBeNull();
    });
  });
});

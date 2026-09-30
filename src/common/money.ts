/**
 * Money helpers — single source of truth for Rial/Toman handling.
 *
 * Canonical internal unit of the whole application: **Rial**.
 * Every value that travels through services (price API → … → message builder → delivery)
 * is stored in Rial and is named `priceInRial` so the unit is visible at the call site.
 * Conversion to another unit happens **only** through the helpers below, never inline.
 */

export type MoneyUnit = 'RIAL' | 'TOMAN';

/** 1 Toman = 10 Rial. */
export const RIAL_PER_TOMAN = 10;

export const MONEY_UNIT_LABELS: Record<MoneyUnit, string> = {
  RIAL: 'ریال',
  TOMAN: 'تومان',
};

export function isMoneyUnit(value: unknown): value is MoneyUnit {
  return value === 'RIAL' || value === 'TOMAN';
}

/** Convert an amount expressed in `unit` into the canonical internal unit (Rial). */
export function toRial(amount: number, unit: MoneyUnit): number {
  return unit === 'TOMAN' ? amount * RIAL_PER_TOMAN : amount;
}

/** Convert a canonical (Rial) amount into the requested display unit. */
export function fromRial(amountInRial: number, unit: MoneyUnit): number {
  return unit === 'TOMAN' ? amountInRial / RIAL_PER_TOMAN : amountInRial;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Convert Persian/Arabic-Indic digits to ASCII digits.
 * Exported because every numeric input path (price API payloads *and* user text) must use the
 * same conversion — a second implementation would silently drift.
 */
export function normalizeDigitsToAscii(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persianIndex = PERSIAN_DIGITS.indexOf(digit);
    const index =
      persianIndex >= 0 ? persianIndex : ARABIC_INDIC_DIGITS.indexOf(digit);

    return String(index);
  });
}

/**
 * Parse a raw value coming from the price API (number or numeric string).
 * Returns `null` when the value is not a finite number — callers must treat `null` as "no price".
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }

  if (typeof raw === 'string') {
    // Remove Latin/Persian thousands separators and spaces before parsing.
    const normalized = normalizeDigitsToAscii(raw).replace(/[,،\u066c\s]/g, '');
    if (normalized === '') {
      return null;
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  return null;
}

/** A market amount is usable only when it is a finite number greater than zero. */
export function isUsableMarketAmount(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

const numberFormatterFa = new Intl.NumberFormat('fa-IR', {
  maximumFractionDigits: 0,
});
const decimalFormatterFa = new Intl.NumberFormat('fa-IR', {
  maximumFractionDigits: 2,
});

/** Format a plain number with Persian digits (no unit attached). */
export function formatNumberFa(value: number): string {
  return numberFormatterFa.format(value);
}

/**
 * Format a canonical (Rial) amount for user-facing output.
 * The unit label is always attached, so a rendered value can never be ambiguous.
 */
export function formatMoney(
  amountInRial: number,
  displayUnit: MoneyUnit,
): string {
  const converted = fromRial(amountInRial, displayUnit);
  return `${decimalFormatterFa.format(converted)} ${MONEY_UNIT_LABELS[displayUnit]}`;
}

/** Format a percentage value rounded to at most two decimals, with an explicit sign. */
export function formatPercentFa(raw: unknown): string | null {
  const value = parseAmount(raw);
  if (value === null) {
    return null;
  }
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${decimalFormatterFa.format(Math.abs(value))}%`;
}

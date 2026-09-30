import { normalizeDigitsToAscii, parseAmount } from '../../common/money';

/**
 * Strict parser for the two numeric inputs of the alert wizard (Phase 3 §27, §28).
 *
 * Deliberately strict: it accepts Persian/Arabic-Indic digits, Latin digits, the common thousand
 * separators (`,` `٬` `،`) and the Persian/Latin decimal separator (`٫` `.`), and rejects
 * everything else (letters, mixed junk, multiple decimal points, scientific notation). An
 * ambiguous input must be refused instead of silently misread — a wrong target would create a
 * wrong alert.
 */

/**
 * Input shapes accepted *before* separators are stripped:
 *  - plain digits, optionally signed, optional fraction (`17`, `-17.5`, `.5`),
 *  - or grouped digits where **every** group after a separator has exactly three digits
 *    (`17,500,000`, `۱۷٬۵۰۰٬۰۰۰`, `17 500 000`).
 *
 * Anything else (`1,2,3,4`, `12,34`, `1,2345`) is ambiguous, so it is refused instead of being
 * guessed at: a misread number would silently create an alert with the wrong target.
 */
const SEGMENTED_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:[,٬، ]\d{3})+)(?:\.\d*)?$/;
/** A fraction without an integer part (`.5`, `-.5`). */
const FRACTION_ONLY = /^[+-]?\.\d+$/;
/** Separators and whitespace are removed once the shape has been validated. */
const THOUSAND_SEPARATORS = /[,٬،\s]/g;
/** The Persian decimal separator is normalized to the Latin one. */
const PERSIAN_DECIMAL = /\u066B/g;
/** Latin ASCII digits after normalization (validated again before `parseAmount`). */
const ASCII_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface ParsedNumber {
  /** The parsed value, guaranteed to be a finite number. */
  value: number;
  /** True when the input was an integer (used to keep percentage inputs tidy). */
  integer: boolean;
}

export function parseUserNumber(
  raw: string | null | undefined,
): ParsedNumber | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed === '') {
    return null;
  }

  // Digits first (Persian/Arabic-Indic → ASCII), then separators: the shape check below is
  // therefore written once, in ASCII terms only.
  // Separators are kept for the shape check below and stripped afterwards.
  const normalized = normalizeDigitsToAscii(trimmed).replace(
    PERSIAN_DECIMAL,
    '.',
  );

  // A leading sign is accepted for convenience; the domain layer still rejects invalid values.
  const shaped =
    SEGMENTED_NUMBER.test(normalized) || FRACTION_ONLY.test(normalized);

  if (!shaped) {
    return null;
  }

  const plain = normalized.replace(THOUSAND_SEPARATORS, '');

  if (!ASCII_NUMBER.test(plain)) {
    return null;
  }

  const value = parseAmount(plain);

  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return { value, integer: Number.isInteger(value) };
}

/**
 * The wizard asks for a *magnitude* for percentage alerts (§28): the direction is a separate
 * choice, so a sign in the input would be ambiguous and is rejected.
 */
export function parsePercentInput(
  raw: string | null | undefined,
): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  if (/^[+-]/.test(raw.trim())) {
    return null;
  }

  const parsed = parseUserNumber(raw);

  if (!parsed) {
    return null;
  }

  return Math.abs(parsed.value);
}

export function parsePriceInput(raw: string | null | undefined): number | null {
  // `parseUserNumber` already guarantees a finite value: no further interpretation is allowed.
  return parseUserNumber(raw)?.value ?? null;
}

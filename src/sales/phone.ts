/**
 * Phase 9 — phone-number normalization (§5.2).
 *
 * The project supports exactly one market and one country, so the supported grammar is deliberately
 * narrow and explicit: Iranian mobile numbers and Iranian landlines. Everything else is refused with
 * a message the customer can act on — a syntactically invalid number must never become a stored lead.
 *
 * Two rules from the specification are encoded here:
 *
 *  * Persian (`۰۱۲…`) and Arabic-Indic (`٠١٢…`) digits are accepted and normalized, because that is
 *    what people actually type on Iranian keyboards and on Bale.
 *  * A number that parses is **not** a verified number. `phoneVerified` stays `false` everywhere in
 *    this phase; there is no SMS provider and no platform contact-sharing capability in this project,
 *    and claiming otherwise would be a fabrication.
 */

/** Persian digits, in order. */
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
/** Arabic-Indic digits, in order. */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Characters that are silently ignored inside a typed number (never inside a name). */
const SEPARATORS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '-',
  '–',
  '—',
  '.',
  '(',
  ')',
  '\u200c', // ZWNJ — appears when text is copied out of formatted pages
  '\u200f', // RTL mark
  '\u200e', // LTR mark
]);

/** Convert Persian/Arabic-Indic digits to ASCII digits; every other character is left alone. */
export function toAsciiDigits(input: string): string {
  let output = '';

  for (const character of input) {
    const persianIndex = PERSIAN_DIGITS.indexOf(character);

    if (persianIndex >= 0) {
      output += String(persianIndex);
      continue;
    }

    const arabicIndex = ARABIC_DIGITS.indexOf(character);

    if (arabicIndex >= 0) {
      output += String(arabicIndex);
      continue;
    }

    output += character;
  }

  return output;
}

export type PhoneKind = 'MOBILE' | 'LANDLINE';

export interface NormalizedPhone {
  /** Canonical `+98…` form — the only representation persisted and matched against. */
  canonical: string;
  kind: PhoneKind;
  /** Human-readable Persian form for review screens (`۰۹۱۲ ۳۴۵ ۶۷۸۹`). */
  display: string;
}

export type PhoneNormalization =
  | { ok: true; value: NormalizedPhone }
  | {
      ok: false;
      reason:
        | 'EMPTY'
        | 'INVALID_CHARACTERS'
        | 'INVALID_LENGTH'
        | 'UNSUPPORTED_PREFIX';
    };

/**
 * Normalize one typed phone number.
 *
 * Accepted (all become `+98…`):
 *   `09121234567` · `۰۹۱۲۱۲۳۴۵۶۷` · `+989121234567` · `00989121234567` · `989121234567` ·
 *   `9121234567` · `02122334455` · `+982122334455`
 */
export function normalizePhone(raw: string): PhoneNormalization {
  const ascii = toAsciiDigits(raw).trim();

  if (ascii === '') {
    return { ok: false, reason: 'EMPTY' };
  }

  let digits = '';

  for (const character of ascii) {
    if (SEPARATORS.has(character)) {
      continue;
    }

    if (character === '+') {
      // Only a single leading `+` is meaningful.
      if (digits !== '') {
        return { ok: false, reason: 'INVALID_CHARACTERS' };
      }

      continue;
    }

    if (character < '0' || character > '9') {
      return { ok: false, reason: 'INVALID_CHARACTERS' };
    }

    digits += character;
  }

  // `00` and `+` are the same international prefix; the country code is dropped only when it is
  // unambiguous (a national number cannot be 12 digits long).
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('98') && digits.length > 11) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) {
    return { ok: false, reason: 'INVALID_LENGTH' };
  }

  const startsWithMobile = digits.startsWith('9');
  const startsWithAreaCode = /^[1-8]/.test(digits);

  if (!startsWithMobile && !startsWithAreaCode) {
    return { ok: false, reason: 'UNSUPPORTED_PREFIX' };
  }

  const canonical = `+98${digits}`;

  return {
    ok: true,
    value: {
      canonical,
      kind: startsWithMobile ? 'MOBILE' : 'LANDLINE',
      display: formatPhoneFa(canonical),
    },
  };
}

/**
 * Display form for humans: `+989121234567` → `۰۹۱۲ ۱۲۳ ۴۵۶۷` (mobile) or
 * `+982122334455` → `۰۲۱ ۲۲۳۳۴۴۵۵` (landline). Grouping is presentational only.
 */
export function formatPhoneFa(canonical: string): string {
  const digits = toAsciiDigits(canonical).replace('+98', '');

  if (digits.length !== 10) {
    return toPersianDigits(canonical);
  }

  if (digits.startsWith('9')) {
    return toPersianDigits(
      `0${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`,
    );
  }

  return toPersianDigits(`0${digits.slice(0, 2)} ${digits.slice(2)}`);
}

/** Persian digits for any Latin-digit string (used by the formatters). */
export function toPersianDigits(input: string): string {
  let output = '';

  for (const character of input) {
    const index = character.charCodeAt(0) - 48;

    output +=
      character >= '0' && character <= '9' ? PERSIAN_DIGITS[index] : character;
  }

  return output;
}

/**
 * Masked form for logs and diagnostics: `+989121234567` → `+98912***4567`.
 *
 * Phone numbers are personal data; a general-purpose log line must not carry a usable number (§6).
 */
export function maskPhone(canonical: string): string {
  if (canonical.length < 8) {
    return '***';
  }

  const head = canonical.slice(0, 7);
  const tail = canonical.slice(-4);

  return `${head}***${tail}`;
}

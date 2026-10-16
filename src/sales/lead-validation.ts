/**
 * Phase 9 — input validation and normalization for the lead form (§5.1, §5.3, §5.4).
 *
 * Every value the customer types passes through this file before it can reach the domain layer, and
 * every rule is enforced **server-side** — the callback payloads only carry an index/identifier, so a
 * forged callback can never smuggle a category, a name or a note into a lead.
 *
 * The rules are intentionally Unicode-friendly (Persian, Arabic, Latin, ZWNJ, emoji are all fine) and
 * intentionally strict about everything else: control characters, markup, and unbounded lengths are
 * refused rather than stored.
 */

import {
  isProductCategory,
  ProductCategory,
  salesFail,
  SalesResult,
  salesOk,
} from './sales.types';

export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 120;
export const MAX_NOTES_LENGTH = 400;

/** Unicode-aware “is this a letter or a combining mark” test (no ASCII-only assumption). */
const LETTER_PATTERN = /[\p{L}\p{M}]/u;

/** Control characters (including NUL, DEL and C1) are never valid in customer input. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
      return true;
    }

    if (code >= 0x80 && code <= 0x9f) {
      return true;
    }
  }

  return false;
}

/**
 * Collapse whitespace (including newlines) into single spaces.
 *
 * Newlines are collapsed on purpose: an admin notification is one message, and a note that can break
 * a line is a formatting-injection vector in every chat platform.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Remove characters that could be interpreted as markup by a renderer.
 *
 * Output escaping is applied as well (defence in depth), but removing the characters means a note can
 * never *look* like markup even if a future renderer forgets to escape.
 */
function stripMarkupCharacters(value: string): string {
  return value.replace(/[<>]/gu, '');
}

function normalizeText(
  raw: string,
  options: { min: number; max: number; field: string },
): SalesResult<string> {
  const collapsed = stripMarkupCharacters(collapseWhitespace(raw));

  if (hasControlCharacter(collapsed)) {
    return salesFail(
      'INVALID_NAME',
      'متن واردشده نویسه‌های غیرمجاز دارد. لطفاً دوباره وارد کنید.',
    );
  }

  if (collapsed.length < options.min) {
    return salesFail(
      'INVALID_NAME',
      `${options.field} باید حداقل ${options.min} نویسه باشد.`,
    );
  }

  if (collapsed.length > options.max) {
    return salesFail(
      'INVALID_NAME',
      `${options.field} نباید بیشتر از ${options.max} نویسه باشد.`,
    );
  }

  return salesOk(collapsed);
}

/**
 * Full name (§5.1): trimmed, whitespace-collapsed, 2–80 characters, must contain at least two
 * letters — so `...` or `-----` cannot pass as a name.
 */
export function normalizeCustomerName(raw: string): SalesResult<string> {
  const result = normalizeText(raw, {
    min: MIN_NAME_LENGTH,
    max: MAX_NAME_LENGTH,
    field: 'نام و نام خانوادگی',
  });

  if (!result.ok) {
    return result;
  }

  const letters = [...result.value].filter((character) =>
    LETTER_PATTERN.test(character),
  );

  if (letters.length < MIN_NAME_LENGTH) {
    return salesFail(
      'INVALID_NAME',
      'نام واردشده معتبر نیست؛ لطفاً نام و نام خانوادگی واقعی خود را وارد کنید.',
    );
  }

  return result;
}

/** Optional product description (§3.3) — user-provided text, never an inventory identifier. */
export function normalizeProductDescription(
  raw: string,
): SalesResult<string | null> {
  const collapsed = stripMarkupCharacters(collapseWhitespace(raw));

  if (collapsed === '') {
    return salesOk(null);
  }

  if (hasControlCharacter(collapsed)) {
    return salesFail(
      'INVALID_DESCRIPTION',
      'متن واردشده نویسه‌های غیرمجاز دارد. لطفاً دوباره وارد کنید.',
    );
  }

  if (collapsed.length > MAX_DESCRIPTION_LENGTH) {
    return salesFail(
      'INVALID_DESCRIPTION',
      `توضیح محصول نباید بیشتر از ${MAX_DESCRIPTION_LENGTH} نویسه باشد.`,
    );
  }

  return salesOk(collapsed);
}

/** Optional notes (§5.4) — plain text, escaped at render time, bounded length. */
export function normalizeNotes(raw: string): SalesResult<string | null> {
  const collapsed = stripMarkupCharacters(collapseWhitespace(raw));

  if (collapsed === '') {
    return salesOk(null);
  }

  if (hasControlCharacter(collapsed)) {
    return salesFail(
      'INVALID_NOTE',
      'متن واردشده نویسه‌های غیرمجاز دارد. لطفاً دوباره وارد کنید.',
    );
  }

  if (collapsed.length > MAX_NOTES_LENGTH) {
    return salesFail(
      'INVALID_NOTE',
      `توضیحات نباید بیشتر از ${MAX_NOTES_LENGTH} نویسه باشد.`,
    );
  }

  return salesOk(collapsed);
}

/**
 * Category validation (§5.3).
 *
 * The value arriving from a callback is checked against the registry every single time: a callback
 * payload is untrusted input, not proof that the interface produced it.
 */
export function normalizeCategory(raw: string): SalesResult<ProductCategory> {
  // Category *identifiers* are stable and case-sensitive by contract, but a human (or a legacy
  // command) may type `coin`: the value is canonicalised before it is validated, and the stored lead
  // always carries the registry value.
  const candidate = raw.trim().toUpperCase();

  if (!isProductCategory(candidate)) {
    return salesFail(
      'INVALID_CATEGORY',
      'دستهٔ انتخابی معتبر نیست. لطفاً دوباره از فهرست دسته‌ها انتخاب کنید.',
    );
  }

  return salesOk(candidate);
}

/** Operator-entered free text (loss note / sale note): same rules as notes, never required. */
export function normalizeOperatorNote(raw: string): SalesResult<string | null> {
  const collapsed = stripMarkupCharacters(collapseWhitespace(raw));

  if (collapsed === '') {
    return salesOk(null);
  }

  if (hasControlCharacter(collapsed)) {
    return salesFail('INVALID_NOTE', 'متن واردشده نویسه‌های غیرمجاز دارد.');
  }

  if (collapsed.length > MAX_NOTES_LENGTH) {
    return salesFail(
      'INVALID_NOTE',
      `یادداشت نباید بیشتر از ${MAX_NOTES_LENGTH} نویسه باشد.`,
    );
  }

  return salesOk(collapsed);
}

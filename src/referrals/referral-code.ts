import { randomInt } from 'node:crypto';

/**
 * Phase 7 — referral codes and the referral start payload (§4).
 *
 * A referral code is an **attribution identifier, not a credential**:
 *  - it is random (never a database id, never derived from the platform identity),
 *  - it is stored once and never rotated automatically (stable for the lifetime of the account),
 *  - possessing it grants nothing: no admin access, no access to another user's data.
 */

/**
 * Code alphabet: lowercase letters and digits without the easily confused pairs `0/o`, `1/l/i`.
 * Restricting the alphabet keeps a code unambiguous when it is spoken, typed or copied by hand, and
 * it stays inside the Phase 6 start-payload syntax (`^[a-z0-9_-]{1,32}$`).
 */
export const REFERRAL_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Eight characters of a 31-symbol alphabet ≈ 8.5 × 10¹¹ combinations. */
export const REFERRAL_CODE_LENGTH = 8;

/** Prefix that makes a referral payload unambiguous inside `/start <payload>` (§5). */
export const REFERRAL_PAYLOAD_PREFIX = 'ref_';

/** Longest payload the platforms hand back to the bot (Phase 6 contract). */
export const MAX_START_PAYLOAD_LENGTH = 32;

export const REFERRAL_CODE_PATTERN = new RegExp(
  `^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`,
);

/**
 * Generate a fresh code with a cryptographically secure source (`crypto.randomInt`, uniform — no
 * modulo bias, unlike `randomBytes % alphabet.length`).
 */
export function generateReferralCode(): string {
  let code = '';

  for (let index = 0; index < REFERRAL_CODE_LENGTH; index += 1) {
    code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
  }

  return code;
}

/** Strict runtime guard: codes coming from the outside are never trusted. */
export function isReferralCode(value: unknown): value is string {
  return typeof value === 'string' && REFERRAL_CODE_PATTERN.test(value);
}

/** The `/start` payload of a code (`ref_<code>`), used to build referral links. */
export function referralPayloadFor(code: string): string {
  return `${REFERRAL_PAYLOAD_PREFIX}${code}`;
}

/**
 * Extract a code from a start payload token, or `null` when the token is not a referral payload.
 *
 * Rules: the token must start with the prefix, the remainder must be a well-formed code, and the whole
 * token must respect the platform payload length limit. Anything else is *not* a referral — the caller
 * (the Phase 6 parser) then decides whether it is one of the five routes or unknown.
 */
export function referralCodeFromPayload(raw: string): string | null {
  const token = raw.trim().toLowerCase();

  if (token.length === 0 || token.length > MAX_START_PAYLOAD_LENGTH) {
    return null;
  }

  if (!token.startsWith(REFERRAL_PAYLOAD_PREFIX)) {
    return null;
  }

  const code = token.slice(REFERRAL_PAYLOAD_PREFIX.length);

  return isReferralCode(code) ? code : null;
}

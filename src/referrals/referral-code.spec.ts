import {
  generateReferralCode,
  isReferralCode,
  referralCodeFromPayload,
  referralPayloadFor,
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  REFERRAL_PAYLOAD_PREFIX,
} from './referral-code';
import { BotDestinationService } from '../bot/destination.service';
import { createAppConfigService } from '../testing/test-doubles';
import { parseStartPayload } from '../bot/deep-link';

/**
 * Phase 7 §4.1 — referral codes: unique, stable, securely random, never an internal identifier.
 *
 * The code is treated as data, not as a credential: these tests pin the *shape* and the randomness,
 * and prove that a code never reveals a user id and never collides.
 */

describe('referral code generation (§4.1)', () => {
  it('uses the documented alphabet and length (no ambiguous characters)', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateReferralCode();

      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(isReferralCode(code)).toBe(true);

      for (const character of code) {
        expect(REFERRAL_CODE_ALPHABET).toContain(character);
      }

      // The characters that get mis-read when a code is dictated over the phone are excluded.
      expect(code).not.toMatch(/[0o1li]/);
    }
  });

  it('never repeats itself over a realistic volume (collision safety at generation level)', () => {
    const codes = new Set<string>();

    for (let index = 0; index < 5_000; index += 1) {
      codes.add(generateReferralCode());
    }

    expect(codes.size).toBe(5_000);
  });

  it('is not derived from a sequence, a user id or a timestamp', () => {
    const codes = Array.from({ length: 50 }, () => generateReferralCode());
    const sorted = [...codes].sort();

    // Two consecutive generations are unrelated (a sequential identifier would look ordered here).
    expect(sorted).not.toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => !/^\d+$/.test(code))).toBe(true);
  });
});

describe('referral code validation and payload syntax (§4.1, §4.2)', () => {
  it('accepts only well-formed codes (case, length, alphabet)', () => {
    const valid = generateReferralCode();

    expect(isReferralCode(valid)).toBe(true);
    expect(isReferralCode(valid.toUpperCase())).toBe(false); // the canonical form is lowercase
    expect(isReferralCode(valid.slice(0, -1))).toBe(false); // too short
    expect(isReferralCode(`${valid}a`)).toBe(false); // too long
    expect(isReferralCode('o0l1i2ab3')).toBe(false); // excluded characters
    expect(isReferralCode('ref_' + valid)).toBe(false); // the prefix is not part of the code
  });

  it('rejects every non-string input instead of coercing it', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(isReferralCode(value)).toBe(false);
    }
  });

  it('builds the documented payload (`ref_<code>`)', () => {
    const code = 'abc234xy';

    expect(referralPayloadFor(code)).toBe(`${REFERRAL_PAYLOAD_PREFIX}${code}`);
    expect(referralCodeFromPayload(referralPayloadFor(code))).toBe(code);
  });

  it('extracts a code only from a referral payload, never from another token', () => {
    const code = generateReferralCode();

    expect(referralCodeFromPayload(`ref_${code}`)).toBe(code);
    expect(referralCodeFromPayload(`REF_${code.toUpperCase()}`)).toBe(code); // normalized, like routes
    expect(referralCodeFromPayload(`gold`)).toBeNull();
    expect(referralCodeFromPayload(`ref_`)).toBeNull();
    expect(referralCodeFromPayload(`ref_${code}x`)).toBeNull(); // over-long token
    expect(referralCodeFromPayload(`prefix_${code}`)).toBeNull();
    expect(referralCodeFromPayload(`ref_${'a'.repeat(40)}`)).toBeNull();
  });

  it('stays inside the payload contract the Phase 6 parser enforces', () => {
    const code = generateReferralCode();
    const payload = referralPayloadFor(code);

    expect(payload.length).toBeLessThanOrEqual(32);
    expect(parseStartPayload(`/start ${payload}`)).toEqual({
      kind: 'referral',
      code,
      raw: payload,
    });
  });

  it('never builds a referral link that contains an internal identifier', () => {
    const code = generateReferralCode();
    const links = new BotDestinationService(
      createAppConfigService({
        BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
        TELEGRAM_REFERRAL_BOT_USERNAME: 'atabak_bot',
      }),
    );
    const url = links.referralLink('bale', code);

    expect(url).toBe(`https://ble.ir/atabak_bot?start=ref_${code}`);
    expect(url).not.toContain('usr_');
  });

  it('uses the platform-appropriate host and the documented payload form on both platforms', () => {
    const links = new BotDestinationService(
      createAppConfigService({
        BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
        TELEGRAM_REFERRAL_BOT_USERNAME: 'atabak_tg_bot',
      }),
    );
    const code = 'abcd2345';

    // Bale: `ble.ir/<bot_username>?start=<parameter>` — the same mechanic Phase 6 already uses.
    expect(links.referralLink('bale', code)).toBe(
      `https://ble.ir/atabak_bot?start=ref_${code}`,
    );
    expect(links.referralLink('telegram', code)).toBe(
      `https://t.me/atabak_tg_bot?start=ref_${code}`,
    );
  });

  it('falls back to "no link" instead of a fabricated address when nothing is configured', () => {
    const links = new BotDestinationService(createAppConfigService({}));

    expect(links.referralLink('bale', 'abcd2345')).toBeNull();
    expect(links.referralLink('telegram', 'abcd2345')).toBeNull();
  });

  it('rejects an invalid referral username rather than emitting a broken link', () => {
    const links = new BotDestinationService(
      createAppConfigService({ BALE_REFERRAL_BOT_USERNAME: 'not a username' }),
    );

    expect(links.referralBotUsername('bale')).toBeNull();
    expect(links.referralLink('bale', 'abcd2345')).toBeNull();
  });
});

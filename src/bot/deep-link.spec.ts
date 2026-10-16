import {
  BotRoute,
  isBotRoute,
  MAX_START_PAYLOAD_LENGTH,
  parseStartPayload,
  screenForRoute,
} from './deep-link';
import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import { BotDestinationService } from './destination.service';

/**
 * Phase 6 — deep links and destination links (§6, §7).
 *
 * Two things are protected here:
 *  1. the *parser*: only the approved payloads are recognized, everything else stays neutral and can
 *     never execute a different feature;
 *  2. the *URL builder*: a link is either correct for the platform or `null` — never a guessed,
 *     placeholder or Telegram-shaped address on Bale.
 */

const configWith = (env: EnvMap = {}) => createAppConfigService(env);
const destinations = (env: EnvMap = {}) =>
  new BotDestinationService(configWith(env));

describe('start payload parser (§6.2)', () => {
  it('treats a bare /start (and /start without an argument) as the normal entry point', () => {
    expect(parseStartPayload('/start')).toEqual({ kind: 'none' });
    expect(parseStartPayload('/start   ')).toEqual({ kind: 'none' });
    expect(parseStartPayload(null)).toEqual({ kind: 'none' });
    expect(parseStartPayload('')).toEqual({ kind: 'none' });
    expect(parseStartPayload(undefined)).toEqual({ kind: 'none' });
  });

  it('accepts the bot-qualified command form (`/start@bot`) the platforms send in groups', () => {
    expect(parseStartPayload('/start@atabak_bot prices')).toEqual({
      kind: 'route',
      route: 'prices',
      raw: 'prices',
    });
  });

  it.each<BotRoute>(['alert', 'prices', 'coin', 'gold', 'channel'])(
    'recognizes the approved route "%s"',
    (route) => {
      expect(parseStartPayload(`/start ${route}`)).toEqual({
        kind: 'route',
        route,
        raw: route,
      });
    },
  );

  it('normalizes the case of the payload (an upper-cased link still works)', () => {
    expect(parseStartPayload('/start GOLD')).toEqual({
      kind: 'route',
      route: 'gold',
      raw: 'GOLD',
    });
  });

  it('reads only the first payload token and ignores everything after it', () => {
    expect(parseStartPayload('/start prices extra')).toEqual({
      kind: 'route',
      route: 'prices',
      raw: 'prices',
    });
    // A second token is never a second route and never a permission.
    expect(parseStartPayload('/start gold alert')).toMatchObject({
      route: 'gold',
    });
  });

  it('keeps unknown payloads neutral (no route, no crash, raw value preserved for logging)', () => {
    expect(parseStartPayload('/start unknown_thing')).toEqual({
      kind: 'unknown',
      raw: 'unknown_thing',
    });
    expect(parseStartPayload('/start admin')).toEqual({
      kind: 'unknown',
      raw: 'admin',
    });
  });

  it('rejects hostile payload shapes before they reach the routing decision', () => {
    const hostile = [
      '/start ../../etc/passwd',
      '/start <script>alert(1)</script>',
      '/start GOLD;DROP',
      "/start ' OR 1=1",
      `/start ${'a'.repeat(MAX_START_PAYLOAD_LENGTH + 1)}`,
      '/start ref_',
      '/start ref_bad!',
      '/start ',
    ];

    for (const text of hostile) {
      const payload = parseStartPayload(text);
      expect(['unknown', 'none']).toContain(payload.kind);
    }
  });

  it('accepts a payload at the length bound and refuses anything longer', () => {
    const atBound = 'a'.repeat(MAX_START_PAYLOAD_LENGTH);
    const overBound = 'a'.repeat(MAX_START_PAYLOAD_LENGTH + 1);

    // A payload exactly at the bound is still parsed (an unknown payload here, never a route).
    expect(parseStartPayload(`/start ${atBound}`)).toEqual({
      kind: 'unknown',
      raw: atBound,
    });
    // One character more is outside what the platforms carry: it is never a route and never a code.
    expect(parseStartPayload(`/start ${overBound}`).kind).toBe('unknown');
    expect(parseStartPayload(`/start ref_${overBound}`).kind).toBe('unknown');
  });

  it('is deterministic: the same input always yields the same decision', () => {
    const inputs = [
      '/start',
      '/start gold',
      '/start ref_abcdefgh',
      '/start ref_',
      '/start nope',
      null,
    ];

    for (const text of inputs) {
      expect(parseStartPayload(text)).toEqual(parseStartPayload(text));
    }
  });

  it('maps every route to an existing screen, and `alert` to the wizard (no screen)', () => {
    expect(screenForRoute('prices')).toBe('prices');
    expect(screenForRoute('coin')).toBe('coins');
    expect(screenForRoute('gold')).toBe('gold');
    expect(screenForRoute('channel')).toBe('channel');
    expect(screenForRoute('alert')).toBeNull();
  });

  it('exposes a closed route registry (nothing else is a route)', () => {
    expect(isBotRoute('prices')).toBe(true);
    expect(isBotRoute('report')).toBe(false);
    expect(isBotRoute('golden')).toBe(false);
    expect(isBotRoute(42)).toBe(false);
    expect(isBotRoute(undefined)).toBe(false);
  });
});

describe('destination links (§7)', () => {
  const twoPlatforms: EnvMap = {
    BALE_BOT_USERNAME: 'atabak_bot',
    TELEGRAM_BOT_USERNAME: 'atabak_bot_tg',
  };

  it('builds the platform-appropriate deep link for every route', () => {
    const links = destinations(twoPlatforms);

    expect(links.deepLink('bale', 'gold')).toBe(
      'https://ble.ir/atabak_bot?start=gold',
    );
    expect(links.deepLink('telegram', 'gold')).toBe(
      'https://t.me/atabak_bot_tg?start=gold',
    );
  });

  it('never builds a Telegram-shaped link for Bale (the documented Bale host is used)', () => {
    const links = destinations({ BALE_BOT_USERNAME: 'atabak_bot' });
    const bale = links.deepLink('bale', 'prices');

    expect(bale).not.toBeNull();
    expect(bale).toContain('ble.ir/atabak_bot');
    expect(bale).not.toContain('t.me');
  });

  it('returns null instead of a fabricated link when no username is configured', () => {
    const links = destinations({});

    expect(links.deepLink('bale', 'gold')).toBeNull();
    expect(links.deepLink('telegram', 'gold')).toBeNull();
    expect(
      links.ctaKeyboard('bale', { route: 'gold', labelFa: 'طلا' }),
    ).toBeNull();
  });

  it('strips a leading @ and rejects usernames that are not valid usernames', () => {
    expect(
      destinations({ BALE_BOT_USERNAME: '@atabak_bot' }).deepLink(
        'bale',
        'gold',
      ),
    ).toBe('https://ble.ir/atabak_bot?start=gold');
    expect(
      destinations({ BALE_BOT_USERNAME: 'ab' }).deepLink('bale', 'gold'),
    ).toBeNull();
    expect(
      destinations({ BALE_BOT_USERNAME: 'bad name' }).deepLink('bale', 'gold'),
    ).toBeNull();
  });

  it('keeps the bot token out of every generated URL', () => {
    const links = destinations(twoPlatforms);
    const urls = (['bale', 'telegram'] as const).flatMap((platform) =>
      (['alert', 'prices', 'coin', 'gold', 'channel'] as BotRoute[]).map(
        (route) => links.deepLink(platform, route),
      ),
    );

    for (const url of urls) {
      expect(url).not.toBeNull();
      // A Bot API token is `<digits>:<secret>`; it must never appear in a public link.
      expect(url).not.toContain('token');
      expect(url).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
      // ...and `:` only ever appears in the scheme, never as part of a token.
      expect((url ?? '').split(':').length - 1).toBe(1);
      expect(url).toMatch(
        /^https:\/\/(ble\.ir|t\.me)\/[A-Za-z0-9_]+\?start=[a-z]+$/,
      );
    }
  });

  it('uses the configured channel destination per platform and omits it when absent', () => {
    const links = destinations({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      TELEGRAM_CHANNEL_URL: 'https://t.me/tala_atabak',
    });

    expect(links.channelUrl('bale')).toBe('https://ble.ir/tala_atabak');
    expect(links.channelUrl('telegram')).toBe('https://t.me/tala_atabak');
    expect(links.channelInviteRow('bale')).toEqual([
      [{ text: '📢 دیدن تحلیل در کانال', url: 'https://ble.ir/tala_atabak' }],
    ]);
  });

  it('omits the channel invitation entirely when the invitation is switched off', () => {
    const links = destinations({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      BOT_CHANNEL_INVITE_ENABLED: 'false',
    });

    expect(links.channelInviteRow('bale')).toBeNull();
  });

  it('builds a CTA button only when both the route and the destination exist', () => {
    const links = destinations(twoPlatforms);

    expect(
      links.ctaKeyboard('bale', { route: 'alert', labelFa: 'هشدار قیمت' }),
    ).toEqual([
      [{ text: 'هشدار قیمت', url: 'https://ble.ir/atabak_bot?start=alert' }],
    ]);

    // The dedicated switch wins over a perfectly valid destination.
    const disabled = destinations({
      ...twoPlatforms,
      CHANNEL_CTA_ENABLED: 'false',
    });
    expect(
      disabled.ctaKeyboard('bale', { route: 'alert', labelFa: 'هشدار' }),
    ).toBeNull();
  });

  it('documents the platform capabilities it relies on (no invented capability)', () => {
    const links = destinations(twoPlatforms);

    expect(links.linkCapabilities('bale')).toEqual({
      deepLinks: true,
      urlButtons: true,
    });
    expect(links.linkCapabilities('telegram')).toEqual({
      deepLinks: true,
      urlButtons: true,
    });
  });
});

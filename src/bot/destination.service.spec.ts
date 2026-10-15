import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import { BotDestinationService } from './destination.service';
import { BotRoute } from './deep-link';

/**
 * §13.4 / §13.7 — URL construction, per platform, independently.
 *
 * Telegram and Bale are verified as two separate platforms: each one's host, each one's configuration
 * key, and each one's missing-config behaviour. No network, and no fabricated URL anywhere: a
 * destination that is not configured must produce `null`, not a placeholder.
 */

const build = (env: EnvMap = {}): BotDestinationService =>
  new BotDestinationService(createAppConfigService(env));

describe('bot destinations (§7, §8)', () => {
  it('builds each platform deep link with that platform’s documented host', () => {
    const service = build({
      BALE_BOT_USERNAME: 'atabak_bot',
      TELEGRAM_BOT_USERNAME: 'atabak_bot',
    });

    expect(service.deepLink('bale', 'alert')).toBe(
      'https://ble.ir/atabak_bot?start=alert',
    );
    expect(service.deepLink('telegram', 'alert')).toBe(
      'https://t.me/atabak_bot?start=alert',
    );
  });

  it('builds every approved route (encoding the payload part properly)', () => {
    const service = build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });
    const routes: BotRoute[] = ['alert', 'prices', 'coin', 'gold', 'channel'];

    for (const route of routes) {
      expect(service.deepLink('telegram', route)).toBe(
        `https://t.me/atabak_bot?start=${encodeURIComponent(route)}`,
      );
    }
  });

  it('accepts a username written with a leading @ and still produces a valid link', () => {
    const service = build({ BALE_BOT_USERNAME: '@atabak_bot' });

    expect(service.botUsername('bale')).toBe('atabak_bot');
    expect(service.deepLink('bale', 'gold')).toBe(
      'https://ble.ir/atabak_bot?start=gold',
    );
  });

  it('returns null — never a placeholder — when a platform has no bot username', () => {
    const service = build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });

    expect(service.botUsername('bale')).toBeNull();
    expect(service.deepLink('bale', 'prices')).toBeNull();
    // The other platform keeps working: capabilities are verified independently.
    expect(service.deepLink('telegram', 'prices')).toBe(
      'https://t.me/atabak_bot?start=prices',
    );
  });

  it('never contains a token, a chat id or any secret in a link', () => {
    const service = build({
      BALE_BOT_USERNAME: 'atabak_bot',
      BALE_BOT_TOKEN: '123456789:SUPERSECRETTOKEN',
      TELEGRAM_BOT_USERNAME: 'atabak_bot',
      TELEGRAM_BOT_TOKEN: '987654321:OTHERSECRET',
    });

    const links = [
      service.deepLink('bale', 'alert'),
      service.deepLink('telegram', 'alert'),
    ].filter((link): link is string => link !== null);

    expect(links).toHaveLength(2);

    for (const link of links) {
      expect(link).not.toContain('SUPERSECRET');
      expect(link).not.toContain('OTHERSECRET');
      expect(link).not.toContain('123456789');
      expect(link).not.toContain('987654321');
      expect(link).not.toMatch(/bot\d+:/);
    }
  });

  it('reports the platform capabilities as code, not as an assumption', () => {
    const service = build({});

    expect(service.linkCapabilities('bale')).toEqual({
      deepLinks: true,
      urlButtons: true,
    });
    expect(service.linkCapabilities('telegram')).toEqual({
      deepLinks: true,
      urlButtons: true,
    });
  });

  it('resolves the channel destination per platform from its own configured key', () => {
    const service = build({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      TELEGRAM_CHANNEL_URL: 'https://t.me/tala_atabak',
    });

    expect(service.channelUrl('bale')).toBe('https://ble.ir/tala_atabak');
    expect(service.channelUrl('telegram')).toBe('https://t.me/tala_atabak');
  });

  it('returns null for a channel that is not configured on that platform', () => {
    const service = build({ CHANNEL_URL: 'https://ble.ir/tala_atabak' });

    expect(service.channelUrl('bale')).toBe('https://ble.ir/tala_atabak');
    expect(service.channelUrl('telegram')).toBeNull();
  });

  it('builds a CTA keyboard describing the real destination', () => {
    const service = build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });

    const keyboard = service.ctaKeyboard('telegram', {
      route: 'gold',
      labelFa: '🟡 مشاهده قیمت طلا',
    });

    expect(keyboard).toEqual([
      [
        {
          text: '🟡 مشاهده قیمت طلا',
          url: 'https://t.me/atabak_bot?start=gold',
        },
      ],
    ]);
  });

  it('omits the CTA keyboard entirely when the platform bot username is missing', () => {
    const service = build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });

    expect(
      service.ctaKeyboard('bale', {
        route: 'gold',
        labelFa: '🟡 مشاهده قیمت طلا',
      }),
    ).toBeNull();
  });

  it('omits every CTA keyboard when channel CTAs are switched off', () => {
    const service = build({
      BALE_BOT_USERNAME: 'atabak_bot',
      TELEGRAM_BOT_USERNAME: 'atabak_bot',
      CHANNEL_CTA_ENABLED: 'false',
    });

    expect(
      service.ctaKeyboard('bale', { route: 'alert', labelFa: 'x' }),
    ).toBeNull();
    expect(
      service.ctaKeyboard('telegram', { route: 'alert', labelFa: 'x' }),
    ).toBeNull();
  });

  it('builds the channel invitation row per platform, and omits it when disabled', () => {
    const enabled = build({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      TELEGRAM_CHANNEL_URL: 'https://t.me/tala_atabak',
    });

    expect(enabled.channelInviteRow('bale')).toEqual([
      [{ text: '📢 دیدن تحلیل در کانال', url: 'https://ble.ir/tala_atabak' }],
    ]);
    expect(enabled.channelInviteRow('telegram')).toEqual([
      [{ text: '📢 دیدن تحلیل در کانال', url: 'https://t.me/tala_atabak' }],
    ]);

    const disabled = build({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      BOT_CHANNEL_INVITE_ENABLED: 'false',
    });

    expect(disabled.channelInviteRow('bale')).toBeNull();
  });

  it('is deterministic and free of side effects', () => {
    const service = build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });
    const first = service.deepLink('telegram', 'coin');

    expect(service.deepLink('telegram', 'coin')).toBe(first);
    expect(service.deepLink('telegram', 'coin')).toBe(first);
  });
});

import { Logger } from '@nestjs/common';

import {
  ChannelHarness,
  createChannelHarness,
  createIntelligenceStub,
  EnvMap,
  makeSnapshot,
  PlatformCall,
} from '../testing/test-doubles';
import { PublishableMarketUpdate } from '../market/market.types';
import { BotDestinationService } from '../bot/destination.service';
import {
  ChannelDestination,
  ChannelPublisher,
} from './channel-publisher.service';
import { PublicationPayload } from './channel.types';

/**
 * §13.4 / §13.7 — Channel → Bot CTA delivery, verified **per platform, independently**.
 *
 * The keyboard is asserted at the wire level (the reply markup the platform would receive), never by
 * inspecting internals. Both platforms are exercised with their own configuration keys, and the two
 * "must never happen" cases are covered as well: no button without a configured destination, and no
 * button when the feature or the item says no. No network: the platform client is a double.
 */

const baleDestination: ChannelDestination = {
  platform: 'bale',
  destination: 'bale-channel',
};

const telegramDestination: ChannelDestination = {
  platform: 'telegram',
  destination: 'telegram-channel',
};

const bothUsernames = {
  BALE_BOT_USERNAME: 'atabak_bot',
  TELEGRAM_BOT_USERNAME: 'atabak_bot',
};

const payload = (
  overrides: Partial<PublicationPayload> = {},
): PublicationPayload => ({
  publicationId: 'pub_cta_1',
  messageType: 'PRICE_UPDATE',
  text: 'قیمت لحظهای',
  parseMode: 'HTML',
  cta: { route: 'gold', labelFa: '🟡 مشاهده قیمت طلا' },
  media: null,
  destinationKey: 'bale',
  meta: {
    reportingDate: '2026-10-16',
    symbols: ['IR_GOLD_18K'],
    variant: null,
    contentRevision: 1,
  },
  ...overrides,
});

describe('channel → bot CTA delivery (§4.1, §13.4)', () => {
  let harness: ChannelHarness;
  let publisher: ChannelPublisher;
  let platform: ChannelHarness['platform'];

  const build = (env: EnvMap = {}): void => {
    harness = createChannelHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
    platform = harness.platform;
    publisher = harness.publisher;
  };

  const publishes = (): PlatformCall[] =>
    platform.calls.filter((call) => call.kind === 'publish');

  /** The url buttons of a publication (wire level — exactly what a platform would receive). */
  const buttonsOf = (call: PlatformCall): { text: string; url?: string }[] =>
    (call.markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => ({ text: button.text, url: button.url }));

  const firstButtons = (): { text: string; url?: string }[] =>
    buttonsOf(publishes()[0]);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('carries the Bale deep link on a Bale publication', async () => {
    build({ ...bothUsernames, CHANNEL_URL: 'https://ble.ir/tala_atabak' });

    const outcome = await publisher.publish(baleDestination, payload());

    expect(outcome.status).toBe('SENT');
    expect(outcome.ctaRoute).toBe('gold');
    expect(firstButtons()).toEqual([
      {
        text: '🟡 مشاهده قیمت طلا',
        url: 'https://ble.ir/atabak_bot?start=gold',
      },
    ]);
  });

  it('carries the Telegram deep link on a Telegram publication', async () => {
    build({
      ...bothUsernames,
      TELEGRAM_CHANNEL_URL: 'https://t.me/tala_atabak',
    });

    const outcome = await publisher.publish(telegramDestination, payload());

    expect(outcome.status).toBe('SENT');
    expect(outcome.ctaRoute).toBe('gold');
    expect(firstButtons()).toEqual([
      { text: '🟡 مشاهده قیمت طلا', url: 'https://t.me/atabak_bot?start=gold' },
    ]);
  });

  it('uses each platform’s own bot username, not a shared one', async () => {
    build({
      BALE_BOT_USERNAME: 'atabak_bale',
      TELEGRAM_BOT_USERNAME: 'atabak_telegram',
    });

    await publisher.publish(baleDestination, payload());
    await publisher.publish(telegramDestination, payload());

    const [baleCall, telegramCall] = publishes();

    expect(buttonsOf(baleCall)[0].url).toBe(
      'https://ble.ir/atabak_bale?start=gold',
    );
    expect(buttonsOf(telegramCall)[0].url).toBe(
      'https://t.me/atabak_telegram?start=gold',
    );
  });

  it('publishes without a button — never with a broken one — when that platform has no bot username', async () => {
    build({ TELEGRAM_BOT_USERNAME: 'atabak_bot' });

    const outcome = await publisher.publish(baleDestination, payload());

    // The post still goes out: a missing CTA must never block distribution.
    expect(outcome.status).toBe('SENT');
    expect(outcome.ctaRoute).toBeNull();
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0].markup ?? null).toBeNull();
    expect(JSON.stringify(publishes()[0].text)).not.toContain('ble.ir');
    expect(JSON.stringify(publishes()[0].text)).not.toContain('http');
  });

  it('omits the button when the publication itself has no CTA (policy decided not to)', async () => {
    build(bothUsernames);

    const outcome = await publisher.publish(
      baleDestination,
      payload({ cta: null, messageType: 'EDUCATIONAL' }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.ctaRoute).toBeNull();
    expect(publishes()[0].markup ?? null).toBeNull();
  });

  it('omits the button when the feature is switched off, even if the payload carries a CTA', async () => {
    build({ ...bothUsernames, CHANNEL_CTA_ENABLED: 'false' });

    const outcome = await publisher.publish(baleDestination, payload());

    expect(outcome.status).toBe('SENT');
    expect(outcome.ctaRoute).toBeNull();
    expect(publishes()[0].markup ?? null).toBeNull();
  });

  it('never leaks a token into the button url or the label', async () => {
    build({
      ...bothUsernames,
      BALE_BOT_TOKEN: '111111:SECRET-BALE',
      TELEGRAM_BOT_TOKEN: '222222:SECRET-TG',
    });

    await publisher.publish(
      baleDestination,
      payload({ cta: { route: 'alert', labelFa: '🔔 فعالسازی هشدار قیمت' } }),
    );

    const buttons = firstButtons();
    const serialized = JSON.stringify(publishes()[0]);
    const raw = JSON.stringify(publishes()[0].markup ?? {});

    expect(buttons[0].url).toBe('https://ble.ir/atabak_bot?start=alert');
    expect(serialized).not.toContain('SECRET-BALE');
    expect(serialized).not.toContain('SECRET-TG');
    expect(raw).not.toMatch(/bot\d+:/);
  });

  it('puts the button on the caption message when the text travels as a caption', async () => {
    build({ ...bothUsernames, CHANNEL_MEDIA_CAPTION_LIMIT: '1000' });

    const outcome = await publisher.publish(
      baleDestination,
      payload({ media: { url: 'https://cdn.example.test/a.png' } }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('SENT');
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0].media).toBe('https://cdn.example.test/a.png');
    expect(firstButtons()).toEqual([
      {
        text: '🟡 مشاهده قیمت طلا',
        url: 'https://ble.ir/atabak_bot?start=gold',
      },
    ]);
  });

  it('puts the button on the separate text message when the caption limit splits the publication', async () => {
    build({ ...bothUsernames, CHANNEL_MEDIA_CAPTION_LIMIT: '10' });

    const outcome = await publisher.publish(
      baleDestination,
      payload({
        text: 'متن طولانی‌تر از محدودیت کپشن',
        media: { url: 'https://cdn.example.test/b.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(publishes()).toHaveLength(2);

    const [textCall, mediaCall] = publishes();

    // The text message is the primary message and carries the button…
    expect(buttonsOf(textCall)[0].url).toBe(
      'https://ble.ir/atabak_bot?start=gold',
    );
    expect(textCall.media ?? null).toBeNull();
    // …and it is never duplicated onto the media message.
    expect(mediaCall.media).toBe('https://cdn.example.test/b.png');
    expect(mediaCall.markup ?? null).toBeNull();
  });

  it('reports the CTA as not delivered when the publication failed', async () => {
    build(bothUsernames);
    platform.failPublish('RETRYABLE', 1);

    const outcome = await publisher.publish(baleDestination, payload());

    expect(outcome.status).toBe('FAILED');
    expect(outcome.ctaRoute).toBeNull();
  });

  it('still delivers the text (and its CTA) when only the media failed', async () => {
    build({ ...bothUsernames, CHANNEL_MEDIA_CAPTION_LIMIT: '10' });
    platform.failMedia('RETRYABLE', 1);

    const outcome = await publisher.publish(
      baleDestination,
      payload({
        text: 'متن طولانی‌تر از محدودیت کپشن',
        media: { url: 'https://cdn.example.test/c.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('FAILED');
    expect(outcome.ctaRoute).toBe('gold');

    const withButton = publishes().filter(
      (call) => (call.markup?.inline_keyboard.length ?? 0) > 0,
    );

    expect(withButton).toHaveLength(1);
  });

  it('builds the same CTA decision for two equal publications (deterministic)', async () => {
    build(bothUsernames);

    const first = await publisher.publish(baleDestination, payload());
    const second = await publisher.publish(baleDestination, payload());

    expect(second.ctaRoute).toBe(first.ctaRoute);
    expect(publishes()[0].markup).toEqual(publishes()[1].markup);
  });

  it('is the same builder the engine uses (no second URL construction path)', () => {
    const service = new BotDestinationService(harness.config);

    expect(service.deepLink('bale', 'gold')).toBe(
      'https://ble.ir/atabak_bot?start=gold',
    );
  });
});

describe('channel → bot CTA through the engine (§13.9)', () => {
  const update = (symbol: string): PublishableMarketUpdate =>
    ({
      publishable: true,
      dayKey: '2026-10-16',
      accepted: [],
      rejected: [],
      prices: [
        {
          symbol,
          label: 'نماد',
          unit: 'RIAL',
          section: 'gold',
          price: 17_500_000,
          previousPrice: 17_100_000,
          change: 400_000,
          changePercent: 2.34,
          direction: 'UP',
        },
      ],
    }) as unknown as PublishableMarketUpdate;

  /** Deterministic Phase 4 projection, exactly like the engine spec: no Phase 1 dependency. */
  const snapshot = () =>
    makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        currentPrice: 17_500_000,
        previousPrice: 17_100_000,
        open: 17_000_000,
        high: 17_600_000,
        low: 16_950_000,
      },
      {
        symbol: 'IR_COIN_EMAMI',
        label: 'سکه امامی',
        currentPrice: 96_000_000,
        previousPrice: 95_000_000,
        open: 95_500_000,
        high: 96_500_000,
        low: 95_000_000,
      },
    ]);

  const harnessFor = (env: EnvMap = {}): ChannelHarness =>
    createChannelHarness(
      { ...env, BOT_POLLING_ENABLED: 'false' },
      { intelligence: createIntelligenceStub(snapshot()) },
    );

  const at = new Date('2026-10-16T08:00:00.000Z');

  const deliveriesOf = (harness: ChannelHarness, jobId: string) =>
    harness.store.listDeliveries(jobId);

  it('records the delivered CTA route on the delivery record', async () => {
    const harness = harnessFor({ BALE_BOT_USERNAME: 'atabak_bot' });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const outcome = await harness.engine.publishPriceUpdate(
      update('IR_GOLD_18K'),
      'full',
      at,
    );

    jest.restoreAllMocks();

    expect(outcome.status).toBe('PUBLISHED');

    const deliveries = deliveriesOf(harness, outcome.jobId);
    const delivered = deliveries.filter(
      (delivery) => delivery.status === 'SENT',
    );

    expect(delivered).toHaveLength(1);
    // The record states what actually went out: a gold-only price post links to the gold screen.
    expect(delivered[0].ctaRoute).toBe('gold');

    const publishCall = harness
      .publishes()
      .find((call) => call.platform === 'bale');
    const serialized = JSON.stringify(publishCall?.markup ?? {});

    expect(serialized).toContain('https://ble.ir/atabak_bot?start=gold');
  });

  it('records `null` when no button could be built for that platform', async () => {
    const harness = harnessFor({});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const outcome = await harness.engine.publishPriceUpdate(
      update('IR_GOLD_18K'),
      'full',
      at,
    );

    jest.restoreAllMocks();

    const deliveries = deliveriesOf(harness, outcome.jobId);

    expect(
      deliveries.filter((delivery) => delivery.status === 'SENT'),
    ).toHaveLength(1);
    expect(deliveries[0].ctaRoute).toBeNull();
    expect(
      harness.publishes().every((call) => (call.markup ?? null) === null),
    ).toBe(true);
  });

  it('never attaches the alert CTA to a routine price update', async () => {
    const harness = harnessFor({ BALE_BOT_USERNAME: 'atabak_bot' });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const outcomes = await Promise.all([
      harness.engine.publishPriceUpdate(update('IR_GOLD_18K'), 'full', at),
      harness.engine.publishPriceUpdate(update('IR_COIN_EMAMI'), 'full', at),
    ]);

    jest.restoreAllMocks();

    for (const outcome of outcomes) {
      const serialized = JSON.stringify(deliveriesOf(harness, outcome.jobId));

      expect(serialized).not.toContain('start=alert');
    }
  });
});

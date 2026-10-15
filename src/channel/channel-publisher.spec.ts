import { Logger } from '@nestjs/common';

import {
  createAppConfigService,
  createPlatformHarness,
  PlatformHarness,
  PlatformCall,
} from '../testing/test-doubles';
import { BotApiClient } from '../platform/bot-api.client';
import { BotDestinationService } from '../bot/destination.service';
import {
  ChannelDestination,
  ChannelPublisher,
} from './channel-publisher.service';
import { PublicationPayload } from './channel.types';

/**
 * §27.2 (delivery) — the channel publisher is the only place that talks to a destination.
 *
 * It must: keep the text delivery result separate from the media result, classify failures
 * (retryable / permanent / ambiguous), never report an unanswered call as success, and respect the
 * platform caption limit. No network: the platform client is a double.
 */

const destination: ChannelDestination = {
  platform: 'bale',
  destination: 'bale-channel',
};

const payload = (
  overrides: Partial<PublicationPayload> = {},
): PublicationPayload => ({
  publicationId: 'pub_test_1',
  messageType: 'EDUCATIONAL',
  text: 'متن کوتاه',
  parseMode: 'HTML',
  cta: null,
  media: null,
  destinationKey: 'bale',
  meta: {
    reportingDate: '2026-09-30',
    symbols: [],
    variant: null,
    contentRevision: 1,
  },
  ...overrides,
});

describe('channel publisher (§27.2)', () => {
  let platform: PlatformHarness;
  let publisher: ChannelPublisher;

  const build = (env: Record<string, string> = {}): void => {
    platform = createPlatformHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
    const config = createAppConfigService(env);

    publisher = new ChannelPublisher(
      config,
      platform.client as unknown as BotApiClient,
      new BotDestinationService(config),
    );
  };

  const publishes = (): PlatformCall[] =>
    platform.calls.filter((call) => call.kind === 'publish');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a text-only message when the payload carries no media', async () => {
    build();

    const outcome = await publisher.publish(destination, payload());

    expect(outcome).toMatchObject({
      platform: 'bale',
      destination: 'bale-channel',
      status: 'SENT',
      mediaStatus: 'NOT_ATTACHED',
      mediaMessageId: null,
      failureKind: null,
    });
    expect(outcome.messageId).not.toBeNull();
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0].media).toBeNull();
  });

  it('classifies a retryable failure', async () => {
    build();
    platform.failPublish('RETRYABLE', 1);

    const outcome = await publisher.publish(destination, payload());

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureKind).toBe('RETRYABLE');
    expect(outcome.messageId).toBeNull();
  });

  it('never reports an unanswered call as success', async () => {
    build();
    platform.failPublish('AMBIGUOUS', 1);

    const outcome = await publisher.publish(destination, payload());

    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.failureKind).toBe('AMBIGUOUS');
    expect(outcome.error).toContain('timeout');
  });

  it('uses the text as the photo caption when it fits the caption limit', async () => {
    build({ CHANNEL_MEDIA_CAPTION_LIMIT: '1000' });

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'متن کوتاه',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('SENT');
    expect(outcome.mediaMessageId).toEqual(outcome.messageId);
    const calls = publishes();
    expect(calls).toHaveLength(1);
    expect(calls[0].media).toBe('https://cdn.example.test/a.png');
    expect(calls[0].text).toBe('متن کوتاه');
  });

  it('treats text exactly at the caption limit as a caption', async () => {
    build({ CHANNEL_MEDIA_CAPTION_LIMIT: '10' });

    const outcome = await publisher.publish(
      destination,
      payload({
        text: '1234567890',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.mediaStatus).toBe('SENT');
    expect(publishes()).toHaveLength(1);
  });

  it('sends the text first and the media separately when the text is too long for a caption', async () => {
    build({ CHANNEL_MEDIA_CAPTION_LIMIT: '10' });

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'متن بلندتری که در کپشن جا نمی‌شود',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('SENT');
    expect(publishes()).toHaveLength(2);
    expect(publishes()[0].media).toBeNull();
    expect(publishes()[1].media).toBe('https://cdn.example.test/a.png');
  });

  it('keeps the textual delivery when only the media message fails', async () => {
    build({ CHANNEL_MEDIA_CAPTION_LIMIT: '10' });
    platform.failMedia('PERMANENT', 1);

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'متن بلندتری که در کپشن جا نمی‌شود',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('FAILED');
    expect(outcome.mediaError).toContain('HTTP 400');
    expect(outcome.messageId).not.toBeNull();
  });

  it('falls back to a text-only message when the platform rejects the photo permanently', async () => {
    build();
    platform.failMedia('PERMANENT', 1);

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'کوتاه',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('SENT');
    expect(outcome.mediaStatus).toBe('FAILED');
    expect(publishes()).toHaveLength(2);
    expect(publishes()[1].media).toBeNull();
  });

  it('records an ambiguous media outcome without pretending it was sent', async () => {
    build();
    platform.failMedia('AMBIGUOUS', 1);

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'کوتاه',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.mediaStatus).toBe('NOT_ATTACHED');
  });

  it('does not attempt the media when the text itself failed', async () => {
    build({ CHANNEL_MEDIA_CAPTION_LIMIT: '10' });
    platform.failPublish('PERMANENT', 1);

    const outcome = await publisher.publish(
      destination,
      payload({
        text: 'متن بلندتری که در کپشن جا نمی‌شود',
        media: { url: 'https://cdn.example.test/a.png' },
      }),
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.mediaStatus).toBe('NOT_ATTACHED');
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0].media).toBeNull();
  });

  it('exposes the destination set and its identity', () => {
    build();

    expect(publisher.destinations).toEqual([destination]);
    expect(publisher.destinationKey).toBe('bale');
  });

  it('adds the telegram destination when it is configured, without duplicating Bale', () => {
    build({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHANNEL_ID: 'telegram-channel',
    });

    expect(
      publisher.destinations.map((entry) => entry.platform).sort(),
    ).toEqual(['bale', 'telegram']);
    // The identity is stable (sorted), so the idempotency key does not depend on config order.
    expect(publisher.destinationKey).toBe('bale+telegram');
  });
});

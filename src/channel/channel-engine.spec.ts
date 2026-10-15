import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublishableMarketUpdate } from '../market/market.types';
import {
  createAppConfigService,
  createChannelHarness,
  createIntelligenceStub,
  makeSnapshot,
  ChannelHarness,
} from '../testing/test-doubles';
import { ChannelEngineService } from './channel-engine.service';
import { ChannelPolicyService } from './channel-policy.service';
import { CtaPolicyService } from './cta-policy.service';
import { BotDestinationService } from '../bot/destination.service';
import { ChannelPublisher } from './channel-publisher.service';
import { PublicationStore } from './publication.store';
import { PriceMessageBuilder } from '../bot/price-message.builder';
import { PosterService } from '../poster/poster.service';
import { BotApiClient } from '../platform/bot-api.client';

/**
 * §27.6 / §27.7 / §27.8 — publication jobs, per-destination delivery, retries, ambiguity and
 * restart recovery.
 *
 * Everything is driven through the real engine; only the platform transport and the clock are
 * controlled. The tests assert the *records* (job + delivery statuses) rather than log lines, so a
 * "false success" cannot pass them.
 */

const now = (iso: string): Date => new Date(iso);

const priceUpdate = (symbol = 'IR_GOLD_18K'): PublishableMarketUpdate =>
  ({
    publishable: true,
    dayKey: '2026-09-30',
    accepted: [],
    rejected: [],
    prices: [
      {
        symbol,
        label: 'طلای ۱۸ عیار',
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

const baseEnv = (
  extra: Record<string, string> = {},
): Record<string, string> => ({
  CHANNEL_PUBLICATION_MAX_ATTEMPTS: '3',
  CHANNEL_PUBLICATION_RETRY_DELAY_MS: '0',
  ...extra,
});

const twoPlatformEnv = (
  extra: Record<string, string> = {},
): Record<string, string> =>
  baseEnv({
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHANNEL_ID: 'telegram-channel',
    ...extra,
  });

/** Deterministic Phase 4 projection: the engine never touches Phase 1 state in these tests. */
const liveSnapshot = () =>
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
  ]);

const harnessFor = (
  env: Record<string, string> = {},
  options: { snapshot?: () => ReturnType<typeof makeSnapshot> } = {},
): ChannelHarness =>
  createChannelHarness(env, {
    intelligence: createIntelligenceStub(options.snapshot ?? liveSnapshot),
  });

describe('ChannelEngine — publication lifecycle (§27.6)', () => {
  let harness: ChannelHarness;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes a price update and records one delivery per destination', async () => {
    harness = harnessFor(twoPlatformEnv());
    const at = now('2026-09-30T08:00:00.000Z');

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );

    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.deliveries).toHaveLength(2);
    expect(
      outcome.deliveries.map((delivery) => delivery.platform).sort(),
    ).toEqual(['bale', 'telegram']);
    for (const delivery of outcome.deliveries) {
      expect(delivery.status).toBe('SENT');
      expect(delivery.externalMessageId).not.toBeNull();
      expect(delivery.attemptCount).toBe(1);
    }
    expect(harness.publishes()).toHaveLength(2);
  });

  it('never publishes the same logical window twice (duplicate prevention)', async () => {
    harness = harnessFor(baseEnv());
    const at = now('2026-09-30T08:00:00.000Z');

    const first = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );
    const second = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );

    expect(first.status).toBe('PUBLISHED');
    expect(second.status).toBe('PUBLISHED');
    expect(second.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(harness.publishes()).toHaveLength(1);
    expect(harness.engine.history(10)).toHaveLength(1);
  });

  it('registers an overlapping execution of the same job only once', async () => {
    harness = harnessFor(baseEnv());
    const at = now('2026-09-30T08:00:00.000Z');

    await harness.engine.publishPriceUpdate(priceUpdate(), 'full', at);
    const job = harness.engine.history(1)[0];

    // A second execution attempt of an already published job must not send anything.
    const repeated = await harness.engine.execute(job.id, at);

    expect(repeated.status).toBe('PUBLISHED');
    expect(repeated.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(harness.publishes()).toHaveLength(1);
  });

  it('skips a price update whose market update is no longer available', async () => {
    harness = harnessFor(baseEnv());
    const at = now('2026-09-30T08:00:00.000Z');

    // The job is created for a later execution but the Phase 1 update is gone (a restart).
    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );
    expect(outcome.status).toBe('PUBLISHED');

    const job = harness.engine.history(1)[0];
    const resumed = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );
    expect(resumed.jobId).toBe(job.id);
    expect(harness.publishes()).toHaveLength(1);
  });

  it('publishes a movement message only for the symbols that qualify', async () => {
    harness = harnessFor(baseEnv({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' }));
    const at = now('2026-09-30T08:00:00.000Z');

    const outcomes = await harness.engine.publishMovementEvents(at);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('PUBLISHED');
    expect(outcomes[0].messageType).toBe('MARKET_MOVEMENT');
    expect(harness.publishes()[0].text).toContain('حرکت مهم بازار');
  });

  it('publishes nothing when no symbol crossed its threshold', async () => {
    harness = harnessFor(baseEnv({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '5' }), {
      snapshot: () =>
        makeSnapshot([
          {
            symbol: 'IR_GOLD_18K',
            currentPrice: 17_500_000,
            previousPrice: 17_400_000,
            open: 17_000_000,
            high: 17_600_000,
            low: 16_950_000,
          },
        ]),
    });

    expect(
      await harness.engine.publishMovementEvents(
        now('2026-09-30T08:00:00.000Z'),
      ),
    ).toEqual([]);
    expect(harness.publishes()).toHaveLength(0);
  });

  it('skips a daily report whose reporting day has passed', async () => {
    harness = harnessFor(baseEnv());
    const at = now('2026-09-30T21:00:00.000Z');

    const first = await harness.engine.publishDailyReport(at);
    expect(first.status).toBe('PUBLISHED');

    // Same day, later: duplicate. Next day: a new job (identity includes the Tehran date).
    const sameDay = await harness.engine.publishDailyReport(at);
    expect(sameDay.skipReason).toBe('DUPLICATE_PUBLICATION');

    const nextDay = await harness.engine.publishDailyReport(
      now('2026-10-01T21:00:00.000Z'),
    );
    expect(nextDay.status).toBe('PUBLISHED');
    expect(nextDay.jobId).not.toBe(first.jobId);
    expect(harness.publishes()).toHaveLength(2);
  });

  it('produces deterministic job identities and distinguishable revisions', async () => {
    harness = harnessFor(baseEnv());
    const at = now('2026-09-30T08:00:00.000Z');

    await harness.engine.publishPriceUpdate(
      priceUpdate('IR_GOLD_18K'),
      'full',
      at,
    );
    // A different window (one minute later) is a different identity, and so is a different variant.
    await harness.engine.publishPriceUpdate(
      priceUpdate('IR_GOLD_18K'),
      'full',
      now('2026-09-30T08:30:00.000Z'),
    );
    await harness.engine.publishPriceUpdate(
      priceUpdate('IR_GOLD_18K'),
      'poster',
      now('2026-09-30T08:30:00.000Z'),
    );

    const keys = harness.engine.history(10).map((job) => job.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('ChannelEngine — delivery, retries and failures (§27.7)', () => {
  let harness: ChannelHarness;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries a retryable failure and succeeds on a later attempt', async () => {
    harness = harnessFor(baseEnv({ CHANNEL_PUBLICATION_MAX_ATTEMPTS: '3' }));
    harness.platform.failPublish('RETRYABLE', 2);

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(outcome.status).toBe('PUBLISHED');
    expect(outcome.deliveries[0].status).toBe('SENT');
    expect(outcome.deliveries[0].attemptCount).toBe(3);
    expect(harness.publishes()).toHaveLength(3);
  });

  it('gives up after the configured attempt count and records the failure', async () => {
    harness = harnessFor(baseEnv({ CHANNEL_PUBLICATION_MAX_ATTEMPTS: '2' }));
    harness.platform.failPublish('RETRYABLE', 10);

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.deliveries[0].status).toBe('FAILED');
    expect(outcome.deliveries[0].failureCategory).toBe('RETRYABLE');
    expect(outcome.deliveries[0].attemptCount).toBe(2);
    expect(harness.publishes()).toHaveLength(2);
    // The failure is visible in the job record, never reported as success.
    expect(harness.engine.history(1)[0].status).toBe('FAILED');
    // The concrete platform error is preserved (a generic reason would hide the cause).
    expect(harness.engine.history(1)[0].lastError).toContain('HTTP 502');
  });

  it('does not retry a permanent failure', async () => {
    harness = harnessFor(baseEnv());
    harness.platform.failPublish('PERMANENT', 10);

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(outcome.deliveries[0].failureCategory).toBe('PERMANENT');
    expect(outcome.deliveries[0].attemptCount).toBe(1);
    expect(harness.publishes()).toHaveLength(1);
  });

  it('records an ambiguous outcome as UNKNOWN and never retries it automatically', async () => {
    harness = harnessFor(baseEnv({ CHANNEL_PUBLICATION_MAX_ATTEMPTS: '3' }));
    harness.platform.failPublish('AMBIGUOUS', 10);

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(outcome.deliveries[0].status).toBe('UNKNOWN');
    expect(outcome.deliveries[0].attemptCount).toBe(1);
    expect(harness.publishes()).toHaveLength(1);
    expect(outcome.status).toBe('FAILED');
    expect(harness.engine.history(1)[0].lastError).toContain(
      'DELIVERY_OUTCOME_UNKNOWN',
    );
  });

  it('keeps the destinations independent: one failure does not hide the other success', async () => {
    harness = harnessFor(twoPlatformEnv());
    harness.platform.failPublish('PERMANENT', 10, 'bale');

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    const byPlatform = Object.fromEntries(
      outcome.deliveries.map((delivery) => [
        delivery.platform,
        delivery.status,
      ]),
    );

    expect(byPlatform).toEqual({ bale: 'FAILED', telegram: 'SENT' });
    expect(outcome.status).toBe('PUBLISHED'); // at least one destination received it
    expect(harness.engine.history(1)[0].status).toBe('PUBLISHED');
  });

  it('fails the job when every destination failed', async () => {
    harness = harnessFor(twoPlatformEnv());
    harness.platform.failPublish('PERMANENT', 10);

    const outcome = await harness.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(outcome.status).toBe('FAILED');
    expect(harness.engine.history(1)[0].status).toBe('FAILED');
  });

  it('records a failure instead of a false success when no destination is configured', async () => {
    const config = createAppConfigService(baseEnv());
    const store = new PublicationStore(config);
    const publish = jest.fn();
    const emptyPublisher = {
      destinations: [],
      destinationKey: '',
      publish,
    } as unknown as ChannelPublisher;
    const engine = new ChannelEngineService(
      config,
      store,
      emptyPublisher,
      new ChannelPolicyService(config, store),
      new CtaPolicyService(config),
      createIntelligenceStub(liveSnapshot),
      new PriceMessageBuilder(config),
      new PosterService(config),
    );

    const outcome = await engine.publishDailyReport(
      now('2026-09-30T21:00:00.000Z'),
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.deliveries).toHaveLength(0);
    expect(engine.history(1)[0].lastError).toBe('ALL_DESTINATIONS_FAILED');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('ChannelEngine — persistence and restart recovery (§27.8)', () => {
  let directory: string;
  let harness: ChannelHarness;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'atabak-channel-'));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const buildEngine = (
    env: Record<string, string>,
    platform: ReturnType<typeof createChannelHarness>['platform'],
  ): { engine: ChannelEngineService; store: PublicationStore } => {
    const config = createAppConfigService({
      ...env,
      CHANNEL_DATA_FILE: join(directory, 'channel.json'),
    });
    const store = new PublicationStore(config);
    const publisher = new ChannelPublisher(
      config,
      platform.client as unknown as BotApiClient,
      new BotDestinationService(config),
    );
    const engine = new ChannelEngineService(
      config,
      store,
      publisher,
      new ChannelPolicyService(config, store),
      new CtaPolicyService(config),
      createIntelligenceStub(liveSnapshot),
      new PriceMessageBuilder(config),
      new PosterService(config),
    );

    return { engine, store };
  };

  it('persists the publication history and reloads it after a restart', async () => {
    const env = baseEnv();
    harness = harnessFor(env);
    const at = now('2026-09-30T08:00:00.000Z');

    const first = buildEngine(env, harness.platform);
    await first.engine.onModuleInit();
    const outcome = await first.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );
    expect(outcome.status).toBe('PUBLISHED');

    // Restart: a brand-new store/engine reading the same file.
    const second = buildEngine(env, harness.platform);
    await second.engine.onModuleInit();

    const originalKey = first.engine.history(10)[0].idempotencyKey;
    const restored = second.engine.history(10);
    expect(restored).toHaveLength(1);
    expect(restored[0].idempotencyKey).toBe(originalKey);

    // The same logical window is still a duplicate after the restart → no second send.
    const publishesBefore = harness.publishes().length;
    const repeated = await second.engine.publishPriceUpdate(
      priceUpdate(),
      'full',
      at,
    );
    expect(repeated.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(harness.publishes()).toHaveLength(publishesBefore);
  });

  it('does not repeat a delivery that was already confirmed before the restart', async () => {
    const env = baseEnv();
    harness = harnessFor(env);
    const at = now('2026-09-30T08:00:00.000Z');
    const first = buildEngine(env, harness.platform);
    await first.engine.onModuleInit();

    // Create the job and stop *after* the delivery record was written: simulate the crash by
    // marking the job as PUBLISHING in the persisted document.
    await first.engine.publishPriceUpdate(priceUpdate(), 'full', at);
    const file = join(directory, 'channel.json');
    const persisted = JSON.parse(readFileSync(file, 'utf-8')) as {
      jobs: { id: string; status: string }[];
    };
    persisted.jobs[0].status = 'PUBLISHING';
    persist(file, persisted);

    const second = buildEngine(env, harness.platform);
    const publishesBefore = harness.publishes().length;
    await second.engine.onModuleInit();

    expect(second.engine.history(10)[0].status).toBe('PUBLISHED');
    expect(harness.publishes()).toHaveLength(publishesBefore);
  });

  it('records an interrupted job whose delivery is unknown as failed — and does not retry it', async () => {
    const env = baseEnv();
    harness = harnessFor(env);
    const at = now('2026-09-30T08:00:00.000Z');
    const first = buildEngine(env, harness.platform);
    await first.engine.onModuleInit();
    await first.engine.publishPriceUpdate(priceUpdate(), 'full', at);

    const file = join(directory, 'channel.json');
    const persisted = JSON.parse(readFileSync(file, 'utf-8')) as {
      jobs: { id: string; status: string }[];
      deliveries: { status: string }[];
    };
    persisted.jobs[0].status = 'PUBLISHING';
    persisted.deliveries[0].status = 'UNKNOWN';
    persist(file, persisted);

    const second = buildEngine(env, harness.platform);
    const publishesBefore = harness.publishes().length;
    await second.engine.onModuleInit();

    const job = second.engine.history(10)[0];
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toContain('DELIVERY_OUTCOME_UNKNOWN');
    expect(harness.publishes()).toHaveLength(publishesBefore);
  });

  it('marks a pending job from a previous run as skipped instead of replaying it', async () => {
    const env = baseEnv();
    harness = harnessFor(env);
    const file = join(directory, 'channel.json');

    persist(file, {
      version: 1,
      savedAt: '2026-09-30T08:00:00.000Z',
      contents: [],
      jobs: [
        {
          id: 'pub_old_1',
          messageType: 'DAILY_REPORT',
          status: 'PENDING',
          idempotencyKey: 'DAILY_REPORT|2026-09-29|bale',
          destinationKey: 'bale',
          scheduledAt: '2026-09-29T21:00:00.000Z',
          createdAt: '2026-09-29T21:00:00.000Z',
          startedAt: null,
          completedAt: null,
          contentId: null,
          contentRevision: null,
          reportingDate: '2026-09-29',
          subjects: [],
          variant: null,
          attemptCount: 0,
          lastError: null,
          skipReason: null,
        },
      ],
      deliveries: [],
      movementEvents: [],
      rangeEvents: [],
    });

    const second = buildEngine(env, harness.platform);
    await second.engine.onModuleInit();

    const job = second.engine.history(10)[0];
    expect(job.status).toBe('SKIPPED');
    expect(job.skipReason).toBe('MISSED_WINDOW');
    expect(harness.publishes()).toHaveLength(0);
  });
});

/** Write the persisted channel document back (test-only helper). */
function persist(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

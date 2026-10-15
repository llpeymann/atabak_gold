import { INestApplication, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { rmSync } from 'node:fs';

import { AppModule } from './../src/app.module';
import { ChannelEngineService } from './../src/channel/channel-engine.service';
import { ChannelPublisher } from './../src/channel/channel-publisher.service';
import { ContentService } from './../src/channel/content.service';
import { PublicationStore } from './../src/channel/publication.store';
import { ContentAdminService } from './../src/bot/content/content-admin.service';
import { MarketEngineService } from './../src/market/market-engine.service';
import { rawPricePayload } from './../src/testing/test-doubles';

/**
 * Phase 5 end-to-end (§27.10).
 *
 * The real application graph boots — configuration validation, Phase 1 pipeline, Phase 4
 * intelligence, the Channel Engine, its persisted store (throw-away directory from
 * `test/setup-env.ts`) and the editorial service. Prices always enter through the Phase 1 pipeline,
 * so every published value is a *validated* one, and the platform transport is the only thing
 * replaced by a double: no real channel message can leave the process.
 */

const GOLD = 'IR_GOLD_18K';

interface PublishCall {
  platform: string;
  chatId: string;
  text: string;
}

describe('Channel Engine (e2e)', () => {
  let app: INestApplication;
  let engine: ChannelEngineService;
  let marketEngine: MarketEngineService;
  let store: PublicationStore;
  let content: ContentService;
  let contentAdmin: ContentAdminService;
  const published: PublishCall[] = [];

  const boot = async (): Promise<void> => {
    const httpDouble = {
      get: () => of({ data: rawPricePayload({ [GOLD]: 17_000_000 }) }),
      post: () => of({ data: { ok: true, result: { message_id: 1000 } } }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      // The transport is the *only* replacement: the Channel Engine, its store, its policy and its
      // content service are the production classes.
      .overrideProvider(ChannelPublisher)
      .useValue({
        destinations: [{ platform: 'bale', destination: 'e2e-bale-channel' }],
        destinationKey: 'bale',
        publish: (
          destination: { platform: string; destination: string },
          payload: { text: string },
        ) => {
          published.push({
            platform: destination.platform,
            chatId: destination.destination,
            text: payload.text,
          });

          return Promise.resolve({
            platform: destination.platform,
            destination: destination.destination,
            status: 'SENT' as const,
            failureKind: null,
            messageId: `900${published.length}`,
            mediaMessageId: null,
            mediaStatus: 'NOT_ATTACHED' as const,
            mediaError: null,
            error: null,
            durationMs: 1,
          });
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    engine = app.get(ChannelEngineService);
    marketEngine = app.get(MarketEngineService);
    store = app.get(PublicationStore);
    content = app.get(ContentService);
    contentAdmin = app.get(ContentAdminService);
  };

  /** One real Phase 1 cycle: validated prices in, publishable update out. */
  const accept = async (
    prices: Record<string, number>,
    at = new Date(),
  ): Promise<{
    publishable: boolean;
    update: Parameters<ChannelEngineService['publishPriceUpdate']>[0];
  }> => {
    const result = await marketEngine.evaluateCycle(
      rawPricePayload(prices, at.toISOString()),
      at,
    );

    return { publishable: result.update.publishable, update: result.update };
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    published.length = 0;

    // Each test starts from an empty throw-away state: the channel history and the market state.
    for (const file of [
      process.env.CHANNEL_DATA_FILE,
      process.env.MARKET_STATE_FILE,
    ]) {
      expect(file).toBeDefined();
      expect(file).not.toContain('/home/user/atabak_gold');
      rmSync(file as string, { force: true });
    }

    await boot();
    await accept({ [GOLD]: 17_000_000 }, new Date('2026-09-30T08:00:00.000Z'));
    await accept({ [GOLD]: 17_500_000 }, new Date('2026-09-30T08:30:00.000Z'));
  });

  afterEach(async () => {
    await app.close();
  });

  it('boots the engine with its persisted store and its destinations', () => {
    expect(engine).toBeDefined();
    expect(store.path).toBe(process.env.CHANNEL_DATA_FILE);
    expect(
      engine.destinations.map((destination) => destination.platform),
    ).toEqual(['bale']);
  });

  it('publishes a Phase 1-approved price update and records the delivery', async () => {
    const cycle = await accept(
      { [GOLD]: 17_600_000 },
      new Date('2026-09-30T09:00:00.000Z'),
    );
    expect(cycle.publishable).toBe(true);

    const outcome = await engine.publishPriceUpdate(
      cycle.update,
      'full',
      new Date('2026-09-30T09:00:00.000Z'),
    );

    expect(outcome.status).toBe('PUBLISHED');
    expect(published).toHaveLength(1);
    expect(published[0].text).toContain('گزارش لحظه‌ای بازار');
    expect(outcome.deliveries[0]).toMatchObject({
      platform: 'bale',
      status: 'SENT',
      externalMessageId: '9001',
    });

    // The history is persisted: the same logical window is a duplicate, so nothing is re-sent.
    const repeated = await engine.publishPriceUpdate(
      cycle.update,
      'full',
      new Date('2026-09-30T09:00:00.000Z'),
    );
    expect(repeated.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(published).toHaveLength(1);
  });

  it('renders the daily report from the validated Phase 1/4 data', async () => {
    const outcome = await engine.publishDailyReport(
      new Date('2026-09-30T19:30:00.000Z'),
    );

    expect(outcome.status).toBe('PUBLISHED');
    expect(published[0].text).toContain('گزارش روزانه بازار');
    // The daily high/low come from Phase 1 statistics (17.5M / 17.0M), never from the fetch value.
    expect(published[0].text).toContain('۱۷٬۵۰۰٬۰۰۰');
  });

  it('gates the editorial workflow and re-checks the approval at execution time', async () => {
    // A nightly analysis is date-bound: it belongs to the *current* Tehran reporting day, so the
    // test uses the real clock for it (the market state above is only used for its labels).
    const now = new Date();
    const created = await content.create(
      {
        messageType: 'NIGHTLY_ANALYSIS',
        title: 'نگاه امشب',
        body: 'متن تحلیلی امشب بر پایهٔ داده‌های معتبر.',
        authorId: 'bale:e2e-admin',
      },
      now,
    );
    expect(created.ok).toBe(true);
    const id = created.ok ? created.content.id : '';

    // A draft can never be published.
    const draftAttempt = await engine.publishContent(id, now);
    expect(draftAttempt.skipReason).toBe('CONTENT_NOT_APPROVED');
    expect(published).toHaveLength(0);

    await content.approve(id, 'bale:e2e-admin', now);
    const nightly = await engine.publishContent(id, now);

    expect(nightly.status).toBe('PUBLISHED');
    expect(published[0].text).toContain('نگاه طلای اتابک');
    expect(published[0].text).toContain('داده‌های معتبر بازار');
    expect(content.find(id)?.status).toBe('PUBLISHED');
  });

  it('keeps the admin surface gated by the configured allow-list', () => {
    expect(contentAdmin.enabled).toBe(true);
    expect(contentAdmin.isAdmin('bale', 'e2e-admin')).toBe(true);
    expect(contentAdmin.isAdmin('bale', 'someone-else')).toBe(false);
    expect(contentAdmin.isAdmin('telegram', 'e2e-admin')).toBe(false);
  });

  it('reloads the persisted history after a restart without repeating a delivery', async () => {
    const cycle = await accept(
      { [GOLD]: 17_600_000 },
      new Date('2026-09-30T09:00:00.000Z'),
    );
    await engine.publishPriceUpdate(
      cycle.update,
      'full',
      new Date('2026-09-30T09:00:00.000Z'),
    );
    const before = published.length;

    await app.close();

    const second: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue({
        get: () => of({ data: rawPricePayload({ [GOLD]: 17_000_000 }) }),
        post: () => of({ data: { ok: true, result: { message_id: 1 } } }),
      })
      .overrideProvider(ChannelPublisher)
      .useValue({
        destinations: [{ platform: 'bale', destination: 'e2e-bale-channel' }],
        destinationKey: 'bale',
        publish: () => {
          published.push({
            platform: 'bale',
            chatId: 'e2e-bale-channel',
            text: 'unexpected',
          });

          return Promise.resolve(null);
        },
      })
      .compile();
    const secondApp = second.createNestApplication();
    await secondApp.init();

    const restoredEngine = secondApp.get(ChannelEngineService);
    const history = restoredEngine.history(10);
    const marketEngineSecond = secondApp.get(MarketEngineService);
    const cycleAgain = await marketEngineSecond.evaluateCycle(
      rawPricePayload({ [GOLD]: 17_600_000 }, '2026-09-30T09:00:00.000Z'),
      new Date('2026-09-30T09:00:00.000Z'),
    );

    const repeated = await restoredEngine.publishPriceUpdate(
      cycleAgain.update,
      'full',
      new Date('2026-09-30T09:00:00.000Z'),
    );

    await secondApp.close();

    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('PUBLISHED');
    expect(repeated.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(published).toHaveLength(before);
  });
});

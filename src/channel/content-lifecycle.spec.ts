import { Logger } from '@nestjs/common';

import {
  createChannelHarness,
  createIntelligenceStub,
  makeSnapshot,
  ChannelHarness,
} from '../testing/test-doubles';
import { MessageType } from './channel.types';

/**
 * §27.6 — editorial lifecycle for the three pillars, and §19/§7: nothing is published without an
 * approval that still applies at execution time, a material edit invalidates an approval, and a
 * cancellation wins over a scheduled job.
 */

const now = (iso: string): Date => new Date(iso);
const TODAY = '2026-09-30';

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

const harnessFor = (env: Record<string, string> = {}): ChannelHarness =>
  createChannelHarness(env, {
    intelligence: createIntelligenceStub(liveSnapshot),
  });

async function draft(
  harness: ChannelHarness,
  messageType: MessageType,
  body = 'متن آزمایشی برای انتشار در کانال.',
) {
  const result = await harness.content.create(
    {
      messageType,
      title: 'عنوان آزمایشی',
      body,
      authorId: 'bale:1',
      reportingDate: TODAY,
    },
    now('2026-09-30T08:00:00.000Z'),
  );

  if (!result.ok) {
    throw new Error(`draft creation failed: ${result.reason}`);
  }

  return result.content;
}

describe('editorial content lifecycle (§27.6)', () => {
  let harness: ChannelHarness;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    harness = harnessFor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates drafts for all three editorial types only', async () => {
    for (const type of [
      'EDUCATIONAL',
      'BRANDED',
      'NIGHTLY_ANALYSIS',
    ] as MessageType[]) {
      const item = await draft(harness, type);
      expect(item.messageType).toBe(type);
      expect(item.status).toBe('DRAFT');
      expect(item.revision).toBe(1);
    }

    const rejected = await harness.content.create(
      {
        messageType: 'PRICE_UPDATE',
        title: 'x',
        body: 'y',
        authorId: 'bale:1',
      },
      now('2026-09-30T08:00:00.000Z'),
    );
    expect(rejected.ok).toBe(false);
    expect(rejected).toMatchObject({ reason: 'INVALID_INPUT' });
  });

  it('never publishes a draft', async () => {
    const item = await draft(harness, 'EDUCATIONAL');

    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.skipReason).toBe('CONTENT_NOT_APPROVED');
    expect(harness.publishes()).toHaveLength(0);
  });

  it('publishes an approved educational message with its pillar title', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );

    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    expect(outcome.status).toBe('PUBLISHED');
    expect(harness.publishes()[0].text).toContain('گنجینه طلایی اتابک');
    expect(harness.content.find(item.id)?.status).toBe('PUBLISHED');
  });

  it('publishes a branded message and a nightly analysis through the same path', async () => {
    const branded = await draft(harness, 'BRANDED');
    await harness.content.approve(
      branded.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    const brandedOutcome = await harness.engine.publishContent(
      branded.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    // 20:30 Tehran (= 17:00 UTC) is still the same Tehran reporting day as the draft.
    const nightly = await draft(harness, 'NIGHTLY_ANALYSIS');
    await harness.content.approve(
      nightly.id,
      'bale:1',
      now('2026-09-30T16:50:00.000Z'),
    );
    const nightlyOutcome = await harness.engine.publishContent(
      nightly.id,
      now('2026-09-30T17:00:00.000Z'),
    );

    expect(brandedOutcome.status).toBe('PUBLISHED');
    expect(nightlyOutcome.status).toBe('PUBLISHED');
    const texts = harness.publishes().map((call) => call.text);
    expect(texts[0]).toContain('طلای اتابک');
    expect(texts[1]).toContain('نگاه طلای اتابک');
    expect(texts[1]).toContain('داده‌های معتبر بازار');
  });

  it('does not publish the same content revision twice', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );

    await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );
    const repeated = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:05:00.000Z'),
    );

    expect(repeated.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(harness.publishes()).toHaveLength(1);
  });

  it('invalidates the approval when the content is materially edited', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );

    const edited = await harness.content.edit(
      item.id,
      { body: 'متن کاملاً متفاوت برای همان آموزش.' },
      now('2026-09-30T08:10:00.000Z'),
    );

    expect(edited.ok).toBe(true);
    expect(edited.ok && edited.content.revision).toBe(2);
    expect(edited.ok && edited.content.status).toBe('DRAFT');
    expect(edited.ok && edited.content.approvedAt).toBeNull();

    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.skipReason).toBe('CONTENT_NOT_APPROVED');
    expect(harness.publishes()).toHaveLength(0);
  });

  it('re-checks the approval at execution time even when the job was created earlier', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );

    // A job that was created while revision 1 was approved…
    const jobId = 'pub_created_while_approved';
    await harness.store.transact((tx) => {
      tx.saveJob({
        id: jobId,
        messageType: 'EDUCATIONAL',
        status: 'PENDING',
        idempotencyKey: `EDUCATIONAL|${item.id}|r1|bale`,
        destinationKey: 'bale',
        scheduledAt: '2026-09-30T12:00:00.000Z',
        createdAt: '2026-09-30T08:06:00.000Z',
        startedAt: null,
        completedAt: null,
        contentId: item.id,
        contentRevision: 1,
        reportingDate: TODAY,
        subjects: [],
        variant: null,
        attemptCount: 0,
        lastError: null,
        skipReason: null,
      });
    });

    // …and the content is materially edited (→ revision 2, approval cleared) before execution.
    await harness.content.edit(
      item.id,
      { title: 'عنوان تازه' },
      now('2026-09-30T08:30:00.000Z'),
    );

    const outcome = await harness.engine.execute(
      jobId,
      now('2026-09-30T12:00:10.000Z'),
    );

    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.skipReason).toBe('CONTENT_NOT_APPROVED');
    expect(harness.publishes()).toHaveLength(0);
    expect(harness.engine.findJob(jobId)?.lastError).toContain(
      'revision changed',
    );
  });

  it('refuses to schedule a draft', async () => {
    const item = await draft(harness, 'BRANDED');

    const result = await harness.content.schedule(
      item.id,
      '2026-09-30T12:00:00.000Z',
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('blocks a scheduled item that was cancelled afterwards', async () => {
    const item = await draft(harness, 'BRANDED');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    await harness.content.schedule(
      item.id,
      '2026-09-30T12:00:00.000Z',
      now('2026-09-30T08:06:00.000Z'),
    );
    await harness.content.cancel(item.id, now('2026-09-30T08:30:00.000Z'));

    const outcomes = await harness.engine.publishDueContent(
      now('2026-09-30T12:00:05.000Z'),
    );

    expect(outcomes).toEqual([]);
    expect(harness.publishes()).toHaveLength(0);
    expect(harness.content.find(item.id)?.status).toBe('CANCELLED');
  });

  it('marks a content item whose scheduled window has passed as missed, never publishing it late', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    await harness.content.schedule(
      item.id,
      '2026-09-30T12:00:00.000Z',
      now('2026-09-30T08:06:00.000Z'),
    );

    // The service was down and only restarts two hours later.
    const outcomes = await harness.engine.publishDueContent(
      now('2026-09-30T14:00:00.000Z'),
    );

    expect(outcomes[0].status).toBe('SKIPPED');
    expect(outcomes[0].skipReason).toBe('MISSED_WINDOW');
    expect(harness.publishes()).toHaveLength(0);
    const stored = harness.content.find(item.id);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.lastError).toContain('MISSED_WINDOW');
  });

  it('publishes a scheduled item that is still inside its window', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    await harness.content.schedule(
      item.id,
      '2026-09-30T12:00:00.000Z',
      now('2026-09-30T08:06:00.000Z'),
    );

    const outcomes = await harness.engine.publishDueContent(
      now('2026-09-30T12:05:00.000Z'),
    );

    expect(outcomes[0].status).toBe('PUBLISHED');
    expect(harness.publishes()).toHaveLength(1);
  });

  it('keeps the complete publication history of an editorial item', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    const history = harness.engine.history(10);

    expect(history).toHaveLength(1);
    expect(history[0].messageType).toBe('EDUCATIONAL');
    expect(history[0].contentId).toBe(item.id);
    expect(history[0].contentRevision).toBe(1);
    expect(history[0].status).toBe('PUBLISHED');
    expect(history[0].completedAt).not.toBeNull();
    expect(harness.content.find(item.id)?.lastJobId).toBe(history[0].id);
  });

  it('publishes after approval even when an earlier attempt was skipped', async () => {
    const item = await draft(harness, 'EDUCATIONAL');

    // First attempt while the item is still a draft → skipped, nothing sent.
    const skipped = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );
    expect(skipped.status).toBe('SKIPPED');
    expect(harness.publishes()).toHaveLength(0);

    // Approval happens afterwards: the same logical identity is re-executed, once.
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T09:05:00.000Z'),
    );
    const published = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:10:00.000Z'),
    );

    expect(published.status).toBe('PUBLISHED');
    expect(published.jobId).toBe(skipped.jobId);
    expect(harness.publishes()).toHaveLength(1);

    // …and a third attempt is still a duplicate: the guard protects real deliveries.
    const again = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:20:00.000Z'),
    );
    expect(again.skipReason).toBe('DUPLICATE_PUBLICATION');
    expect(harness.publishes()).toHaveLength(1);
  });

  it('sends media as a caption when the text fits the caption limit', async () => {
    const item = await draft(harness, 'BRANDED');
    await harness.content.edit(
      item.id,
      { mediaUrl: 'https://cdn.example.test/brand.png' },
      now('2026-09-30T08:02:00.000Z'),
    );
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );

    await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    const calls = harness.publishes();
    expect(calls).toHaveLength(1);
    expect(calls[0].media).toBe('https://cdn.example.test/brand.png');
    expect(calls[0].text).toContain('طلای اتابک');
  });

  it('falls back to text when the platform rejects the media, and records the media failure', async () => {
    const item = await draft(harness, 'BRANDED');
    await harness.content.edit(
      item.id,
      { mediaUrl: 'https://cdn.example.test/brand.png' },
      now('2026-09-30T08:02:00.000Z'),
    );
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    harness.platform.failMedia('PERMANENT', 10);

    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );

    expect(outcome.status).toBe('PUBLISHED');
    const delivery = outcome.deliveries[0];
    expect(delivery.status).toBe('SENT');
    expect(delivery.mediaStatus).toBe('FAILED');
    expect(delivery.mediaError).toContain('HTTP 400');
  });

  it('never publishes a nightly analysis on the wrong reporting date', async () => {
    const item = await draft(harness, 'NIGHTLY_ANALYSIS');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T21:00:00.000Z'),
    );

    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-10-01T20:00:00.000Z'),
    );

    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.skipReason).toBe('MISSED_WINDOW');
    expect(harness.publishes()).toHaveLength(0);
  });

  it('rejects content that carries markup or an invalid media url', async () => {
    const markup = await harness.content.create(
      {
        messageType: 'EDUCATIONAL',
        title: 'سالم',
        body: '<b>متن پرخطر</b>',
        authorId: 'bale:1',
      },
      now('2026-09-30T08:00:00.000Z'),
    );
    const badUrl = await harness.content.create(
      {
        messageType: 'EDUCATIONAL',
        title: 'سالم',
        body: 'متن سالم',
        mediaUrl: 'javascript:alert(1)',
        authorId: 'bale:1',
      },
      now('2026-09-30T08:00:00.000Z'),
    );
    const tooLong = await harness.content.create(
      {
        messageType: 'EDUCATIONAL',
        title: 'سالم',
        body: 'ط'.repeat(4_000),
        authorId: 'bale:1',
      },
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(markup).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    expect(badUrl).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    expect(tooLong).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
  });

  it('reopens a cancelled item as a new revision that needs a fresh approval', async () => {
    const item = await draft(harness, 'EDUCATIONAL');
    await harness.content.approve(
      item.id,
      'bale:1',
      now('2026-09-30T08:05:00.000Z'),
    );
    await harness.content.cancel(item.id, now('2026-09-30T08:10:00.000Z'));

    const reopened = await harness.content.reopen(
      item.id,
      now('2026-09-30T08:20:00.000Z'),
    );

    expect(reopened.ok && reopened.content.status).toBe('DRAFT');
    expect(reopened.ok && reopened.content.revision).toBe(2);
    const outcome = await harness.engine.publishContent(
      item.id,
      now('2026-09-30T09:00:00.000Z'),
    );
    expect(outcome.skipReason).toBe('CONTENT_NOT_APPROVED');
  });
});

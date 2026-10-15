import { Logger } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppConfigService } from '../testing/test-doubles';
import { PublicationStore } from './publication.store';
import {
  ContentItem,
  PublicationDelivery,
  PublicationJob,
  createChannelId,
  isSafeChannelId,
} from './channel.types';

/**
 * §27.11 — persistence.
 *
 * The publication history is what makes restart recovery, duplicate prevention and honest delivery
 * reporting possible, so the store itself is tested directly: atomic file writes, a tolerant load
 * that never destroys data, and a bounded history that can never prune work in flight.
 */

const nowIso = '2026-09-30T08:00:00.000Z';

const job = (overrides: Partial<PublicationJob> = {}): PublicationJob => ({
  id: 'pub_test_1',
  messageType: 'DAILY_REPORT',
  status: 'PENDING',
  idempotencyKey: 'DAILY_REPORT|2026-09-30|bale',
  destinationKey: 'bale',
  scheduledAt: nowIso,
  createdAt: nowIso,
  startedAt: null,
  completedAt: null,
  contentId: null,
  contentRevision: null,
  reportingDate: '2026-09-30',
  subjects: [],
  variant: null,
  attemptCount: 0,
  lastError: null,
  skipReason: null,
  ...overrides,
});

const delivery = (
  overrides: Partial<PublicationDelivery> = {},
): PublicationDelivery => ({
  id: 'dlv_test_1',
  publicationJobId: 'pub_test_1',
  platform: 'bale',
  destination: 'bale-channel',
  status: 'SENT',
  attemptCount: 1,
  failureCategory: null,
  externalMessageId: '42',
  mediaMessageId: null,
  mediaStatus: 'NOT_ATTACHED',
  mediaError: null,
  createdAt: nowIso,
  sentAt: nowIso,
  lastAttemptAt: nowIso,
  lastError: null,
  ...overrides,
});

const content = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 'cnt_test_1',
  messageType: 'EDUCATIONAL',
  title: 'عنوان',
  body: 'متن',
  mediaUrl: null,
  includeMarketData: false,
  revision: 1,
  status: 'DRAFT',
  createdAt: nowIso,
  updatedAt: nowIso,
  approvedAt: null,
  approvedBy: null,
  scheduledAt: null,
  reportingDate: null,
  lastJobId: null,
  cancelledAt: null,
  lastError: null,
  ...overrides,
});

describe('publication store (§27.11)', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'atabak-store-'));
    file = join(directory, 'channel.json');
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const storeFor = (env: Record<string, string> = {}): PublicationStore =>
    new PublicationStore(
      createAppConfigService({ CHANNEL_DATA_FILE: file, ...env }),
    );

  it('creates ids that are safe to carry in a callback payload', () => {
    for (const prefix of ['cnt', 'pub', 'dlv'] as const) {
      const id = createChannelId(prefix);

      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(isSafeChannelId(id)).toBe(true);
    }

    expect(isSafeChannelId('cnt_../../etc/passwd')).toBe(false);
    expect(isSafeChannelId('nope')).toBe(false);
    expect(isSafeChannelId(42)).toBe(false);
  });

  it('starts empty when the file does not exist yet', async () => {
    const store = storeFor();

    await store.ensureLoaded();

    expect(store.findJob('pub_test_1')).toBeNull();
    expect(store.listContents()).toEqual([]);
    expect(store.jobCount).toBe(0);
    expect(store.path).toBe(file);
  });

  it('writes the document atomically and reloads it in a fresh store', async () => {
    const store = storeFor();

    await store.transact((tx) => {
      tx.saveJob(job());
      tx.saveDelivery(delivery());
      tx.saveContent(content());
    });

    // The written document is complete (no temp file left behind) and parseable JSON.
    const persisted = JSON.parse(readFileSync(file, 'utf-8')) as {
      version: number;
      jobs: unknown[];
      deliveries: unknown[];
      contents: unknown[];
    };
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.deliveries).toHaveLength(1);
    expect(persisted.contents).toHaveLength(1);
    expect(persisted.version).toBeGreaterThan(0);

    const restored = storeFor();
    await restored.ensureLoaded();

    expect(restored.findJob('pub_test_1')?.idempotencyKey).toBe(
      'DAILY_REPORT|2026-09-30|bale',
    );
    expect(restored.listDeliveries('pub_test_1')[0].externalMessageId).toBe(
      '42',
    );
    expect(restored.findContent('cnt_test_1')?.title).toBe('عنوان');
  });

  it('finds jobs by their logical identity (create-if-absent)', async () => {
    const store = storeFor();
    await store.transact((tx) => {
      tx.saveJob(job());
    });

    const found = await store.transact((tx) => ({
      existing: tx.findJobByIdempotencyKey('DAILY_REPORT|2026-09-30|bale'),
      missing: tx.findJobByIdempotencyKey('DAILY_REPORT|2026-10-01|bale'),
    }));

    expect(found.existing?.id).toBe('pub_test_1');
    expect(found.missing).toBeNull();
  });

  it('never loses data when the document is unreadable', async () => {
    writeFileSync(file, '{ this is not json', 'utf-8');

    const store = storeFor();
    await store.ensureLoaded();

    // The corrupt file is reported and ignored — the store starts empty instead of crashing…
    expect(store.jobCount).toBe(0);
    // …and the file itself is left untouched for inspection.
    expect(readFileSync(file, 'utf-8')).toBe('{ this is not json');
  });

  it('ignores an unexpected document shape without throwing', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, jobs: 'nope' }), 'utf-8');

    const store = storeFor();
    await store.ensureLoaded();

    expect(store.jobCount).toBe(0);
  });

  it('drops records that are individually malformed instead of failing the whole load', async () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        savedAt: nowIso,
        contents: [content()],
        jobs: [job(), { id: 42 }],
        deliveries: [delivery(), null],
        movementEvents: [],
        rangeEvents: [],
      }),
      'utf-8',
    );

    const store = storeFor();
    await store.ensureLoaded();

    expect(store.listJobs()).toHaveLength(1);
    expect(store.listDeliveries('pub_test_1')).toHaveLength(1);
    expect(store.listContents()).toHaveLength(1);
  });

  it('prunes the oldest finished jobs and keeps every job that is still in flight', async () => {
    const store = storeFor({ CHANNEL_HISTORY_LIMIT: '3' });

    await store.transact((tx) => {
      for (let index = 0; index < 6; index += 1) {
        tx.saveJob(
          job({
            id: `pub_published_${index}`,
            status: 'PUBLISHED',
            createdAt: `2026-09-30T08:0${index}:00.000Z`,
            idempotencyKey: `key-${index}`,
          }),
        );
      }

      tx.saveJob(
        job({
          id: 'pub_pending',
          status: 'PENDING',
          createdAt: '2026-09-30T07:00:00.000Z',
          idempotencyKey: 'pending',
        }),
      );
      tx.saveJob(
        job({
          id: 'pub_publishing',
          status: 'PUBLISHING',
          createdAt: '2026-09-30T06:00:00.000Z',
          idempotencyKey: 'publishing',
        }),
      );
    });

    const jobs = store.listJobs();
    const ids = jobs.map((entry) => entry.id);

    expect(jobs).toHaveLength(3);
    expect(ids).toContain('pub_pending');
    expect(ids).toContain('pub_publishing');
    // The oldest finished jobs went first.
    expect(ids).not.toContain('pub_published_0');
  });

  it('serializes concurrent transactions so a state transition cannot interleave', async () => {
    const store = storeFor();

    await Promise.all([
      store.transact((tx) => {
        tx.saveJob(job({ id: 'pub_a', idempotencyKey: 'a' }));
      }),
      store.transact((tx) => {
        tx.saveJob(job({ id: 'pub_b', idempotencyKey: 'b' }));
      }),
      store.transact((tx) => {
        tx.saveJob(job({ id: 'pub_c', idempotencyKey: 'c' }));
      }),
    ]);

    const restored = storeFor();
    await restored.ensureLoaded();

    expect(restored.listJobs()).toHaveLength(3);
  });

  it('keeps working when one transaction throws (the write chain survives)', async () => {
    const store = storeFor();

    await expect(
      store.transact(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await store.transact((tx) => {
      tx.saveJob(job());
    });

    expect(store.jobCount).toBe(1);
  });

  it('returns copies, so a caller cannot mutate the stored state by accident', async () => {
    const store = storeFor();
    await store.transact((tx) => {
      tx.saveJob(job());
    });

    const first = store.findJob('pub_test_1');
    expect(first).not.toBeNull();
    (first as PublicationJob).status = 'PUBLISHED';

    expect(store.findJob('pub_test_1')?.status).toBe('PENDING');
  });
});

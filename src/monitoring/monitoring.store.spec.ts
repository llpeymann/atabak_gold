/**
 * Phase 11 — durable monitoring state (§16, §18.7 “process restart with pending work”).
 *
 * These tests use a real temporary directory (never `data/`) and a second store instance over the
 * same files to prove that a restart keeps watches, job history and the outbox.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppConfigService } from '../testing/test-doubles';
import { MonitoringStore } from './monitoring.store';
import { MonitoredJob, MonitorNotification } from './monitoring.types';

describe('MonitoringStore', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'atabak-monitoring-'));
    file = join(directory, 'monitoring.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const createStore = (): MonitoringStore =>
    new MonitoringStore(createAppConfigService({ MONITORING_DATA_FILE: file }));

  const job = (name: string): MonitoredJob => ({
    name,
    expectedIntervalMs: 60_000,
    graceMs: 0,
    status: 'SUCCEEDED',
    lastStartedAt: '2026-10-17T06:00:00.000Z',
    lastCompletedAt: '2026-10-17T06:00:01.000Z',
    lastSuccessAt: '2026-10-17T06:00:01.000Z',
    lastFailureAt: null,
    lastDurationMs: 1000,
    consecutiveFailures: 0,
    lastError: null,
    missedReportedAt: null,
    updatedAt: '2026-10-17T06:00:01.000Z',
  });

  const notification = (
    id: string,
    status: MonitorNotification['status'],
  ): MonitorNotification => ({
    notificationId: id,
    dedupeKey: `key-${id}`,
    kind: 'INCIDENT',
    incidentId: 'inc_1',
    category: 'PRICE_API',
    severity: 'HIGH',
    text: 'x',
    status,
    attemptCount: 0,
    platform: 'bale',
    chatId: '5550001',
    createdAt: '2026-10-17T06:00:00.000Z',
    lastAttemptAt: null,
    nextAttemptAt: null,
    sentAt: null,
    lastError: null,
  });

  it('writes atomically and never leaves a temporary file behind', async () => {
    const store = createStore();

    await store.transact((tx) => {
      tx.saveJob(job('job-a'));
    });

    expect(readdirSync(directory)).toEqual(['monitoring.json']);
  });

  it('restores jobs, watches and notifications after a restart', async () => {
    const first = createStore();

    await first.transact((tx) => {
      tx.saveJob(job('job-a'));
      tx.saveWatch({
        key: 'PRICE_API|-|-|CYCLE_FAILED',
        category: 'PRICE_API',
        platform: null,
        target: null,
        reasonCode: 'CYCLE_FAILED',
        severity: 'HIGH',
        phase: 'OPEN',
        consecutiveFailures: 3,
        totalFailures: 3,
        lastFailureAt: '2026-10-17T06:00:00.000Z',
        lastSuccessAt: null,
        lastError: 'down',
        incidentId: 'inc_1',
        incidentGeneration: 0,
        openedAt: '2026-10-17T06:00:00.000Z',
        resolvedAt: null,
        recoveryCandidateAt: null,
        lastNotifiedAt: null,
        lastNotificationStatus: null,
        updatedAt: '2026-10-17T06:00:00.000Z',
      });
      tx.saveNotification(notification('mn_1', 'PENDING'));
    });

    const restarted = createStore();
    await restarted.ensureLoaded();

    expect(restarted.listJobs()).toHaveLength(1);
    expect(restarted.listWatches()).toHaveLength(1);
    expect(restarted.listNotifications()).toHaveLength(1);
    expect(restarted.dueNotifications(new Date())).toHaveLength(1);
  });

  it('starts empty (never crashes) on a document with an unexpected shape', async () => {
    writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf-8');

    const store = createStore();
    await store.ensureLoaded();

    expect(store.listJobs()).toEqual([]);
    expect(store.listNotifications()).toEqual([]);
  });

  it('prunes only finished notifications and never a pending one', async () => {
    const store = createStore();

    await store.transact((tx) => {
      tx.saveNotification(notification('mn_1', 'SENT'));
      tx.saveNotification(notification('mn_2', 'FAILED'));
      tx.saveNotification(notification('mn_3', 'SENT'));
      tx.saveNotification(notification('mn_4', 'PENDING'));
    });

    await store.transact((tx) => {
      expect(tx.pruneNotifications(1)).toBe(2);
    });

    const remaining = store
      .listNotifications()
      .map((row) => row.notificationId);

    expect(remaining).toContain('mn_4');
    expect(remaining).toContain('mn_3');
    expect(remaining).toHaveLength(2);
  });

  it('reports a write failure to the caller instead of pretending to persist', async () => {
    // A directory where the file should be makes the rename fail deterministically.
    const store = new MonitoringStore(
      createAppConfigService({ MONITORING_DATA_FILE: directory }),
    );

    await expect(
      store.transact((tx) => {
        tx.saveJob(job('job-a'));
      }),
    ).rejects.toBeDefined();

    expect(store.writeHealth.lastWriteErrorAt).not.toBeNull();
    expect(store.listJobs()).toEqual([]);
  });
});

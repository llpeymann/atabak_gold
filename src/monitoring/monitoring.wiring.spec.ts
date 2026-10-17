/**
 * Phase 11 — the *producers* (§7, §8).
 *
 * The engine specs prove the rules. This suite proves that the two seams which exist only in
 * production code actually reach the engine:
 *
 *   1. `PersistenceMonitor` — every durable store reports its real write outcome, so a full disk
 *      opens a `PERSISTENCE_FAILURE` incident and the next successful write closes it.
 *   2. `BotUxService` — the product's outermost error boundary reports an `APPLICATION_ERROR`
 *      observation instead of only logging it.
 *
 * Both drive the real engine over the real Phase 10 incident table. The platform client is the
 * standard double, so nothing here can reach a network.
 */

import { InboundMessage } from '../platform/platform.types';
import {
  createMonitoringHarness,
  createUxHarness,
} from '../testing/test-doubles';

const baseEnv = {
  MONITORING_DATA_FILE: '',
  MONITORING_ACTIVE_HOURS_ONLY: 'false',
  PRICE_STALE_AFTER_MINUTES: '45',
  BOT_POLLING_ENABLED: 'false',
};

/** The monitor notifies on a microtask so a store never waits for monitoring. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: 1,
  platform: 'bale',
  chatId: 'chat-1',
  platformUserId: 'platform-user-1',
  messageId: 501,
  text,
});

describe('PersistenceMonitor → monitoring engine (§8)', () => {
  it('opens a CRITICAL persistence incident from a real write failure', async () => {
    const h = createMonitoringHarness(baseEnv);

    h.persistence.failure(
      'market-state',
      'write',
      new Error('ENOSPC: no space'),
    );
    await flush();

    expect(h.errors.openCount()).toBe(1);

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('PERSISTENCE_FAILURE');
    expect(incident.severity).toBe('CRITICAL');
    expect(incident.summary).toContain('market-state');
  });

  it('closes that incident only when the same document writes successfully', async () => {
    const h = createMonitoringHarness(baseEnv);

    h.persistence.failure('admin-document', 'write', new Error('EACCES'));
    await flush();
    expect(h.errors.openCount()).toBe(1);

    // A different document recovering is not evidence for this one.
    h.persistence.success('market-state');
    await flush();
    expect(h.errors.openCount()).toBe(1);

    h.persistence.success('admin-document');
    await flush();

    expect(h.errors.openCount()).toBe(0);
    expect(h.persistence.failingComponents).toEqual([]);
  });

  it('ignores successful writes of a healthy document (no per-save traffic)', async () => {
    const h = createMonitoringHarness(baseEnv);

    h.persistence.success('user-data');
    h.persistence.success('user-data');
    await flush();

    expect(h.errors.list()).toHaveLength(0);
    expect(h.persistence.failingComponents).toEqual([]);
  });

  it('tracks two failing documents as two separate incidents', async () => {
    const h = createMonitoringHarness(baseEnv);

    h.persistence.failure('market-state', 'write', new Error('EIO'));
    h.persistence.failure('sales-data', 'write', new Error('EIO'));
    await flush();

    expect(h.errors.openCount()).toBe(2);

    const targets = h.errors
      .list({ status: 'OPEN' })
      .map((incident) => incident.summary)
      .join(' ');

    expect(targets).toContain('market-state');
    expect(targets).toContain('sales-data');
  });

  it('never lets monitoring break the write path', async () => {
    const h = createMonitoringHarness(baseEnv);

    // The engine is switched off: a store failure must stay a log line, not an exception.
    const off = createMonitoringHarness({
      ...baseEnv,
      MONITORING_ENABLED: 'false',
    });

    expect(() =>
      off.persistence.failure('sales-data', 'write', {}),
    ).not.toThrow();
    await flush();

    expect(off.errors.openCount()).toBe(0);

    void h;
  });
});

describe('BotUxService → monitoring engine (§7)', () => {
  it('reports an unhandled interaction error as an APPLICATION_ERROR observation', async () => {
    const monitoring = createMonitoringHarness({
      ...baseEnv,
      MONITORING_APPLICATION_ERROR_THRESHOLD: '1',
    });

    const ux = createUxHarness(
      { ...baseEnv },
      { monitoring: monitoring.service },
    );

    // A dependency of the handler fails — exactly what a database or platform bug looks like.
    jest
      .spyOn(ux.users, 'resolveUser')
      .mockRejectedValueOnce(new Error('unexpected failure in user lookup'));

    await ux.botUx.handleUpdate(message('/start'));
    await flush();

    // The user still got a safe reply (the product never leaks the error).
    expect(ux.last().text ?? '').not.toContain('unexpected failure');

    expect(monitoring.errors.openCount()).toBe(1);

    const [incident] = monitoring.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('APPLICATION_ERROR');
    expect(incident.summary).toContain('bot-ux.handle-update');
    expect(incident.source).toBe('bot-router');

    jest.restoreAllMocks();
  });

  it('does not create an incident for a healthy update', async () => {
    const monitoring = createMonitoringHarness({
      ...baseEnv,
      MONITORING_APPLICATION_ERROR_THRESHOLD: '1',
    });

    const ux = createUxHarness(
      { ...baseEnv },
      { monitoring: monitoring.service },
    );

    await ux.botUx.handleUpdate(message('/start'));
    await flush();

    expect(monitoring.errors.list()).toHaveLength(0);
  });
});

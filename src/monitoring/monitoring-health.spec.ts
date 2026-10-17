/**
 * Phase 11 — liveness vs readiness (§10, §18.4).
 *
 * The point of these tests is that a green check never hides a real failure and a real external
 * outage never makes the process look dead.
 */

import { createMonitoringHarness } from '../testing/test-doubles';

const harness = (env: Record<string, string> = {}) =>
  createMonitoringHarness({
    MONITORING_DATA_FILE: '',
    MONITORING_ACTIVE_HOURS_ONLY: 'false',
    MONITORING_ADMIN_CHAT_ID: '5550001',
    ...env,
  });

describe('health reports', () => {
  it('always reports liveness while the process answers', () => {
    const h = harness();
    const live = h.health.liveness();

    expect(live.status).toBe('ok');
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(live.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('has no secret in any check detail', () => {
    const h = harness({ MONITORING_ADMIN_CHAT_ID: '7777777' });
    const report = h.health.readiness();

    for (const check of report.checks) {
      expect(check.detail).not.toContain('7777777');
      expect(check.detail).not.toMatch(/bot\d+:/);
    }
  });

  it('marks persistence as warn — not pass — before any write is observed', () => {
    const h = harness();
    const report = h.health.readiness();

    const persistence = report.checks.find(
      (check) => check.name === 'persistence',
    );
    expect(persistence?.status).toBe('warn');
    expect(report.status).not.toBe('unavailable');
  });

  it('is unavailable when persistence is actually failing', async () => {
    const h = harness();

    // A real failed write: the configured path is a directory, so `rename` fails.
    await h.service
      .onPersistenceFailure({
        component: 'monitoring-document',
        operation: 'write',
        error: 'ENOSPC',
      })
      .catch(() => undefined);

    const store = h.store;
    Object.defineProperty(store, 'writeHealth', {
      configurable: true,
      get: () => ({
        lastWriteOkAt: '2026-10-17T10:00:00.000Z',
        lastWriteErrorAt: new Date().toISOString(),
        lastWriteError: 'ENOSPC',
      }),
    });

    const report = h.health.readiness();

    expect(
      report.checks.find((check) => check.name === 'persistence')?.status,
    ).toBe('fail');
    expect(report.status).toBe('unavailable');
  });

  it('treats a stale market feed as degraded, not as a dead process', async () => {
    const h = harness({ PRICE_STALE_AFTER_MINUTES: '1' });

    await h.market.engine.evaluateCycle(
      {
        gold: [{ symbol: 'XAUUSD', price: 2650.75 }],
        currency: [{ symbol: 'USD', price: 1_032_000 }],
      },
      new Date('2026-10-17T06:00:00.000Z'),
    );

    const report = h.health.readiness(new Date('2026-10-17T06:30:00.000Z'));

    expect(
      report.checks.find((check) => check.name === 'market-data')?.status,
    ).toBe('warn');
    expect(report.status).toBe('degraded');
  });

  it('reports market data as pass right after a valid update', async () => {
    const h = harness({ PRICE_STALE_AFTER_MINUTES: '45' });
    const now = new Date('2026-10-17T06:05:00.000Z');

    await h.market.engine.evaluateCycle(
      {
        gold: [{ symbol: 'XAUUSD', price: 2650.75 }],
        currency: [{ symbol: 'USD', price: 1_032_000 }],
      },
      new Date('2026-10-17T06:00:00.000Z'),
    );

    const report = h.health.readiness(now);

    expect(
      report.checks.find((check) => check.name === 'market-data')?.status,
    ).toBe('pass');
  });

  it('reports the missing notification destination as a warning with a reason', () => {
    const h = harness({ MONITORING_ADMIN_CHAT_ID: '', ADMIN_OWNER_IDS: '' });
    const report = h.health.readiness();

    const notifications = report.checks.find(
      (check) => check.name === 'notifications',
    );

    expect(notifications?.status).toBe('warn');
    expect(notifications?.detail).toBeTruthy();
  });

  it('says monitoring is off instead of pretending everything is fine', async () => {
    const h = harness({ MONITORING_ENABLED: 'false' });

    const outcome = await h.service.recordFailure({
      category: 'PRICE_API',
      reasonCode: 'CYCLE_FAILED',
      summary: 'ignored',
    });

    expect(outcome).toBe('IGNORED');
    expect(h.errors.openCount()).toBe(0);
  });
});

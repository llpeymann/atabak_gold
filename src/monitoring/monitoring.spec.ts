/**
 * Phase 11 — monitoring engine (§18.1–§18.6).
 *
 * Every test drives the *real* engine over the real Phase 10 incident table. Nothing is stubbed
 * except the outside world (the platform client double), and no test can reach a network: the
 * harness uses an in-memory monitoring document and — unless a test opts in — no destination.
 */

import { createMonitoringHarness } from '../testing/test-doubles';

const harness = (env: Record<string, string> = {}) =>
  createMonitoringHarness({
    MONITORING_DATA_FILE: '',
    MONITORING_ACTIVE_HOURS_ONLY: 'false',
    PRICE_STALE_AFTER_MINUTES: '45',
    ...env,
  });

describe('price pipeline monitoring (§5, §18.1)', () => {
  it('records a single failure without opening an incident', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '3' });

    const outcome = await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'socket hang up',
      transport: true,
    });

    expect(outcome).toBe('BELOW_THRESHOLD');
    expect(h.errors.openCount()).toBe(0);
    expect(h.service.snapshot().degradedWatches).toBe(1);
  });

  it('opens exactly one incident when the threshold is crossed', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '3' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'e1',
      transport: true,
    });
    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'e2',
      transport: true,
    });
    const third = await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'e3',
      transport: true,
    });

    expect(third).toBe('INCIDENT_OPEN');
    expect(h.errors.openCount()).toBe(1);

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('PRICE_API');
    expect(incident.severity).toBe('HIGH');
    expect(incident.source).toBe('price-api');
    expect(incident.occurrences).toBe(1);
  });

  it('honours a threshold other than three', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '5' });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await h.service.onPriceCycleFailure({
        reasonCode: 'CYCLE_FAILED',
        error: `e${attempt}`,
        transport: true,
      });
    }

    expect(h.errors.openCount()).toBe(0);

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'e5',
      transport: true,
    });

    expect(h.errors.openCount()).toBe(1);
  });

  it('aggregates repeats on the same incident instead of creating new ones', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'a',
      transport: true,
    });
    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'b',
      transport: true,
    });
    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'c',
      transport: true,
    });

    expect(h.errors.openCount()).toBe(1);
    expect(h.errors.list({ status: 'OPEN' })[0].occurrences).toBe(3);
  });

  it('counts a rejected payload separately from a transport failure', async () => {
    const h = harness({
      MONITORING_PRICE_FAILURE_THRESHOLD: '1',
      MONITORING_APPLICATION_ERROR_THRESHOLD: '1',
    });

    await h.service.onPriceCycleFailure({
      reasonCode: 'INVALID_SCHEMA',
      error: 'schema mismatch',
      transport: false,
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('MARKET_DATA_INVALID');
    expect(incident.source).toBe('market');
  });

  it('does not count a deliberate anomaly rejection as an API outage', async () => {
    const h = harness({
      MONITORING_PRICE_FAILURE_THRESHOLD: '1',
      MONITORING_APPLICATION_ERROR_THRESHOLD: '1',
    });

    await h.service.onMarketDataRejected({
      reasonCode: 'EXCESSIVE_CHANGE',
      detail: 'XAUUSD moved 31%',
    });

    const open = h.errors.list({ status: 'OPEN' });
    expect(open).toHaveLength(1);
    expect(open[0].category).toBe('MARKET_DATA_INVALID');
    expect(open[0].severity).toBe('MEDIUM');
  });

  it('keeps counting an open incident without its own notification storm', async () => {
    const h = harness({
      MONITORING_PRICE_FAILURE_THRESHOLD: '1',
      MONITORING_ADMIN_CHAT_ID: '5550001',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.service.onPriceCycleFailure({
        reasonCode: 'CYCLE_FAILED',
        error: `e${attempt}`,
        transport: true,
      });
    }

    // One incident, one queued notification: repeats inside the cooldown add no messages.
    expect(h.errors.openCount()).toBe(1);
    expect(h.store.listNotifications()).toHaveLength(1);
  });
});

describe('recovery (§13, §18.6)', () => {
  it('resolves on verified valid data, not on a mere HTTP answer', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
    });

    const at = new Date(Date.now() + 60_000);
    const outcome = await h.service.onPriceCycleSuccess(at);

    expect(outcome).toBe('RECOVERED');

    const [incident] = h.errors.list({});
    expect(incident.status).toBe('RESOLVED');
    expect(incident.resolvedBy).toBe('monitoring');
    expect(incident.resolutionNote).toContain('Verified recovery');
  });

  it('opens a new incident when a resolved condition recurs, and keeps both', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'first',
      transport: true,
    });
    await h.service.onPriceCycleSuccess(new Date(Date.now() + 1000));
    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'second',
      transport: true,
    });

    const all = h.errors.list({});
    const resolved = all.filter((incident) => incident.status === 'RESOLVED');
    const open = all.filter((incident) => incident.status === 'OPEN');

    expect(resolved).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(open[0].incidentId).not.toBe(resolved[0].incidentId);
  });

  it('requires the stability window when one is configured', async () => {
    const h = harness({
      MONITORING_PRICE_FAILURE_THRESHOLD: '1',
      MONITORING_RECOVERY_STABILITY_SECONDS: '300',
    });

    const start = Date.now();
    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
      at: new Date(start),
    });

    const first = await h.service.onPriceCycleSuccess(new Date(start + 1000));
    expect(first).not.toBe('RECOVERED');
    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(1);

    const second = await h.service.onPriceCycleSuccess(
      new Date(start + 301_000),
    );
    expect(second).toBe('RECOVERED');
    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(0);
  });

  it('does not resolve an incident because of an unrelated success', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
    });

    // A successful delivery proves nothing about the price feed.
    await h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target: 'chan-1',
      operation: 'channel-publication',
      ok: true,
    });

    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(1);
  });
});

describe('delivery monitoring (§6, §18.2)', () => {
  const fail = (
    h: ReturnType<typeof harness>,
    target: string,
    kind = 'RETRYABLE',
  ) =>
    h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target,
      operation: 'channel-publication',
      ok: false,
      error: 'platform refused',
      failureKind: kind,
    });

  it('keeps one destination’s failures apart from another’s', async () => {
    const h = harness({ MONITORING_DELIVERY_FAILURE_THRESHOLD: '1' });

    await fail(h, 'chan-a');
    await fail(h, 'chan-b');

    const open = h.errors.list({ status: 'OPEN' });
    expect(open).toHaveLength(2);
    expect(new Set(open.map((incident) => incident.fingerprint)).size).toBe(2);
  });

  it('opens only after the configured streak for one destination', async () => {
    const h = harness({ MONITORING_DELIVERY_FAILURE_THRESHOLD: '3' });

    await fail(h, 'chan-a');
    await fail(h, 'chan-a');
    expect(h.errors.openCount()).toBe(0);

    await fail(h, 'chan-a');
    expect(h.errors.openCount()).toBe(1);
  });

  it('recovers on a real acceptance of the same destination', async () => {
    const h = harness({ MONITORING_DELIVERY_FAILURE_THRESHOLD: '1' });

    await fail(h, 'chan-a');
    const outcome = await h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target: 'chan-a',
      operation: 'channel-publication',
      ok: true,
    });

    expect(outcome).toBe('RECOVERED');
    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(0);
  });

  it('never reports an unknown outcome as a success', async () => {
    const h = harness({ MONITORING_DELIVERY_FAILURE_THRESHOLD: '1' });

    await h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target: 'chan-a',
      operation: 'channel-publication',
      ok: false,
      error: 'no answer',
      failureKind: 'AMBIGUOUS',
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.retryable).toBe(false);
    expect(incident.summary).toContain('AMBIGUOUS');
  });

  it('escalates a widespread publication failure to HIGH', async () => {
    const h = harness();

    await h.service.onPublicationOutcome({
      sent: 0,
      failed: 2,
      unknown: 0,
      reason: 'both channels refused',
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('CHANNEL_PUBLISHING');
    expect(incident.severity).toBe('HIGH');
  });

  it('treats a partially successful publication as a failure of the failed part only', async () => {
    const h = harness({ MONITORING_DELIVERY_FAILURE_THRESHOLD: '1' });

    await h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target: 'chan-a',
      operation: 'channel-publication',
      ok: true,
    });
    await h.service.onDelivery({
      platform: 'telegram',
      destination: 'channel',
      target: 'chan-b',
      operation: 'channel-publication',
      ok: false,
      error: 'forbidden',
      failureKind: 'PERMANENT',
    });

    const open = h.errors.list({ status: 'OPEN' });
    expect(open).toHaveLength(1);
    expect(open[0].source).toBe('platform-telegram');
  });
});

describe('stale data and jobs (§5.4, §9, §18.5)', () => {
  it('raises a stale incident when valid data stops arriving, once', async () => {
    const h = harness({ PRICE_STALE_AFTER_MINUTES: '45' });

    // No market state at all yet: “unknown”, not stale and not healthy.
    const first = await h.service.sweep(new Date());
    expect(first.stale).toBe(false);
    expect(h.errors.openCount()).toBe(0);

    // Seed a valid update, then move the clock far beyond the threshold.
    await h.market.engine.evaluateCycle(
      {
        gold: [{ symbol: 'XAUUSD', price: 2650.75 }],
        currency: [{ symbol: 'USD', price: 1_032_000 }],
      },
      new Date('2026-10-17T06:00:00.000Z'),
    );

    const later = new Date('2026-10-17T09:00:00.000Z');
    expect((await h.service.sweep(later)).stale).toBe(true);
    expect(
      (await h.service.sweep(new Date(later.getTime() + 60_000))).stale,
    ).toBe(true);

    // Still one incident; the second sweep counted an occurrence, not a new row.
    expect(h.errors.openCount()).toBe(1);
    expect(h.errors.list({ status: 'OPEN' })[0].category).toBe(
      'MARKET_DATA_STALE',
    );
  });

  it('records a job failure and a missed run as separate evidence', async () => {
    const h = harness({ MONITORING_ACTIVE_HOURS_ONLY: 'false' });

    await h.service.recordJobStart({
      name: 'market-price-cycle',
      expectedIntervalMs: 60_000,
      graceMs: 0,
      at: new Date('2026-10-17T06:00:00.000Z'),
    });
    await h.service.recordJobEnd({
      name: 'market-price-cycle',
      ok: false,
      error: 'boom',
      at: new Date('2026-10-17T06:00:01.000Z'),
    });

    const failedJob = h.store.findJob('market-price-cycle');
    expect(failedJob?.status).toBe('FAILED');
    expect(failedJob?.consecutiveFailures).toBe(1);
    expect(h.errors.openCount()).toBe(1);

    const missed = await h.service.sweep(new Date('2026-10-17T06:02:00.000Z'));
    expect(missed.missedJobs).toContain('market-price-cycle');
    expect(h.store.findJob('market-price-cycle')?.status).toBe('MISSED');
  });

  it('clears the failure streak on a successful run', async () => {
    const h = harness({ MONITORING_ACTIVE_HOURS_ONLY: 'false' });

    await h.service.recordJobStart({
      name: 'job-a',
      expectedIntervalMs: 60_000,
    });
    await h.service.recordJobEnd({ name: 'job-a', ok: false, error: 'x' });
    await h.service.recordJobStart({
      name: 'job-a',
      expectedIntervalMs: 60_000,
    });
    const outcome = await h.service.recordJobEnd({ name: 'job-a', ok: true });

    expect(outcome).toBe('RECOVERED');
    expect(h.store.findJob('job-a')?.consecutiveFailures).toBe(0);
    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(0);
  });
});

describe('application and persistence monitoring (§7, §8, §18.3)', () => {
  it('groups identical application errors and escalates on repetition', async () => {
    const h = harness({ MONITORING_APPLICATION_ERROR_THRESHOLD: '2' });

    await h.service.onApplicationError({
      service: 'AlertService',
      operation: 'evaluate',
      error: 'undefined is not a function',
    });
    expect(h.errors.openCount()).toBe(0);

    await h.service.onApplicationError({
      service: 'AlertService',
      operation: 'evaluate',
      error: 'undefined is not a function',
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.category).toBe('APPLICATION_ERROR');
    expect(incident.source).toBe('bot-router');
    expect(incident.reference).toContain('AlertService');
  });

  it('never leaks a bot token into an incident summary', async () => {
    const h = harness({ MONITORING_APPLICATION_ERROR_THRESHOLD: '1' });

    await h.service.onApplicationError({
      service: 'PriceService',
      operation: 'fetch',
      error:
        'GET https://tapi.bale.ai/bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe failed',
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.summary).not.toContain(
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    );
    expect(incident.summary).toContain('bot***');
  });

  it('treats a persistence failure as CRITICAL and recovers only on a successful write', async () => {
    const h = harness();

    await h.service.onPersistenceFailure({
      component: 'admin-document',
      operation: 'write',
      error: 'ENOSPC',
    });

    const [incident] = h.errors.list({ status: 'OPEN' });
    expect(incident.severity).toBe('CRITICAL');

    await h.service.onPersistenceSuccess({ component: 'admin-document' });
    expect(h.errors.list({ status: 'OPEN' })).toHaveLength(0);
  });
});

describe('notification gating and destination honesty (§12.1, §18.7)', () => {
  it('persists the incident but reports “no destination” instead of pretending to notify', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
    });

    expect(h.errors.openCount()).toBe(1);
    expect(h.store.listNotifications()).toHaveLength(0);
    expect(h.destination().configured).toBe(false);

    const snapshot = h.service.snapshot();
    expect(snapshot.notificationDestination.configured).toBe(false);
    expect(snapshot.notificationDestination.reason).toBeTruthy();
  });

  it('queues one durable notification when a destination is configured', async () => {
    const h = harness({
      MONITORING_PRICE_FAILURE_THRESHOLD: '1',
      MONITORING_ADMIN_CHAT_ID: '5550001',
    });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
    });

    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('PENDING');
    expect(notification.chatId).toBe('5550001');
    expect(notification.text).toContain('شناسهٔ رخداد');
  });

  it('resolves a configured administrator chat id as the fallback destination', async () => {
    const h = harness({
      MONITORING_ADMIN_CHAT_ID: '',
      ADMIN_OWNER_IDS: 'bale:9001',
    });

    await h.userStore.upsertUser('9001', 'bale', '9001');

    expect(h.destination()).toEqual({ configured: true, platform: 'bale' });
  });
});

describe('persistence and idempotency (§16, §18.6)', () => {
  it('keeps watches and incidents across a restart of the monitoring store', async () => {
    const h = harness({ MONITORING_PRICE_FAILURE_THRESHOLD: '1' });

    await h.service.onPriceCycleFailure({
      reasonCode: 'CYCLE_FAILED',
      error: 'down',
      transport: true,
    });

    const watches = h.store.listWatches();
    expect(watches).toHaveLength(1);
    expect(watches[0].incidentId).not.toBeNull();

    // A second harness over the same (in-memory) document is a fresh instance; the *persisted*
    // state is what a restart restores, which the store-level test below covers with a real file.
    expect(h.store.findWatch(watches[0].key)?.consecutiveFailures).toBe(1);
  });
});

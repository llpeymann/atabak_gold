/**
 * Phase 11 — notification pipeline (§12, §18.7).
 *
 * The platform double records calls and can fail, throw or rate-limit them; the outbox is the real
 * durable one. No test sends anything anywhere.
 */

import { createMonitoringHarness } from '../testing/test-doubles';

const withDestination = (env: Record<string, string> = {}) =>
  createMonitoringHarness({
    MONITORING_DATA_FILE: '',
    MONITORING_ADMIN_CHAT_ID: '5550001',
    MONITORING_PRICE_FAILURE_THRESHOLD: '1',
    MONITORING_DELIVERY_FAILURE_THRESHOLD: '1',
    MONITORING_NOTIFICATION_MAX_ATTEMPTS: '3',
    MONITORING_NOTIFICATION_RETRY_BACKOFF_MS: '1',
    MONITORING_NOTIFICATION_MIN_INTERVAL_MS: '0',
    MONITORING_RECOVERY_NOTIFICATIONS: 'true',
    ...env,
  });

const raiseIncident = async (
  h: ReturnType<typeof withDestination>,
  at?: Date,
) =>
  h.service.onPriceCycleFailure({
    reasonCode: 'CYCLE_FAILED',
    error: 'connection refused',
    transport: true,
    at,
  });

describe('outbox → platform (§12.2, §18.7)', () => {
  it('persists the notification before the send and marks it SENT only on acceptance', async () => {
    const h = withDestination();

    await raiseIncident(h);
    expect(h.store.listNotifications()[0].status).toBe('PENDING');

    await h.dispatcher.processDue(new Date());

    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('SENT');
    expect(notification.attemptCount).toBe(1);
    expect(h.store.listNotifications()[0].sentAt).not.toBeNull();

    const sends = h.platform.calls.filter((call) => call.kind === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain('قطع ارتباط با API قیمت');
  });

  it('does not send the same notification twice when dispatched again', async () => {
    const h = withDestination();

    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());
    await h.dispatcher.processDue(new Date(Date.now() + 60_000));

    expect(
      h.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(1);
  });

  it('retries a transient refusal with backoff and stops at the configured maximum', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_MAX_ATTEMPTS: '2' });

    h.platform.failSends(10);
    await raiseIncident(h);

    const first = await h.dispatcher.processDue(new Date());
    expect(first.retryScheduled).toBe(1);
    expect(h.store.listNotifications()[0].status).toBe('RETRY_PENDING');

    const second = await h.dispatcher.processDue(new Date(Date.now() + 60_000));
    expect(second.failed).toBe(1);

    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('FAILED');
    expect(notification.attemptCount).toBe(2);
  });

  it('treats a permanent refusal as FAILED without an unbounded retry', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_MAX_ATTEMPTS: '1' });

    h.platform.failSends(1);
    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());

    expect(h.store.listNotifications()[0].status).toBe('FAILED');
  });

  it('keeps an unanswered send UNKNOWN and never retries it automatically', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_MAX_ATTEMPTS: '1' });

    h.platform.throwSends(1);
    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());

    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('UNKNOWN');

    // A later sweep must not touch it again: the message may already exist.
    await h.dispatcher.processDue(new Date(Date.now() + 10 * 60_000));
    expect(
      h.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(1);
  });

  it('honours a rate-limit answer without consuming an attempt', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_MAX_ATTEMPTS: '2' });

    // The platform client double reports a fixed failure text; make it a rate-limit answer.
    h.platform.client.sendMessage.mockResolvedValueOnce({
      platform: 'bale',
      chatId: '5550001',
      success: false,
      edited: false,
      messageId: null,
      error: '429 Too Many Requests: retry after 30',
    });

    await raiseIncident(h);
    const result = await h.dispatcher.processDue(new Date());

    expect(result.rateLimited).toBe(true);
    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('RETRY_PENDING');
    expect(notification.attemptCount).toBe(0);

    await h.dispatcher.processDue(new Date(Date.now() + 60_000));
    expect(h.store.listNotifications()[0].status).toBe('SENT');
  });

  it('records the pipeline failure as an incident of its own', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_MAX_ATTEMPTS: '1' });

    h.platform.failSends(1);
    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());

    const pipeline = h.errors
      .list({})
      .filter(
        (incident) => incident.category === 'MONITORING_NOTIFICATION_FAILURE',
      );

    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].source).toBe('monitoring');
  });

  it('never claims success when the platform is not configured', async () => {
    const h = withDestination({ MONITORING_ADMIN_PLATFORM: 'telegram' });

    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());

    const [notification] = h.store.listNotifications();
    expect(notification.status).toBe('FAILED');
    expect(notification.lastError).toContain('not configured');
  });

  it('sends a recovery message once the incident is verified as recovered', async () => {
    const h = withDestination();

    await raiseIncident(h);
    await h.dispatcher.processDue(new Date());

    const at = new Date(Date.now() + 60_000);
    await h.service.onPriceCycleSuccess(at);
    const processed = await h.dispatcher.processDue(at);

    expect(processed.sent).toBe(1);

    const recovery = h.store
      .listNotifications()
      .filter((notification) => notification.kind === 'RECOVERY');

    expect(recovery).toHaveLength(1);
    expect(recovery[0].text).toContain('بازیابی سرویس');
    expect(recovery[0].text).toContain('شاهد بازیابی');
  });

  it('does not send a second recovery message for the same incident', async () => {
    const h = withDestination();

    await raiseIncident(h);
    await h.service.onPriceCycleSuccess(new Date(Date.now() + 1000));
    await h.dispatcher.processDue(new Date(Date.now() + 60_000));

    // Another sweep (or a restart) re-evaluating the same resolved incident changes nothing.
    await h.service.onPriceCycleSuccess(new Date(Date.now() + 120_000));
    await h.dispatcher.processDue(new Date(Date.now() + 180_000));

    expect(
      h.store
        .listNotifications()
        .filter((notification) => notification.kind === 'RECOVERY'),
    ).toHaveLength(1);
  });

  it('processes at most the configured batch size per tick', async () => {
    const h = withDestination({ MONITORING_NOTIFICATION_BATCH_SIZE: '1' });

    await raiseIncident(h);
    await h.service.onDelivery({
      platform: 'bale',
      destination: 'channel',
      target: 'chan-a',
      operation: 'channel-publication',
      ok: false,
      error: 'refused',
      failureKind: 'PERMANENT',
    });

    expect(h.store.listNotifications()).toHaveLength(2);

    const first = await h.dispatcher.processDue(new Date());
    expect(first.processed).toBe(1);
    expect(
      h.store.listNotifications().filter((row) => row.status === 'PENDING'),
    ).toHaveLength(1);
  });
});

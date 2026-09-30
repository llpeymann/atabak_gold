import { Alert, AlertDelivery } from './alert.types';
import {
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../testing/test-doubles';

/**
 * Notification delivery (Phase 3 §41–§47, §59–§61).
 *
 * The notification is a *record-driven* process: one reserved trigger → one delivery record →
 * at most one user-visible message, delivered through the existing platform abstraction, with
 * bounded retries and a documented restart policy.
 */

const CHAT_ID = 'chat-notify-1';

const notificationEnv = (overrides: EnvMap = {}): EnvMap => ({
  // Immediate retries keep the suite fast; the retry *count* is what is under test.
  ALERT_NOTIFICATION_RETRY_DELAY_MS: '0',
  ...overrides,
});

describe('AlertNotificationService', () => {
  let harness: UxHarness;
  let ownerId: string;

  beforeEach(async () => {
    harness = createUxHarness(notificationEnv());
    await seedMarketState(harness, { receivedAt: new Date() });
    const user = await harness.users.resolveUser(
      'bale',
      'notify-user',
      CHAT_ID,
    );
    ownerId = user.id;
  });

  const notifications = () =>
    harness.platform.calls.filter(
      (call) =>
        call.kind === 'send' &&
        call.chatId === CHAT_ID &&
        (call.text ?? '').includes('🔔'),
    );

  /** Create an alert and reserve its trigger — the state a notification starts from. */
  const trigger = async (
    overrides: {
      type?: Alert['type'];
      targetPrice?: number;
      targetPercent?: number;
    } = {},
  ): Promise<Alert> => {
    const type = overrides.type ?? 'PRICE_ABOVE';
    const percentAlert = type.startsWith('PERCENT');
    const created = await harness.alerts.create(ownerId, {
      type,
      symbol: 'IR_GOLD_18K',
      targetPrice: percentAlert ? null : (overrides.targetPrice ?? 18_000_000),
      targetPercent: percentAlert ? (overrides.targetPercent ?? 5) : null,
    });

    if (!created.ok) {
      throw new Error(`could not create the alert: ${created.reason}`);
    }

    const delivery = await harness.alerts.reserveTrigger(created.alert.id, {
      reason:
        created.alert.type === 'PRICE_ABOVE'
          ? 'PRICE_ABOVE_REACHED'
          : created.alert.type === 'PRICE_BELOW'
            ? 'PRICE_BELOW_REACHED'
            : created.alert.type === 'PERCENT_INCREASE'
              ? 'PERCENT_INCREASE_REACHED'
              : 'PERCENT_DECREASE_REACHED',
      price: 18_050_000,
      percent: created.alert.type.startsWith('PERCENT') ? 3.14 : null,
      observedAt: '2026-09-30T13:00:00.000Z',
      chatId: CHAT_ID,
    });

    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    harness.notifications.dispatch(delivery);
    await harness.notifications.drain();

    return created.alert;
  };

  const deliveryOf = (alertId: string): AlertDelivery | null =>
    harness.alerts.findDelivery(alertId);

  // --- happy path -------------------------------------------------------------

  it('sends exactly one notification through the platform abstraction', async () => {
    const alert = await trigger();
    const calls = notifications();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.platform).toBe('bale');
    expect(calls[0]?.text).toContain('طلای ۱۸ عیار');
    expect(calls[0]?.text).toContain('🔔');

    const delivery = deliveryOf(alert.id) as AlertDelivery;
    expect(delivery.status).toBe('SENT');
    expect(delivery.sentAt).not.toBeNull();
    expect(delivery.attemptCount).toBe(1);
  });

  it('keeps the trigger independent from the delivery outcome', async () => {
    const alert = await trigger();

    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'TRIGGERED',
    );
    expect(deliveryOf(alert.id)?.status).toBe('SENT');
  });

  it('describes the trigger without leaking internals', async () => {
    const alert = await trigger({ type: 'PERCENT_DECREASE', targetPercent: 5 });
    const text = notifications()[0]?.text ?? '';

    expect(text).toContain('کاهش');
    expect(text).toContain('%');
    expect(text).not.toContain('PRICE_');
    expect(text).not.toContain('alr_');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain(alert.id);
  });

  it('never notifies twice for the same trigger, even if dispatched again', async () => {
    const alert = await trigger();
    const delivery = deliveryOf(alert.id) as AlertDelivery;

    harness.notifications.dispatch(delivery);
    await harness.notifications.drain();

    expect(notifications()).toHaveLength(1);
    expect(deliveryOf(alert.id)?.attemptCount).toBe(1);
  });

  // --- retries ----------------------------------------------------------------

  it('retries a failed attempt and succeeds on the next one', async () => {
    harness.platform.failSends(1);

    const alert = await trigger();

    const delivery = deliveryOf(alert.id) as AlertDelivery;
    expect(delivery.status).toBe('SENT');
    expect(delivery.attemptCount).toBe(2);
    // A successful delivery closes the record cleanly (the earlier error is not kept).
    expect(delivery.lastError).toBeNull();
    expect(delivery.sentAt).not.toBeNull();
    // Two attempts were made; exactly one of them reached the user.
    expect(notifications()).toHaveLength(2);
    expect(notifications().filter((call) => call.success)).toHaveLength(1);
  });

  it('gives up after the configured number of attempts and never floods', async () => {
    const limited = createUxHarness(
      notificationEnv({ ALERT_NOTIFICATION_MAX_RETRIES: '2' }),
    );
    await seedMarketState(limited, { receivedAt: new Date() });
    const user = await limited.users.resolveUser(
      'bale',
      'notify-fail',
      CHAT_ID,
    );

    limited.platform.failSends(10);

    const created = await limited.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });
    if (!created.ok) {
      throw new Error('could not create the alert');
    }

    const delivery = await limited.alerts.reserveTrigger(created.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_050_000,
      percent: null,
      observedAt: '2026-09-30T13:00:00.000Z',
      chatId: CHAT_ID,
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    limited.notifications.dispatch(delivery);
    await limited.notifications.drain();

    const stored = limited.alerts.findDelivery(
      created.alert.id,
    ) as AlertDelivery;
    // 1 attempt + 2 retries = 3, and not a single attempt more.
    expect(stored.attemptCount).toBe(3);
    expect(stored.status).toBe('FAILED');
    expect(stored.lastError).toBe(
      'notification delivery failed after the maximum number of attempts',
    );
    expect(
      limited.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(3);

    // The alert stays TRIGGERED (one-shot) and is not retried on its own.
    expect(limited.alerts.findForUser(user.id, created.alert.id)?.status).toBe(
      'TRIGGERED',
    );
    limited.notifications.dispatch(stored);
    await limited.notifications.drain();
    expect(
      limited.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(3);
  });

  it('treats a thrown transport error like a failed attempt', async () => {
    harness.platform.throwSends(1);

    const alert = await trigger();

    const delivery = deliveryOf(alert.id) as AlertDelivery;
    expect(delivery.status).toBe('SENT');
    expect(delivery.attemptCount).toBe(2);
    // The thrown transport error was recorded as a failed attempt, then the retry succeeded.
    expect(delivery.lastError).toBeNull();
    expect(
      notifications().filter((call) => call.success === false),
    ).toHaveLength(1);
  });

  it('never retries beyond the configured maximum when retries are disabled', async () => {
    const noRetry = createUxHarness(
      notificationEnv({ ALERT_NOTIFICATION_MAX_RETRIES: '0' }),
    );
    await seedMarketState(noRetry, { receivedAt: new Date() });
    const user = await noRetry.users.resolveUser(
      'bale',
      'notify-none',
      CHAT_ID,
    );

    noRetry.platform.failSends(5);

    const created = await noRetry.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });
    if (!created.ok) {
      throw new Error('could not create the alert');
    }

    const delivery = await noRetry.alerts.reserveTrigger(created.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_050_000,
      percent: null,
      observedAt: '2026-09-30T13:00:00.000Z',
      chatId: CHAT_ID,
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    noRetry.notifications.dispatch(delivery);
    await noRetry.notifications.drain();

    expect(noRetry.alerts.findDelivery(created.alert.id)?.attemptCount).toBe(1);
    expect(
      noRetry.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(1);
  });

  // --- races with the user ----------------------------------------------------

  it('sends nothing when the alert is deleted before delivery', async () => {
    const alert = await trigger({ targetPrice: 18_000_000 });
    // The trigger already fired; now a *second* alert is reserved and deleted before dispatching.
    const second = await harness.alerts.create(ownerId, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_100_000,
    });
    if (!second.ok) {
      throw new Error('could not create the second alert');
    }

    const delivery = await harness.alerts.reserveTrigger(second.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_150_000,
      percent: null,
      observedAt: '2026-09-30T13:30:00.000Z',
      chatId: CHAT_ID,
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    await harness.alerts.remove(ownerId, second.alert.id);

    const before = notifications().length;
    harness.notifications.dispatch(delivery);
    await harness.notifications.drain();

    expect(notifications().length).toBe(before);
    const stored = deliveryOf(second.alert.id) as AlertDelivery;
    expect(stored.status).toBe('FAILED');
    expect(stored.skippedReason).toBe('ALERT_DELETED');
    // The alert stays deleted: nothing revives it.
    expect(harness.alerts.findForUser(ownerId, second.alert.id)).toBeNull();
    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'TRIGGERED',
    );
  });

  it('sends nothing when the alert is disabled before delivery', async () => {
    const created = await harness.alerts.create(ownerId, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_200_000,
    });
    if (!created.ok) {
      throw new Error('could not create the alert');
    }

    const delivery = await harness.alerts.reserveTrigger(created.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_250_000,
      percent: null,
      observedAt: '2026-09-30T13:40:00.000Z',
      chatId: CHAT_ID,
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    // Disabling a TRIGGERED alert is refused by the domain layer, so the delivery is skipped
    // through the state machine instead: the alert row itself is what is re-checked.
    await harness.alerts.markUndeliverable(
      created.alert.id,
      'ALERT_DISABLED',
      null,
    );
    const before = notifications().length;
    harness.notifications.dispatch(delivery);
    await harness.notifications.drain();

    expect(notifications().length).toBe(before);
    expect(deliveryOf(created.alert.id)?.skippedReason).toBe('ALERT_DISABLED');
  });

  it('delivers through the Telegram adapter as well as Bale', async () => {
    // Telegram is enabled only when both the token and the channel are configured.
    const telegram = createUxHarness(
      notificationEnv({
        TELEGRAM_BOT_TOKEN: 'tg-token',
        TELEGRAM_CHANNEL_ID: 'tg-channel',
      }),
    );
    await seedMarketState(telegram, { receivedAt: new Date() });
    const user = await telegram.users.resolveUser(
      'telegram',
      'tg-user',
      'tg-chat-1',
    );

    const created = await telegram.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });
    if (!created.ok) {
      throw new Error('could not create the alert');
    }

    const delivery = await telegram.alerts.reserveTrigger(created.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_050_000,
      percent: null,
      observedAt: '2026-09-30T13:00:00.000Z',
      chatId: 'tg-chat-1',
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    telegram.notifications.dispatch(delivery);
    await telegram.notifications.drain();

    const sent = telegram.platform.calls.filter(
      (call) => call.kind === 'send' && call.chatId === 'tg-chat-1',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.platform).toBe('telegram');
    expect(telegram.alerts.findDelivery(created.alert.id)?.status).toBe('SENT');
  });

  it('records a failure when the platform is not configured', async () => {
    const single = createUxHarness(notificationEnv({ TELEGRAM_BOT_TOKEN: '' }));
    await seedMarketState(single, { receivedAt: new Date() });
    const user = await single.users.resolveUser(
      'telegram',
      'notify-telegram',
      CHAT_ID,
    );

    const created = await single.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });
    if (!created.ok) {
      throw new Error('could not create the alert');
    }

    const delivery = await single.alerts.reserveTrigger(created.alert.id, {
      reason: 'PRICE_ABOVE_REACHED',
      price: 18_050_000,
      percent: null,
      observedAt: '2026-09-30T13:00:00.000Z',
      chatId: CHAT_ID,
    });
    if (!delivery) {
      throw new Error('could not reserve the trigger');
    }

    single.notifications.dispatch(delivery);
    await single.notifications.drain();

    const stored = single.alerts.findDelivery(
      created.alert.id,
    ) as AlertDelivery;
    expect(stored.status).toBe('FAILED');
    expect(stored.lastError).toContain('not configured');
    expect(stored.attemptCount).toBe(0);
  });

  // --- restart policy ---------------------------------------------------------

  describe('after a restart (§61)', () => {
    it('resumes a delivery that was never attempted', async () => {
      const alert = await trigger();
      const delivery = deliveryOf(alert.id) as AlertDelivery;

      // Simulate "the process died before the first attempt".
      await harness.alerts.markUndeliverable(alert.id, null, null);
      await harness.alertStore.transact((tx) =>
        tx.saveDelivery({
          ...(tx.findDeliveryByAlert(alert.id) as AlertDelivery),
          status: 'PENDING',
          attemptCount: 0,
        }),
      );

      const resumed = await harness.notifications.recoverPending();
      await harness.notifications.drain();

      expect(resumed).toBe(1);
      expect(deliveryOf(alert.id)?.status).toBe('SENT');
      expect(delivery.id).toBe((deliveryOf(alert.id) as AlertDelivery).id);
    });

    it('does not resend an attempt whose outcome is unknown (no duplicate)', async () => {
      const alert = await trigger();
      // A persisted attempt with no recorded error means: "sent, but not confirmed".
      await harness.alertStore.transact((tx) =>
        tx.saveDelivery({
          ...(tx.findDeliveryByAlert(alert.id) as AlertDelivery),
          status: 'PENDING',
          attemptCount: 1,
          lastError: null,
          sentAt: null,
        }),
      );
      const before = notifications().length;

      const resumed = await harness.notifications.recoverPending();
      await harness.notifications.drain();

      expect(resumed).toBe(0);
      expect(notifications().length).toBe(before);
      const stored = deliveryOf(alert.id) as AlertDelivery;
      expect(stored.status).toBe('FAILED');
      expect(stored.skippedReason).toBe('DELIVERY_OUTCOME_UNKNOWN');
    });

    it('resumes a delivery whose last attempt is known to have failed', async () => {
      const alert = await trigger();
      await harness.alertStore.transact((tx) =>
        tx.saveDelivery({
          ...(tx.findDeliveryByAlert(alert.id) as AlertDelivery),
          status: 'PENDING',
          attemptCount: 1,
          lastError: 'HTTP 502 — Bad Gateway',
          sentAt: null,
        }),
      );
      const before = notifications().length;

      const resumed = await harness.notifications.recoverPending();
      await harness.notifications.drain();

      expect(resumed).toBe(1);
      expect(notifications().length).toBe(before + 1);
      expect(deliveryOf(alert.id)?.status).toBe('SENT');
      expect(deliveryOf(alert.id)?.attemptCount).toBe(2);
    });

    it('does nothing when there is no pending delivery', async () => {
      await trigger();
      const before = notifications().length;

      await expect(harness.notifications.recoverPending()).resolves.toBe(0);
      expect(notifications().length).toBe(before);
    });
  });
});

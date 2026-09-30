import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { tehranDateFa, tehranTimeFa } from '../common/tehran-time';
import { PlatformRegistry } from '../platform/platform-registry.service';
import { UserStore } from '../users/user.store';
import { AlertService } from './alert.service';
import { AlertStore } from './alert.store';
import { formatTriggerNotification } from './alert-format';
import { AlertDelivery } from './alert.types';

/**
 * Notification delivery for trigger records (Phase 3 §41–§47).
 *
 * Responsibilities: send exactly one notification per trigger record through the **existing**
 * platform abstraction, persist the delivery outcome, and retry a bounded number of times.
 *
 * Explicitly not a responsibility: deciding *whether* an alert fired (that is the evaluator +
 * trigger reservation), and never calling a platform API directly (§41).
 */
@Injectable()
export class AlertNotificationService {
  private readonly logger = new Logger(AlertNotificationService.name);
  /** In-flight dispatches, so tests and shutdown can wait for them deterministically. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfigService,
    private readonly alerts: AlertService,
    private readonly store: AlertStore,
    private readonly platformRegistry: PlatformRegistry,
    private readonly users: UserStore,
  ) {}

  get pendingCount(): number {
    return this.inFlight.size;
  }

  /** Wait until every queued/retrying dispatch has finished (tests, shutdown, diagnostics). */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Deliver a reserved trigger. Scheduling is fire-and-forget so a slow platform can never delay
   * the market cycle or the channel publication; the returned promise is tracked.
   */
  dispatch(delivery: AlertDelivery): void {
    const task = this.deliver(delivery).catch((error: unknown) => {
      // `deliver` handles its own errors; this is the last safety net (§46).
      this.logger.error(
        `Unexpected error while delivering alert ${delivery.alertId}: ${describeError(error)}`,
      );
    });

    this.inFlight.add(task);

    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  /** Attempt loop with bounded retries; total attempts = 1 + ALERT_NOTIFICATION_MAX_RETRIES. */
  private async deliver(delivery: AlertDelivery): Promise<void> {
    const maxAttempts = this.config.alertNotificationMaxRetries + 1;
    const retryDelay = this.config.alertNotificationRetryDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = this.store.findDeliveryByAlert(delivery.alertId);

      if (!current || current.status !== 'PENDING') {
        return;
      }

      // Re-verify eligibility *inside* the attempt: a delete/disable that landed after the
      // reservation must not produce a notification (§59, §60).
      const alert = this.store.findAlert(current.alertId);

      if (!alert || alert.status !== 'TRIGGERED') {
        await this.alerts.markUndeliverable(
          current.alertId,
          alert?.status === 'DELETED' ? 'ALERT_DELETED' : 'ALERT_DISABLED',
          null,
        );
        this.logger.warn(
          `Skipped the notification for alert ${current.alertId}: it is ${alert?.status ?? 'missing'}.`,
        );
        return;
      }

      // The adapter is resolved *before* an attempt is counted: an unconfigured platform is a
      // configuration problem, not a failed delivery, and must not consume an attempt.
      const adapter = this.platformRegistry.resolve(alert.platform);

      if (adapter === null) {
        await this.alerts.markUndeliverable(
          alert.id,
          null,
          `platform ${alert.platform} is not configured`,
        );
        this.logger.error(
          `Cannot deliver the notification for alert ${alert.id}: platform ${alert.platform} is not configured.`,
        );
        return;
      }

      const started = await this.alerts.beginAttempt(current.alertId);

      if (!started) {
        return;
      }

      const chatId = this.resolveChatId(alert.userId, alert.platform);
      const definition = this.alerts.definitionFor(alert.symbol);
      const text = formatTriggerNotification(
        started,
        alert,
        definition,
        this.config.displayUnit,
        this.tehranStamp(started.triggeredAt),
      );

      try {
        const result = await adapter.render({ chatId, text });

        if (result.success) {
          await this.alerts.markSent(alert.id);
          this.logger.log(
            `🔔 Notification sent for alert ${alert.id} (${alert.symbol}, ${started.reason}) ` +
              `on attempt ${started.attemptCount}/${maxAttempts}.`,
          );
          return;
        }

        const failed = await this.alerts.recordFailure(
          alert.id,
          result.error ?? 'unknown platform error',
        );

        this.logger.error(
          `Notification attempt ${failed?.attemptCount ?? attempt}/${maxAttempts} for alert ` +
            `${alert.id} failed: ${result.error ?? 'unknown platform error'}`,
        );
      } catch (error) {
        const failed = await this.alerts.recordFailure(
          alert.id,
          describeError(error),
        );

        this.logger.error(
          `Notification attempt ${failed?.attemptCount ?? attempt}/${maxAttempts} for alert ` +
            `${alert.id} threw: ${describeError(error)}`,
        );
      }

      if (attempt < maxAttempts && retryDelay > 0) {
        await delay(retryDelay);
      }
    }

    const exhausted = await this.alerts.markUndeliverable(
      delivery.alertId,
      delivery.skippedReason,
      'notification delivery failed after the maximum number of attempts',
    );

    this.logger.error(
      `❌ Notification for alert ${delivery.alertId} could not be delivered after ` +
        `${exhausted?.attemptCount ?? maxAttempts} attempt(s) — recorded as FAILED. The alert stays ` +
        'TRIGGERED and will not be retried automatically.',
    );
  }

  /**
   * Resume work after a restart (§61).
   *
   *  - a delivery that was never attempted, or whose last attempt is known to have failed, is
   *    safe to (re)send,
   *  - a delivery with a persisted attempt and no recorded error means the process died between
   *    "sent" and "persisted". It is **not** resent: sending twice is worse than reporting an
   *    unknown outcome, so it is recorded as failed and logged.
   */
  async recoverPending(): Promise<number> {
    const pending = this.store
      .listDeliveries()
      .filter((delivery) => delivery.status === 'PENDING');

    let resumed = 0;

    for (const delivery of pending) {
      if (delivery.attemptCount > 0 && delivery.lastError === null) {
        await this.alerts.markUndeliverable(
          delivery.alertId,
          'DELIVERY_OUTCOME_UNKNOWN',
          'delivery outcome unknown after a restart — not resent to avoid a duplicate notification',
        );
        this.logger.error(
          `Delivery ${delivery.id} for alert ${delivery.alertId} has an unknown outcome after ` +
            'restart; it will not be resent.',
        );
        continue;
      }

      this.dispatch(delivery);
      resumed += 1;
    }

    if (resumed > 0) {
      this.logger.warn(
        `Resumed ${resumed} pending notification(s) after restart.`,
      );
    }

    return resumed;
  }

  /**
   * Delivery target: the last chat the user interacted from (stored by the user layer), falling
   * back to the platform identity — the bot can never guess a chat it has not seen.
   */
  private resolveChatId(
    userId: string,
    platform: AlertDelivery['platform'],
  ): string {
    const user = this.users.findUser(userId);

    if (user && user.platform === platform && user.chatId) {
      return user.chatId;
    }

    return user?.platformUserId ?? '';
  }

  private tehranStamp(iso: string): string | null {
    const date = new Date(iso);

    return Number.isNaN(date.getTime())
      ? null
      : `${tehranDateFa(date)} — ${tehranTimeFa(date)}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

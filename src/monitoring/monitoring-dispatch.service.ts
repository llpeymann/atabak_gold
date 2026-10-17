/**
 * Phase 11 — notification dispatcher (§3.4, §12).
 *
 * The outbox row already exists before this service runs, so a crash between “we decided to tell
 * somebody” and “the message left” loses nothing: the row is still `PENDING` and the next sweep
 * picks it up.
 *
 * Delivery semantics are the platform's, not ours:
 *
 *  * the platform accepting the call ⇒ `SENT` (“accepted”, never “read”);
 *  * an explicit transient refusal (5xx / 429) ⇒ `RETRY_PENDING` with bounded backoff, and a
 *    rate-limit answer never consumes an attempt;
 *  * a permanent refusal ⇒ `FAILED` (no infinite retry);
 *  * no answer at all ⇒ `UNKNOWN` — the message may exist, so it is never re-sent automatically.
 *
 * When every attempt is exhausted the service reports the failure through the engine, so “the
 * monitor cannot reach a human” becomes a durable incident of its own instead of a log line.
 */

import { Injectable, Logger } from '@nestjs/common';

import { describeError, redactSecrets, truncate } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { PlatformRegistry } from '../platform/platform-registry.service';
import { MonitoringService } from './monitoring.service';
import { MonitoringStore } from './monitoring.store';
import { MonitorNotification } from './monitoring.types';

const RATE_LIMIT_SIGNATURE =
  /429|too many requests|rate limit|retry after|flood/iu;

export interface DispatchResult {
  processed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  unknown: number;
  rateLimited: boolean;
  /** `true` when the batch was cut short by a rate limit — the caller should slow down. */
  stoppedEarly: boolean;
}

@Injectable()
export class MonitoringDispatchService {
  private readonly logger = new Logger(MonitoringDispatchService.name);
  private running = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly store: MonitoringStore,
    private readonly monitoring: MonitoringService,
    private readonly registry: PlatformRegistry,
  ) {}

  /**
   * Send the notifications that are due, oldest first, at most `batchSize` per call.
   *
   * A `running` flag prevents two overlapping dispatches (a slow sweep plus a restart-triggered
   * one) from sending the same row twice (§12.4, §18.7).
   */
  async processDue(now: Date = new Date()): Promise<DispatchResult> {
    const result: DispatchResult = {
      processed: 0,
      sent: 0,
      retryScheduled: 0,
      failed: 0,
      unknown: 0,
      rateLimited: false,
      stoppedEarly: false,
    };

    if (!this.monitoring.enabled || this.running) {
      return result;
    }

    this.running = true;

    try {
      const batch = this.store
        .dueNotifications(now)
        .slice(0, this.config.monitoringNotificationBatchSize);

      for (const notification of batch) {
        result.processed += 1;

        const outcome = await this.send(notification, now);

        switch (outcome) {
          case 'SENT':
            result.sent += 1;
            break;
          case 'RETRY':
            result.retryScheduled += 1;
            break;
          case 'FAILED':
            result.failed += 1;
            break;
          case 'UNKNOWN':
            result.unknown += 1;
            break;
          case 'RATE_LIMITED':
            result.rateLimited = true;
            result.stoppedEarly = true;

            // The platform explicitly asked for a pause: stop the whole batch, keep the row
            // pending and try again after the backoff.
            return result;
          default:
            break;
        }

        if (this.config.monitoringNotificationMinIntervalMs > 0) {
          await delay(this.config.monitoringNotificationMinIntervalMs);
        }
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  private async send(
    notification: MonitorNotification,
    now: Date,
  ): Promise<'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN' | 'RATE_LIMITED'> {
    const adapter = this.registry.resolve(notification.platform);

    if (!adapter) {
      // A platform that is not configured cannot be retried into existence; report and stop.
      await this.finish(notification, {
        status: 'FAILED',
        error: `platform ${notification.platform} is not configured`,
        at: now,
      });

      return 'FAILED';
    }

    const attemptCount = notification.attemptCount + 1;

    try {
      const result = await adapter.render({
        chatId: notification.chatId,
        text: notification.text,
      });

      if (result.success) {
        await this.finish(notification, {
          status: 'SENT',
          attemptCount,
          at: now,
        });

        return 'SENT';
      }

      const error = truncate(
        redactSecrets(result.error ?? 'platform refused the message', []),
        200,
      );

      if (RATE_LIMIT_SIGNATURE.test(error)) {
        // Rate limiting is not the notification's fault: keep the attempt count and back off.
        await this.monitoring.recordNotificationResult({
          notificationId: notification.notificationId,
          status: 'RETRY_PENDING',
          attemptCount: notification.attemptCount,
          error,
          at: now,
        });

        return 'RATE_LIMITED';
      }

      if (attemptCount >= this.config.monitoringNotificationMaxAttempts) {
        await this.finish(notification, {
          status: 'FAILED',
          attemptCount,
          error,
          at: now,
        });

        return 'FAILED';
      }

      await this.monitoring.recordNotificationResult({
        notificationId: notification.notificationId,
        status: 'RETRY_PENDING',
        attemptCount,
        error,
        at: now,
      });

      return 'RETRY';
    } catch (error) {
      // No answer came back: the message may already be on the user's screen.
      const message = truncate(redactRejected(describeError(error)), 200);

      if (attemptCount >= this.config.monitoringNotificationMaxAttempts) {
        await this.finish(notification, {
          status: 'UNKNOWN',
          attemptCount,
          error: message,
          at: now,
        });

        return 'UNKNOWN';
      }

      await this.monitoring.recordNotificationResult({
        notificationId: notification.notificationId,
        status: 'RETRY_PENDING',
        attemptCount,
        error: message,
        at: now,
      });

      return 'RETRY';
    }
  }

  /** Persist the final outcome and, when it is a real failure, record it as an incident. */
  private async finish(
    notification: MonitorNotification,
    input: {
      status: 'SENT' | 'FAILED' | 'UNKNOWN';
      attemptCount?: number;
      error?: string | null;
      at: Date;
    },
  ): Promise<void> {
    await this.monitoring.recordNotificationResult({
      notificationId: notification.notificationId,
      status: input.status,
      attemptCount: input.attemptCount ?? notification.attemptCount,
      error: input.error ?? null,
      at: input.at,
    });

    if (input.status === 'SENT') {
      this.logger.log(
        `Monitoring notification ${notification.notificationId} accepted by ${notification.platform}.`,
      );

      return;
    }

    this.logger.error(
      `Monitoring notification ${notification.notificationId} ended as ${input.status}: ${
        input.error ?? 'no detail'
      }`,
    );

    await this.monitoring.onNotificationPipelineFailure({
      notificationId: notification.notificationId,
      error: input.error ?? `notification ended as ${input.status}`,
      at: input.at,
    });
  }
}

function redactRejected(value: string): string {
  return redactSecrets(value, []);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import { PlatformRegistry } from '../platform/platform-registry.service';
import { UserStore } from '../users/user.store';
import { SalesStore } from './sales.store';
import { SalesService } from './sales.service';
import { NotificationKind, SalesNotificationRecord } from './sales.types';
import {
  formatAdminLeadNotification,
  formatCustomerConfirmation,
} from './sales-format';

/** What has to be delivered once a lead is durably stored (§8, §9). */
export interface LeadNotificationRequest {
  leadId: string;
  platform: Platform;
  /** The customer's own target (the chat the request came from). */
  customer: { userId: string; targetUserId: string; chatId: string | null };
}

/**
 * Notification delivery for leads (Phase 9 §8, §9).
 *
 * Same shape as the alert outbox the project already uses (reserve → attempt → persist the real
 * outcome → bounded retry), because inventing a second delivery mechanism for the same job would be
 * a second source of truth about what actually reached a human:
 *
 *  - one persisted row per (lead, recipient), keyed `admin:<leadId>:<platform>:<userId>` or
 *    `customer:<leadId>` — a retry can therefore never produce a duplicate message (§9.2);
 *  - the *lead* and the *delivery* are separate states: neither a failed admin notification nor a
 *    failed customer message can undo, hide or roll back the persisted lead (§8.3, §9.3);
 *  - a restart never resends a delivery whose outcome is unknown (that would be a duplicate
 *    message); it is recorded as `UNDELIVERABLE` with the reason instead.
 *
 * Explicitly not a responsibility: deciding that a lead exists (that is `SalesService`, after a
 * successful write) and talking to a platform API directly (that is `PlatformRegistry`).
 */
@Injectable()
export class SalesNotificationService implements OnModuleInit {
  private readonly logger = new Logger(SalesNotificationService.name);
  /** In-flight dispatches, so tests and shutdown can wait for them deterministically. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfigService,
    private readonly store: SalesStore,
    private readonly sales: SalesService,
    private readonly platformRegistry: PlatformRegistry,
    private readonly users: UserStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureLoaded();

    // A delivery interrupted by a restart is resumed exactly once (§9.2).
    await this.recoverPending();
  }

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
   * Persist the notifications that belong to a stored lead, then return them.
   *
   * Called **after** the lead write succeeded. A failure here is reported to the caller and logged,
   * but it never invalidates the lead: the customer still has the reference and the operators can
   * pick the lead up from the admin list (§8.3).
   */
  async enqueueForLead(
    request: LeadNotificationRequest,
  ): Promise<SalesNotificationRecord[]> {
    const lead = this.sales.findLead(request.leadId);

    if (!lead) {
      this.logger.error(
        `Refused to enqueue notifications for an unknown lead (${request.leadId}).`,
      );
      return [];
    }

    const recipients: {
      kind: NotificationKind;
      key: string;
      targetUserId: string;
      text: string;
    }[] = [
      {
        kind: 'CUSTOMER',
        key: `customer:${lead.leadId}`,
        targetUserId: request.customer.targetUserId,
        text: formatCustomerConfirmation(lead),
      },
    ];

    for (const admin of this.adminTargets(request.platform)) {
      recipients.push({
        kind: 'ADMIN',
        key: `admin:${lead.leadId}:${request.platform}:${admin}`,
        targetUserId: admin,
        text: formatAdminLeadNotification(lead),
      });
    }

    const now = new Date().toISOString();
    const created: SalesNotificationRecord[] = [];

    try {
      await this.store.transact((tx) => {
        for (const recipient of recipients) {
          const existing = tx.findNotificationByKey(recipient.key);

          if (existing) {
            // Already reserved (a retried confirmation). The text is never rewritten: what the
            // customer received stays a matter of record.
            created.push(existing);
            continue;
          }

          const record: SalesNotificationRecord = {
            notificationId: tx.nextId('ntf'),
            key: recipient.key,
            leadId: lead.leadId,
            reference: lead.reference,
            kind: recipient.kind,
            platform: request.platform,
            targetUserId: recipient.targetUserId,
            status: 'PENDING',
            attemptCount: 0,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            sentAt: null,
          };

          tx.saveNotification(record);
          created.push(record);
        }
      });
    } catch (error) {
      this.logger.error(
        `Could not persist notification rows for lead ${lead.reference}: ${describeError(error)}. ` +
          'The lead itself is stored and visible in the admin list.',
      );
      return [];
    }

    return created;
  }

  /** Every persisted notification row (read-only), used by the admin report (§10.6). */
  listNotifications(): SalesNotificationRecord[] {
    return this.store.listNotifications();
  }

  /** Queue every `PENDING` row of a lead for delivery (fire-and-forget, tracked). */
  dispatchForLead(leadId: string): number {
    const pending = this.store
      .listNotifications()
      .filter(
        (record) => record.leadId === leadId && record.status === 'PENDING',
      );

    for (const record of pending) {
      this.dispatch(record);
    }

    return pending.length;
  }

  /**
   * Deliver a reserved notification. Scheduling is fire-and-forget so a slow platform can never
   * delay the customer's answer; the returned promise is tracked for `drain()`.
   */
  dispatch(record: SalesNotificationRecord): void {
    const task = this.deliver(record.notificationId).catch((error: unknown) => {
      // `deliver` handles its own errors; this is the last safety net.
      this.logger.error(
        `Unexpected error while delivering notification ${record.notificationId}: ` +
          describeError(error),
      );
    });

    this.inFlight.add(task);

    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  /** Attempt loop with bounded retries; total attempts = SALES_NOTIFICATION_MAX_ATTEMPTS. */
  private async deliver(notificationId: string): Promise<void> {
    const maxAttempts = this.config.salesNotificationMaxAttempts;
    const retryDelay = this.config.salesNotificationRetryDelayMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = this.store.findNotification(notificationId);

      if (!current || current.status !== 'PENDING') {
        return;
      }

      const adapter = this.platformRegistry.resolve(current.platform);

      if (!adapter) {
        await this.markUndeliverable(
          current,
          `سکوی ${current.platform} برای ارسال پیام در دسترس نیست.`,
        );
        return;
      }

      const chatId = this.resolveChatId(current);
      const started = await this.beginAttempt(current);

      if (!started) {
        return;
      }

      try {
        const result = await adapter.render({ chatId, text: started.text });

        if (result.success) {
          await this.markSent(started.record);
          // The activity row records that the message was delivered — never that the lead or a
          // sale happened (nothing here is a sale event, §11.1).
          await this.sales.recordNotificationActivity(
            started.record,
            'ADMIN_NOTIFIED',
            `اطلاع‌رسانی به ${
              started.record.kind === 'ADMIN' ? 'کارشناس' : 'مشتری'
            } انجام شد.`,
          );
          this.logger.log(
            `🔔 Lead notification ${started.record.reference} (${started.record.kind}) delivered ` +
              `on attempt ${started.record.attemptCount}/${maxAttempts}.`,
          );
          return;
        }

        const failed = await this.markFailed(
          started.record,
          result.error ?? 'unknown platform error',
        );

        this.logger.error(
          `Lead notification ${started.record.reference} (${started.record.kind}) attempt ` +
            `${failed?.attemptCount ?? attempt}/${maxAttempts} failed: ` +
            `${result.error ?? 'unknown platform error'}`,
        );
      } catch (error) {
        const failed = await this.markFailed(
          started.record,
          describeError(error),
        );

        this.logger.error(
          `Lead notification ${started.record.reference} (${started.record.kind}) attempt ` +
            `${failed?.attemptCount ?? attempt}/${maxAttempts} threw: ${describeError(error)}`,
        );
      }

      if (attempt < maxAttempts && retryDelay > 0) {
        await delay(retryDelay);
      }
    }

    const stale = this.store.findNotification(notificationId);

    if (stale && stale.status !== 'SENT') {
      await this.markUndeliverable(
        stale,
        `ارسال پس از ${maxAttempts} تلاش ناموفق ماند.`,
      );
      this.logger.error(
        `❌ Notification ${stale.reference} (${stale.kind}) could not be delivered after ` +
          `${stale.attemptCount} attempt(s) — recorded as FAILED. The lead stays stored and the ` +
          'customer keeps their tracking code.',
      );
    }
  }

  /**
   * Resume work after a restart (§9.2).
   *
   *  - a row that was never attempted, or whose last attempt is known to have failed, is safe to
   *    retry,
   *  - a row with a persisted attempt and no recorded error means the process died between “sent”
   *    and “persisted”. It is **not** resent: a duplicate message is worse than an unknown outcome,
   *    so it is recorded as undeliverable with that exact reason.
   */
  async recoverPending(): Promise<number> {
    const pending = this.store
      .listNotifications()
      .filter((record) => record.status === 'PENDING');

    let resumed = 0;

    for (const record of pending) {
      if (record.attemptCount > 0 && record.lastError === null) {
        await this.markUndeliverable(
          record,
          'نتیجه ارسال پس از راه‌اندازی مجدد نامشخص است؛ برای پرهیز از ارسال تکراری دوباره فرستاده نشد.',
        );
        this.logger.error(
          `Notification ${record.notificationId} (${record.reference}) has an unknown outcome ` +
            'after restart; it will not be resent.',
        );
        continue;
      }

      this.dispatch(record);
      resumed += 1;
    }

    if (resumed > 0) {
      this.logger.warn(`Resumed ${resumed} pending lead notification(s).`);
    }

    return resumed;
  }

  /** Persisted attempt counter, written before the platform call (§9.2). */
  private async beginAttempt(
    record: SalesNotificationRecord,
  ): Promise<{ record: SalesNotificationRecord; text: string } | null> {
    const lead = this.sales.findLead(record.leadId);
    const text = lead
      ? record.kind === 'ADMIN'
        ? formatAdminLeadNotification(lead)
        : formatCustomerConfirmation(lead)
      : null;

    if (!lead || text === null) {
      await this.markUndeliverable(
        record,
        'پرونده درخواست پیدا نشد؛ پیام ارسال نشد.',
      );
      return null;
    }

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findNotification(record.notificationId);

        if (!current || current.status !== 'PENDING') {
          return null;
        }

        const next: SalesNotificationRecord = {
          ...current,
          attemptCount: current.attemptCount + 1,
          lastError: null,
          updatedAt: new Date().toISOString(),
        };

        tx.saveNotification(next);

        return next;
      });

      return updated ? { record: updated, text } : null;
    } catch (error) {
      this.logger.error(
        `Could not persist the delivery attempt for ${record.reference}: ${describeError(error)}`,
      );
      return null;
    }
  }

  private async markSent(record: SalesNotificationRecord): Promise<void> {
    await this.writeState(record, {
      status: 'SENT',
      sentAt: new Date().toISOString(),
      lastError: null,
    });
  }

  private async markFailed(
    record: SalesNotificationRecord,
    reason: string,
  ): Promise<SalesNotificationRecord | null> {
    // The failure is recorded truthfully; it is never reported as a success (§9.3).
    return this.writeState(record, { status: 'PENDING', lastError: reason });
  }

  private async markUndeliverable(
    record: SalesNotificationRecord,
    reason: string,
  ): Promise<SalesNotificationRecord | null> {
    const updated = await this.writeState(record, {
      status: 'UNDELIVERABLE',
      lastError: reason,
    });

    if (updated) {
      await this.sales.recordNotificationActivity(
        updated,
        'NOTIFICATION_FAILED',
        `اطلاع‌رسانی به ${
          updated.kind === 'ADMIN' ? 'کارشناس' : 'مشتری'
        } تحویل نشد.`,
      );
    }

    return updated;
  }

  private async writeState(
    record: SalesNotificationRecord,
    patch: Partial<SalesNotificationRecord>,
  ): Promise<SalesNotificationRecord | null> {
    try {
      return await this.store.transact((tx) => {
        const current = tx.findNotification(record.notificationId);

        if (!current) {
          return null;
        }

        const next: SalesNotificationRecord = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };

        tx.saveNotification(next);

        return next;
      });
    } catch (error) {
      this.logger.error(
        `Could not persist the delivery state of ${record.reference}: ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Authorized destinations, resolved from configuration only: the Sales Engine never invents a
   * recipient. An empty allow-list means “no admin notification target” — which is logged as a real
   * gap instead of pretending the message went somewhere (§9.1, §16).
   */
  private adminTargets(platform: Platform): string[] {
    const admins = this.sales.adminIds;

    if (admins.length === 0) {
      return [];
    }

    return admins
      .map((entry) => {
        const [head, ...tail] = entry.split(':');

        if (tail.length === 1 && (head === 'bale' || head === 'telegram')) {
          return head === platform ? tail[0] : null;
        }

        return head;
      })
      .filter(
        (entry): entry is string => typeof entry === 'string' && entry !== '',
      );
  }

  /**
   * Delivery target: the chat the customer actually wrote from, falling back to the identity the
   * stored lead carries. A chat the bot has never seen is never guessed.
   */
  private resolveChatId(record: SalesNotificationRecord): string {
    const user = this.users.findUserByPlatform(
      record.platform,
      record.targetUserId,
    );
    const chatId = user?.chatId ?? null;

    if (chatId) {
      return chatId;
    }

    return record.targetUserId;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

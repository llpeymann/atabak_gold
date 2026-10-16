/**
 * Phase 10 — broadcast (§11).
 *
 * The whole feature exists to send one operational text message to a *known, reachable* set of
 * identities, at a safe rate, with a durable record of what actually happened. The design choices:
 *
 *  * **Real recipients only.** The audience is derived from stored identities (Phase 2) that have a
 *    usable `chatId`, filtered by the selected rule. Nothing is fabricated, no test address is
 *    invented, and the count shown before confirmation is produced by *the same function* that the
 *    send path uses — a preview that can disagree with the send would be a lie.
 *  * **Explicit consent.** The final confirmation is a separate, deliberate step: the job is
 *    persisted as `PREPARED` first, and only a confirmation turns it into `RUNNING`. Nothing is sent
 *    before it.
 *  * **Reuse, not a second queue.** There is no new message broker: the durable job plus a bounded
 *    worker tick on the project's existing scheduler is the same pattern Phase 5 uses for
 *    publications.
 *  * **Honest outcomes.** `SENT` means the platform accepted the message (and the returned message id
 *    is stored as evidence). A request whose answer never arrived is `UNKNOWN` and is *never* retried
 *    automatically — a duplicate message is worse than an unknown.
 *  * **A cancel is not a recall.** Cancelling stops the remaining recipients; messages already
 *    accepted by the platform cannot be taken back, and the report says exactly that.
 *
 * Consent limitation (documented, not hidden): this deployment has no user-facing opt-out model. The
 * eligibility rule honours a `broadcastOptOut` flag when a stored identity carries one, and the
 * audience screen prints every exclusion bucket, so the operator always sees whether anything was
 * dropped and why. The limitation itself is printed in the broadcast screen and in the phase report
 * (§11.1, §21 “no uncontrolled bulk messaging”).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { describeError, truncate } from '../common/log-safety';
import { tehranDayKey } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import { PlatformRegistry } from '../platform/platform-registry.service';
import { PlatformSendResult } from '../platform/platform.types';
import { User } from '../users/user.types';
import { UserStore } from '../users/user.store';
import { AdminActivityService } from './admin-activity.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminErrorService } from './admin-error.service';
import { AdminStore } from './admin.store';
import { shiftDayKey } from './admin-period';
import {
  AdminOutcome,
  AdminRole,
  BroadcastAudience,
  BroadcastAudiencePreview,
  BroadcastJob,
  BroadcastRecipient,
  BroadcastRecipientStatus,
  BroadcastReport,
  adminFail,
  adminOk,
} from './admin.types';

export type SendOutcome =
  'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'UNKNOWN' | 'RATE_LIMITED';

export interface BroadcastTickResult {
  processed: number;
  sent: number;
  failed: number;
  retryScheduled: number;
  unknown: number;
  rateLimited: boolean;
  jobCompleted: string | null;
}

/** Who performed an audited action (a real administrator, or a system-driven step). */
export interface AuditActor {
  key: string;
  role: AdminRole | 'SYSTEM';
}

/** Signature of a platform error that means “slow down”, not “this message is broken”. */
const RATE_LIMIT_SIGNATURE =
  /429|too many requests|rate limit|retry after|flood/iu;

@Injectable()
export class AdminBroadcastService implements OnModuleInit {
  private readonly logger = new Logger(AdminBroadcastService.name);
  private ticking = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly store: AdminStore,
    private readonly users: UserStore,
    private readonly registry: PlatformRegistry,
    private readonly activity: AdminActivityService,
    private readonly audit: AdminAuditService,
    private readonly errors: AdminErrorService,
  ) {}

  get enabled(): boolean {
    return this.config.adminBroadcastEnabled;
  }

  async onModuleInit(): Promise<void> {
    await this.store.ensureLoaded();

    for (const job of this.store
      .listBroadcasts()
      .filter((stored) => stored.status === 'RUNNING')) {
      // The job is durable, so a restart continues it at the configured rate instead of losing it —
      // and instead of dumping thousands of messages at once.
      this.logger.warn(
        `Broadcast ${job.reference} is still RUNNING after a restart — the worker resumes it in ` +
          'bounded batches (nothing is re-sent to a recipient that already has an outcome).',
      );
    }
  }

  // --- audience (§11.1) ----------------------------------------------------------

  audienceLabel(audience: BroadcastAudience): string {
    switch (audience.kind) {
      case 'ALL':
        return 'همهٔ هویت‌های قابل‌دسترس';
      case 'PLATFORM':
        return `فقط پلتفرم ${audience.platform ?? '—'}`;
      case 'ACTIVE_LAST_DAYS':
        return `فعال در ${audience.days ?? 0} روز اخیر`;
      case 'INACTIVE_LAST_DAYS':
        return `غیرفعال در ${audience.days ?? 0} روز اخیر`;
      default:
        return 'نامشخص';
    }
  }

  /** Parse the audience the administrator picked (used by the conversation flow). */
  parseAudience(
    kind: string,
    options: { platform?: string | null; days?: string | null } = {},
  ): BroadcastAudience | null {
    const rawDays = Number(options.days ?? Number.NaN);
    const days =
      Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 365
        ? Math.floor(rawDays)
        : null;

    switch (kind) {
      case 'ALL':
        return { kind: 'ALL', platform: null, days: null };
      case 'PLATFORM': {
        const platform =
          options.platform === 'telegram'
            ? 'telegram'
            : options.platform === 'bale'
              ? 'bale'
              : null;

        return platform === null
          ? null
          : { kind: 'PLATFORM', platform, days: null };
      }
      case 'ACTIVE_LAST_DAYS':
      case 'INACTIVE_LAST_DAYS':
        return days === null ? null : { kind, platform: null, days };
      default:
        return null;
    }
  }

  /**
   * The **single** eligibility rule: used by the preview *and* by the send path, so the number an
   * administrator confirms is the number that gets sent to (§11.1).
   */
  resolveAudience(
    audience: BroadcastAudience,
    now: Date = new Date(),
  ): BroadcastAudiencePreview {
    const excluded = new Map<string, number>();
    const recipients: BroadcastAudiencePreview['recipients'] = [];
    const seen = new Set<string>();
    const window = this.activityWindow(audience, now);

    for (const user of this.users.listUsers()) {
      const identityKey = `${user.platform}:${user.platformUserId}`;

      if (seen.has(identityKey)) {
        bump(excluded, 'هویت تکراری در سند کاربران');
        continue;
      }

      seen.add(identityKey);

      if (audience.kind === 'PLATFORM' && user.platform !== audience.platform) {
        continue;
      }

      if (window !== null) {
        const days = this.activity.daysOf(identityKey);

        if (days.length === 0) {
          // No activity data at all (identity registered before Phase 10 recorded activity days):
          // the operator sees that this rule cannot classify such an identity yet.
          bump(excluded, 'بدون دادهٔ فعالیت (پیش از فاز ۱۰)');
          continue;
        }

        const activeInWindow = days.some(
          (day) => day >= window.fromDayKey && day <= window.toDayKey,
        );

        if (audience.kind === 'ACTIVE_LAST_DAYS' && !activeInWindow) {
          continue;
        }

        if (audience.kind === 'INACTIVE_LAST_DAYS' && activeInWindow) {
          continue;
        }
      }

      if (isOptedOut(user)) {
        bump(excluded, 'لغو اشتراک (opt-out)');
        continue;
      }

      const chatId = typeof user.chatId === 'string' ? user.chatId.trim() : '';

      if (chatId === '') {
        bump(excluded, 'بدون chatId قابل‌دسترس');
        continue;
      }

      if (!isPlausibleChatId(chatId)) {
        bump(excluded, 'chatId نامعتبر');
        continue;
      }

      recipients.push({
        userId: user.id,
        identityKey,
        platform: user.platform,
        chatId,
      });
    }

    recipients.sort((left, right) =>
      left.identityKey.localeCompare(right.identityKey),
    );

    const limit = this.config.adminBroadcastMaxRecipients;

    return {
      audience,
      label: this.audienceLabel(audience),
      recipients,
      excluded: [...excluded.entries()].map(([reason, count]) => ({
        reason,
        count,
      })),
      limitExceeded: recipients.length > limit,
      limit,
    };
  }

  // --- workflow (§11.2) ----------------------------------------------------------

  /** Step 1: validate and persist the job as `PREPARED`. Nothing is sent. */
  async prepare(input: {
    actor: AuditActor;
    text: string;
    audience: BroadcastAudience;
  }): Promise<AdminOutcome<BroadcastJob>> {
    if (!this.enabled) {
      return adminFail(
        'DISABLED',
        'ارسال گروهی در تنظیمات خاموش است (ADMIN_BROADCAST_ENABLED=false).',
      );
    }

    const text = input.text.trim();

    if (text === '') {
      return adminFail('INVALID_INPUT', 'متن پیام خالی است.');
    }

    if (text.length > this.config.adminBroadcastMaxLength) {
      return adminFail(
        'INVALID_INPUT',
        `متن پیام بیش از حد بلند است (حداکثر ${this.config.adminBroadcastMaxLength} نویسه).`,
      );
    }

    const preview = this.resolveAudience(input.audience);

    if (preview.recipients.length === 0) {
      return adminFail(
        'INVALID_INPUT',
        'هیچ گیرندهٔ واجد شرطی برای این مخاطبان پیدا نشد؛ چیزی برای ارسال وجود ندارد.',
      );
    }

    if (preview.limitExceeded) {
      return adminFail(
        'LIMIT_EXCEEDED',
        `تعداد گیرندگان (${preview.recipients.length}) از سقف مجاز (${preview.limit}) بیشتر است. ` +
          'مخاطبان را محدودتر کنید.',
      );
    }

    const now = new Date().toISOString();

    try {
      const job = await this.store.transact((tx) => {
        const broadcastId = tx.nextId('bc');
        const created: BroadcastJob = {
          broadcastId,
          reference: buildReference(broadcastId),
          createdBy: input.actor.key,
          createdAt: now,
          text,
          audience: input.audience,
          audienceLabel: `${this.audienceLabel(input.audience)} · ${
            preview.recipients.length
          } گیرنده`,
          status: 'PREPARED',
          confirmedBy: null,
          confirmedAt: null,
          nextAttemptAfter: null,
          completedAt: null,
          cancelledBy: null,
          cancelledAt: null,
          totalRecipients: preview.recipients.length,
          retryCount: 0,
          lastError: null,
        };

        tx.saveBroadcast(created);

        for (const recipient of preview.recipients) {
          // Per-recipient dedup key inside the critical section: the same identity can never be
          // enqueued twice for one broadcast (§11.4).
          if (tx.hasRecipientKey(created.broadcastId, recipient.identityKey)) {
            continue;
          }

          tx.saveRecipient({
            recipientId: tx.nextId('bcr'),
            broadcastId: created.broadcastId,
            userId: recipient.userId,
            identityKey: recipient.identityKey,
            platform: recipient.platform,
            chatId: recipient.chatId,
            status: 'PENDING',
            attemptCount: 0,
            sentAt: null,
            lastAttemptAt: null,
            lastError: null,
            externalMessageId: null,
            nextAttemptAt: null,
          });
        }

        return created;
      });

      await this.audit.record({
        actor: input.actor.key,
        role: input.actor.role,
        action: 'BROADCAST_PREPARED',
        targetType: 'broadcast',
        targetRef: job.reference,
        result: 'OK',
        toState: 'PREPARED',
        reason: `${job.audienceLabel} · ${job.text.length} نویسه`,
        correlationId: job.broadcastId,
      });

      this.logger.log(
        `📨 Broadcast ${job.reference} prepared for ${job.totalRecipients} recipient(s) — waiting ` +
          'for an explicit confirmation (nothing sent yet).',
      );

      return adminOk(job);
    } catch (error) {
      await this.errors.record({
        source: 'broadcast',
        category: 'PREPARE_FAILED',
        severity: 'HIGH',
        summary: `ثبت پیش‌نویس ارسال گروهی ناموفق بود: ${describeError(error)}`,
        retryable: true,
      });

      return adminFail(
        'PERSISTENCE_FAILED',
        'ثبت پیش‌نویس ارسال گروهی انجام نشد.',
      );
    }
  }

  /**
   * Step 2: the explicit confirmation. The job becomes `RUNNING` and the worker starts sending at the
   * configured rate. Idempotent for an already-running job.
   */
  async confirm(
    reference: string,
    actor: AuditActor,
  ): Promise<AdminOutcome<BroadcastJob>> {
    const existing = this.store.findBroadcastByReference(reference);

    if (!existing) {
      return adminFail('NOT_FOUND', 'این ارسال گروهی پیدا نشد.');
    }

    if (existing.status === 'RUNNING') {
      return adminOk(existing);
    }

    if (existing.status !== 'PREPARED') {
      return adminFail(
        'CONFLICT',
        `این ارسال در وضعیت ${existing.status} است و قابل تأیید نیست.`,
      );
    }

    const now = new Date().toISOString();

    try {
      const job = await this.store.transact((tx) => {
        const current = tx.findBroadcast(existing.broadcastId);

        if (!current || current.status !== 'PREPARED') {
          return null;
        }

        const updated: BroadcastJob = {
          ...current,
          status: 'RUNNING',
          confirmedBy: actor.key,
          confirmedAt: now,
        };

        tx.saveBroadcast(updated);

        return updated;
      });

      if (!job) {
        return adminFail(
          'CONFLICT',
          'وضعیت این ارسال تغییر کرد؛ دوباره بررسی کنید.',
        );
      }

      await this.audit.record({
        actor: actor.key,
        role: actor.role,
        action: 'BROADCAST_CONFIRMED',
        targetType: 'broadcast',
        targetRef: job.reference,
        result: 'OK',
        fromState: 'PREPARED',
        toState: 'RUNNING',
        reason: `${job.totalRecipients} گیرنده`,
        correlationId: job.broadcastId,
      });

      // No send happens here: the worker tick owns the actual delivery, so a long confirmation can
      // never block the bot loop (§16).
      return adminOk(job);
    } catch (error) {
      this.logger.error(
        `Could not confirm broadcast ${reference}: ${describeError(error)}`,
      );

      return adminFail('PERSISTENCE_FAILED', 'تأیید ارسال گروهی ذخیره نشد.');
    }
  }

  /** Step 3: cancel. Stops the remaining recipients; already accepted messages are not recalled. */
  async cancel(
    reference: string,
    actor: AuditActor,
  ): Promise<AdminOutcome<{ job: BroadcastJob; skipped: number }>> {
    const existing = this.store.findBroadcastByReference(reference);

    if (!existing) {
      return adminFail('NOT_FOUND', 'این ارسال گروهی پیدا نشد.');
    }

    if (existing.status !== 'RUNNING' && existing.status !== 'PREPARED') {
      return adminFail(
        'CONFLICT',
        `این ارسال در وضعیت ${existing.status} است و لغو نمی‌شود.`,
      );
    }

    const now = new Date().toISOString();
    const fromState = existing.status;

    try {
      const result = await this.store.transact((tx) => {
        const current = tx.findBroadcast(existing.broadcastId);

        if (!current) {
          return null;
        }

        let skipped = 0;

        for (const recipient of tx.listRecipients(current.broadcastId)) {
          if (recipient.status === 'PENDING') {
            tx.saveRecipient({ ...recipient, status: 'SKIPPED' });
            skipped += 1;
          }
        }

        const updated: BroadcastJob = {
          ...current,
          status: 'CANCELLED',
          cancelledBy: actor.key,
          cancelledAt: now,
          completedAt: now,
        };

        tx.saveBroadcast(updated);

        return { job: updated, skipped };
      });

      if (!result) {
        return adminFail('NOT_FOUND', 'این ارسال گروهی پیدا نشد.');
      }

      await this.audit.record({
        actor: actor.key,
        role: actor.role,
        action: 'BROADCAST_CANCELLED',
        targetType: 'broadcast',
        targetRef: result.job.reference,
        result: 'OK',
        fromState,
        toState: 'CANCELLED',
        reason: `${result.skipped} گیرندهٔ ارسال‌نشده متوقف شد`,
        correlationId: result.job.broadcastId,
      });

      return adminOk(result);
    } catch (error) {
      this.logger.error(
        `Could not cancel broadcast ${reference}: ${describeError(error)}`,
      );

      return adminFail('PERSISTENCE_FAILED', 'لغو ارسال گروهی ذخیره نشد.');
    }
  }

  /** Retry the recipients that *failed* (never `SENT`, never `UNKNOWN`, §11.4). */
  async retry(
    reference: string,
    actor: AuditActor,
  ): Promise<AdminOutcome<{ job: BroadcastJob; requeued: number }>> {
    const existing = this.store.findBroadcastByReference(reference);

    if (!existing) {
      return adminFail('NOT_FOUND', 'این ارسال گروهی پیدا نشد.');
    }

    if (existing.status === 'RUNNING') {
      return adminFail('CONFLICT', 'این ارسال همین حالا در حال اجراست.');
    }

    if (existing.retryCount >= this.config.adminBroadcastMaxManualRetries) {
      return adminFail(
        'LIMIT_EXCEEDED',
        `سقف تلاش دوباره برای این ارسال پر شده است (${this.config.adminBroadcastMaxManualRetries}).`,
      );
    }

    try {
      const result = await this.store.transact((tx) => {
        const current = tx.findBroadcast(existing.broadcastId);

        if (!current) {
          return null;
        }

        let requeued = 0;

        for (const recipient of tx.listRecipients(current.broadcastId)) {
          if (recipient.status === 'FAILED') {
            tx.saveRecipient({
              ...recipient,
              status: 'PENDING',
              attemptCount: 0,
              nextAttemptAt: null,
            });
            requeued += 1;
          }
        }

        if (requeued === 0) {
          return { job: current, requeued: 0 };
        }

        const updated: BroadcastJob = {
          ...current,
          status: 'RUNNING',
          completedAt: null,
          retryCount: current.retryCount + 1,
          nextAttemptAfter: null,
        };

        tx.saveBroadcast(updated);

        return { job: updated, requeued };
      });

      if (!result) {
        return adminFail('NOT_FOUND', 'این ارسال گروهی پیدا نشد.');
      }

      if (result.requeued === 0) {
        return adminFail(
          'CONFLICT',
          'گیرندهٔ ناموفقی برای تلاش دوباره وجود ندارد.',
        );
      }

      await this.audit.record({
        actor: actor.key,
        role: actor.role,
        action: 'BROADCAST_RETRIED',
        targetType: 'broadcast',
        targetRef: result.job.reference,
        result: 'OK',
        toState: 'RUNNING',
        reason: `${result.requeued} گیرندهٔ ناموفق دوباره در صف`,
        correlationId: result.job.broadcastId,
      });

      return adminOk(result);
    } catch (error) {
      this.logger.error(
        `Could not retry broadcast ${reference}: ${describeError(error)}`,
      );

      return adminFail('PERSISTENCE_FAILED', 'تلاش دوباره ذخیره نشد.');
    }
  }

  // --- worker (§11.2/§11.3) -------------------------------------------------------

  /**
   * Bounded worker tick: at most `ADMIN_BROADCAST_BATCH_SIZE` recipients per tick, and it stops the
   * moment the platform asks us to slow down. It runs on the project's existing scheduler, so the
   * broadcast never blocks the bot loop (§16).
   */
  @Cron('*/10 * * * * *', { name: 'admin-broadcast-worker' })
  async scheduledTick(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      await this.processTick();
    } catch (error) {
      this.logger.error(
        `Broadcast worker tick failed: ${describeError(error)}`,
      );
    }
  }

  async processTick(now: Date = new Date()): Promise<BroadcastTickResult> {
    const empty: BroadcastTickResult = {
      processed: 0,
      sent: 0,
      failed: 0,
      retryScheduled: 0,
      unknown: 0,
      rateLimited: false,
      jobCompleted: null,
    };

    if (this.ticking) {
      // A slow tick must never overlap the next one — that is how rate limits get violated.
      return empty;
    }

    this.ticking = true;

    try {
      await this.store.ensureLoaded();

      const job = this.nextRunnableJob(now);

      if (!job) {
        return empty;
      }

      const pending = this.store
        .listRecipients(job.broadcastId)
        .filter(
          (recipient) =>
            recipient.status === 'PENDING' &&
            (recipient.nextAttemptAt === null ||
              Date.parse(recipient.nextAttemptAt) <= now.getTime()),
        )
        .sort((left, right) =>
          left.recipientId.localeCompare(right.recipientId),
        )
        .slice(0, this.config.adminBroadcastBatchSize);

      if (pending.length === 0) {
        const completed = await this.finalize(job.broadcastId, now);

        return { ...empty, jobCompleted: completed ? job.reference : null };
      }

      await this.markStarted(job, now);

      const result: BroadcastTickResult = { ...empty };

      for (const recipient of pending) {
        const outcome = await this.sendTo(recipient, job, now);

        result.processed += 1;

        switch (outcome) {
          case 'SENT':
            result.sent += 1;
            break;
          case 'FAILED':
            result.failed += 1;
            break;
          case 'RETRY_SCHEDULED':
            result.retryScheduled += 1;
            break;
          case 'UNKNOWN':
            result.unknown += 1;
            break;
          case 'RATE_LIMITED':
            result.rateLimited = true;
            // The platform asked for a pause: stop this tick immediately, keep the recipient pending
            // and back the whole job off. Nothing is dropped.
            await this.backOff(job.broadcastId, now);
            return {
              ...result,
              jobCompleted: null,
            };
          default:
            break;
        }

        if (this.config.adminBroadcastMinIntervalMs > 0) {
          await delay(this.config.adminBroadcastMinIntervalMs);
        }
      }

      const completed = await this.finalize(job.broadcastId, now);
      result.jobCompleted = completed ? job.reference : null;

      return result;
    } finally {
      this.ticking = false;
    }
  }

  private nextRunnableJob(now: Date): BroadcastJob | null {
    return (
      this.store
        .listBroadcasts()
        .filter((job) => job.status === 'RUNNING')
        .filter(
          (job) =>
            job.nextAttemptAfter === null ||
            Date.parse(job.nextAttemptAfter) <= now.getTime(),
        )
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        )[0] ?? null
    );
  }

  /** One send attempt with honest outcome classification. */
  private async sendTo(
    recipient: BroadcastRecipient,
    job: BroadcastJob,
    now: Date,
  ): Promise<SendOutcome> {
    const adapter = this.registry.resolve(recipient.platform);

    if (!adapter) {
      await this.storeOutcome(recipient, {
        status: 'FAILED',
        attemptCount: recipient.attemptCount + 1,
        lastAttemptAt: now.toISOString(),
        lastError: `platform ${recipient.platform} is not configured`,
      });

      return 'FAILED';
    }

    const attemptCount = recipient.attemptCount + 1;
    let result: PlatformSendResult;

    try {
      result = await adapter.render({
        chatId: recipient.chatId,
        text: job.text,
      });
    } catch (error) {
      // The request left the process but its answer never came back: we do **not** know whether the
      // message arrived, so it is recorded as UNKNOWN and never retried automatically (§11.4).
      await this.storeOutcome(recipient, {
        status: 'UNKNOWN',
        attemptCount,
        lastAttemptAt: now.toISOString(),
        lastError: `no answer from ${recipient.platform}: ${truncate(describeError(error), 120)}`,
      });

      this.logger.error(
        `Broadcast ${job.reference}: unknown outcome on ${recipient.platform} — not retried.`,
      );

      return 'UNKNOWN';
    }

    if (result.success) {
      await this.storeOutcome(recipient, {
        status: 'SENT',
        attemptCount,
        lastAttemptAt: now.toISOString(),
        sentAt: now.toISOString(),
        externalMessageId:
          result.messageId === null ? null : String(result.messageId),
        lastError: null,
      });

      return 'SENT';
    }

    const reason = result.error ?? 'unknown platform error';

    if (RATE_LIMIT_SIGNATURE.test(reason)) {
      // A rate limit is not a failure of this message: the attempt is not counted and both the
      // recipient and the job are backed off.
      await this.storeOutcome(recipient, {
        status: 'PENDING',
        attemptCount: recipient.attemptCount,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: new Date(
          now.getTime() + this.config.adminBroadcastBackoffMs,
        ).toISOString(),
        lastError: truncate(reason, 120),
      });

      return 'RATE_LIMITED';
    }

    if (attemptCount < this.config.adminBroadcastMaxAttempts) {
      await this.storeOutcome(recipient, {
        status: 'PENDING',
        attemptCount,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: new Date(
          now.getTime() + this.config.adminBroadcastBackoffMs,
        ).toISOString(),
        lastError: truncate(reason, 120),
      });

      return 'RETRY_SCHEDULED';
    }

    await this.storeOutcome(recipient, {
      status: 'FAILED',
      attemptCount,
      lastAttemptAt: now.toISOString(),
      lastError: truncate(reason, 120),
    });

    return 'FAILED';
  }

  private async storeOutcome(
    recipient: BroadcastRecipient,
    patch: Partial<BroadcastRecipient>,
  ): Promise<void> {
    try {
      await this.store.transact((tx) => {
        const current = tx.findRecipient(recipient.recipientId);

        if (!current) {
          return;
        }

        // A recipient that is no longer PENDING (cancelled, or already answered) keeps its stored
        // outcome: a message is never re-sent because a stale tick thought it was still waiting.
        if (current.status !== 'PENDING') {
          return;
        }

        tx.saveRecipient({ ...current, ...patch });
      });
    } catch (error) {
      this.logger.error(
        `Could not persist a broadcast outcome: ${describeError(error)}`,
      );
    }
  }

  /** Record the (single) transition into “actually sending”, so the audit trail has a start point. */
  private async markStarted(job: BroadcastJob, now: Date): Promise<void> {
    if (job.confirmedAt === null) {
      return;
    }

    const alreadyStarted = this.store
      .listRecipients(job.broadcastId)
      .some((recipient) => recipient.lastAttemptAt !== null);

    if (alreadyStarted) {
      return;
    }

    await this.audit.record({
      actor: job.confirmedBy ?? 'system:admin',
      role: 'SYSTEM',
      action: 'BROADCAST_STARTED',
      targetType: 'broadcast',
      targetRef: job.reference,
      result: 'OK',
      fromState: 'RUNNING',
      toState: 'RUNNING',
      reason: `شروع ارسال به ${job.totalRecipients} گیرنده`,
      correlationId: job.broadcastId,
      at: now.toISOString(),
    });
  }

  private async backOff(broadcastId: string, now: Date): Promise<void> {
    const until = new Date(
      now.getTime() + this.config.adminBroadcastBackoffMs,
    ).toISOString();

    try {
      await this.store.transact((tx) => {
        const current = tx.findBroadcast(broadcastId);

        if (!current || current.status !== 'RUNNING') {
          return;
        }

        tx.saveBroadcast({ ...current, nextAttemptAfter: until });
      });
    } catch (error) {
      this.logger.error(
        `Could not back off a broadcast: ${describeError(error)}`,
      );
    }
  }

  /**
   * Close a job when nothing is left to send. `COMPLETED` never means “everybody received it”: the
   * report distinguishes accepted, confirmed and unknown, and a cancel is not a recall (§11.5).
   */
  private async finalize(broadcastId: string, now: Date): Promise<boolean> {
    const job = this.store.findBroadcast(broadcastId);

    if (!job || job.status !== 'RUNNING') {
      return false;
    }

    const recipients = this.store.listRecipients(broadcastId);
    const stillPending = recipients.filter(
      (recipient) => recipient.status === 'PENDING',
    ).length;

    if (stillPending > 0) {
      return false;
    }

    const sent = recipients.filter(
      (recipient) => recipient.status === 'SENT',
    ).length;
    const failed = recipients.filter(
      (recipient) => recipient.status === 'FAILED',
    ).length;
    const unknown = recipients.filter(
      (recipient) => recipient.status === 'UNKNOWN',
    ).length;
    const status = sent === 0 && failed + unknown > 0 ? 'FAILED' : 'COMPLETED';

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findBroadcast(broadcastId);

        if (!current || current.status !== 'RUNNING') {
          return null;
        }

        const next: BroadcastJob = {
          ...current,
          status,
          completedAt: now.toISOString(),
          lastError:
            failed + unknown > 0
              ? `${failed} ناموفق · ${unknown} نامعلوم`
              : null,
        };

        tx.saveBroadcast(next);

        return next;
      });

      if (!updated) {
        return false;
      }

      await this.audit.record({
        actor: updated.confirmedBy ?? 'system:admin',
        role: 'SYSTEM',
        action: 'BROADCAST_COMPLETED',
        targetType: 'broadcast',
        targetRef: updated.reference,
        result: status === 'COMPLETED' ? 'OK' : 'FAILED',
        fromState: 'RUNNING',
        toState: status,
        reason: `تحویل‌شده: ${sent} · ناموفق: ${failed} · نامعلوم: ${unknown}`,
        correlationId: updated.broadcastId,
        at: now.toISOString(),
      });

      if (failed + unknown > 0) {
        await this.errors.record({
          source: 'broadcast',
          category: 'DELIVERY_OUTCOME',
          severity: 'MEDIUM',
          summary: `ارسال گروهی ${updated.reference}: ${failed} شکست و ${unknown} نتیجهٔ نامعلوم.`,
          reference: updated.reference,
          correlationId: updated.broadcastId,
          retryable: failed > 0,
          at: now,
        });
      }

      this.logger.log(
        `📨 Broadcast ${updated.reference} finished as ${status} — delivered ${sent}, failed ` +
          `${failed}, unknown ${unknown}.`,
      );

      return true;
    } catch (error) {
      this.logger.error(
        `Could not finalize broadcast ${broadcastId}: ${describeError(error)}`,
      );

      return false;
    }
  }

  // --- reporting (§11.5) ---------------------------------------------------------

  report(reference: string): BroadcastReport | null {
    const job = this.store.findBroadcastByReference(reference);

    if (!job) {
      return null;
    }

    const recipients = this.store.listRecipients(job.broadcastId);
    const totals: Record<BroadcastRecipientStatus, number> = {
      PENDING: 0,
      SENT: 0,
      FAILED: 0,
      UNKNOWN: 0,
      SKIPPED: 0,
    };

    for (const recipient of recipients) {
      totals[recipient.status] += 1;
    }

    const notes = [
      'SENT یعنی پلتفرم پیام را پذیرفت؛ به‌معنای خوانده‌شدن یا تحویل قطعی به مخاطب نیست.',
      'UNKNOWN یعنی پاسخ پلتفرم نرسید؛ نه موفق شمرده می‌شود و نه دوباره ارسال می‌شود.',
    ];

    if (job.status === 'CANCELLED') {
      notes.push(
        'لغو فقط گیرندگان ارسال‌نشده را متوقف کرد؛ پیام‌های ارسال‌شده قابل برگشت نیستند.',
      );
    }

    return {
      job,
      totals,
      attempts: recipients.reduce(
        (total, recipient) => total + recipient.attemptCount,
        0,
      ),
      notes,
    };
  }

  list(limit = 10): BroadcastJob[] {
    return this.store
      .listBroadcasts()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  /** Active (not finished) broadcasts — used by the screens to show a real state. */
  activeJobs(): BroadcastJob[] {
    return this.store
      .listBroadcasts()
      .filter((job) => job.status === 'PREPARED' || job.status === 'RUNNING');
  }

  // --- helpers ------------------------------------------------------------------

  /** Tehran day bounds of an “active/inactive in the last N days” audience (inclusive keys). */
  private activityWindow(
    audience: BroadcastAudience,
    now: Date,
  ): { fromDayKey: string; toDayKey: string } | null {
    if (audience.days === null) {
      return null;
    }

    const toDayKey = tehranDayKey(now);
    const days = Math.max(1, audience.days);

    return { fromDayKey: shiftDayKey(toDayKey, -(days - 1)), toDayKey };
  }
}

function bump(counts: Map<string, number>, reason: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPlausibleChatId(chatId: string): boolean {
  return /^-?\d{3,20}$/u.test(chatId);
}

function buildReference(broadcastId: string): string {
  const sequence = broadcastId.replace(/^bc_/u, '').padStart(4, '0');

  return `BC-${sequence}`;
}

/**
 * A stored identity opts out when it carries the flag. Nothing in this phase writes it; the rule
 * exists so the eligibility calculation is correct the moment an opt-out path is added, and the
 * limitation is printed instead of being assumed away.
 */
function isOptedOut(user: User): boolean {
  return (
    (user as User & { broadcastOptOut?: boolean }).broadcastOptOut === true
  );
}

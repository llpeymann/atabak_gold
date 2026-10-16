/**
 * Phase 10 — durable user activity (§14, “Active Users”).
 *
 * “Active user” must mean *a real person used the bot*, so the only writer of this service is the
 * central inbound path in `BotUxService.handleUpdate` — the same single choke point Phase 7 uses for
 * `lastInteractionAt`. Publishers, schedulers, notification workers and campaign ingestion never
 * reach it, which is what keeps the metric honest.
 *
 * Write cost is bounded on purpose:
 *
 *  * the **first action of a Tehran day** flushes immediately (that is the fact the metric needs);
 *  * pure “last seen” refreshes are throttled to one write per identity per interval;
 *  * the stored day list is capped by `ADMIN_ACTIVITY_RETENTION_DAYS`, so one identity can never grow
 *    the document without limit.
 *
 * A lost throttled refresh means `lastSeenAt` is a few minutes stale — never that a *day* is missing.
 */

import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { tehranDayKey } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import { AdminStore } from './admin.store';
import { ActivityRow, ReportWindow } from './admin.types';

/** One refresh write per identity per five minutes is enough for an operations dashboard. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class AdminActivityService {
  private readonly logger = new Logger(AdminActivityService.name);
  private readonly lastFlush = new Map<string, number>();

  constructor(
    private readonly config: AppConfigService,
    private readonly store: AdminStore,
  ) {}

  /**
   * Record one qualifying user-initiated action.
   *
   * Never throws: activity is reporting data, and a full disk must not break a customer interaction
   * (§17). A failed write is logged (that is a real operational signal) and the day is simply not
   * counted — the metric can under-report after a storage failure, never over-report.
   */
  async recordUserAction(
    identity: { platform: Platform; platformUserId: string; userId: string },
    now: Date = new Date(),
  ): Promise<void> {
    const identityKey = `${identity.platform}:${identity.platformUserId}`;
    const dayKey = tehranDayKey(now);
    const existing = this.store.findActivity(identityKey);
    const dayIsNew = !existing || !existing.days.includes(dayKey);
    const lastFlushAt = this.lastFlush.get(identityKey) ?? 0;

    if (!dayIsNew && now.getTime() - lastFlushAt < REFRESH_INTERVAL_MS) {
      return;
    }

    try {
      await this.store.transact((tx) =>
        tx.touchActivity({
          identityKey,
          platform: identity.platform,
          userId: identity.userId,
          dayKey,
          at: now.toISOString(),
          maxDays: this.retentionDays,
        }),
      );

      this.lastFlush.set(identityKey, now.getTime());
    } catch (error) {
      this.logger.error(
        `Could not record activity for one identity: ${describeError(error)}`,
      );
    }
  }

  /** Identities with at least one qualifying action inside the window (unique users, §14). */
  activeIdentitiesIn(window: ReportWindow): ActivityRow[] {
    return this.store
      .listActivity()
      .filter((row) =>
        row.days.some(
          (day) => day >= window.fromDayKey && day <= window.toDayKey,
        ),
      );
  }

  countActiveIn(window: ReportWindow): number {
    return this.activeIdentitiesIn(window).length;
  }

  /** Tehran day keys recorded for one identity (empty when nothing was ever recorded). */
  daysOf(identityKey: string): string[] {
    const row = this.store.findActivity(identityKey);

    return row ? [...row.days] : [];
  }

  /** Last qualifying action of one identity, or `null` when nothing was ever recorded. */
  lastSeenAt(identityKey: string): string | null {
    return this.store.findActivity(identityKey)?.lastSeenAt ?? null;
  }

  /** Is this identity considered active inside the window? (used by the broadcast audience rule.) */
  isActiveIn(identityKey: string, window: ReportWindow): boolean {
    const row = this.store.findActivity(identityKey);

    if (!row) {
      return false;
    }

    return row.days.some(
      (day) => day >= window.fromDayKey && day <= window.toDayKey,
    );
  }

  listRows(): ActivityRow[] {
    return this.store.listActivity();
  }

  get trackedIdentities(): number {
    return this.store.listActivity().length;
  }

  private get retentionDays(): number {
    return this.config.adminActivityRetentionDays;
  }
}

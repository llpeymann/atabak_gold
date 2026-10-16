import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { AlertCapacityService } from '../alerts/alert-capacity.service';
import { Platform } from '../platform/platform.types';
import { UserStore, UserTransaction } from '../users/user.store';
import { User } from '../users/user.types';
import { generateReferralCode, isReferralCode } from './referral-code';
import { ReferralOutcome, ReferralStats, RewardGrant } from './referral.types';

/**
 * Minimum interval between two persisted activity timestamps.
 *
 * The metric has a *day* granularity, so writing on every single button press would cost a document
 * write per update for no benefit. One write per minute per active user keeps the value accurate
 * enough for a 30-day window while keeping the store quiet.
 */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

/** One arrival that carries a referral code. */
export interface ReferralJoinInput {
  platform: Platform;
  platformUserId: string;
  chatId: string | null;
  code: string;
  /** Injectable clock (tests need a deterministic "now"). */
  now?: Date;
}

/** Result of handling a referral start: never a bare boolean — the outcome is always named (§5.4). */
export interface ReferralStartResult {
  outcome: ReferralOutcome;
  /**
   * The registered user behind this update, or `null` when nothing could be registered
   * (`unknown-code`, `disabled` or a failed registration). The caller then runs the *normal* start
   * flow, so a bad referral link can never block the bot (§5.4 rule 5).
   */
  user: User | null;
  /** One-line explanation to show next to the normal start screen (`null` = nothing to explain). */
  noticeFa: string | null;
  /** Congratulation message for the inviter, produced only *after* a successful grant (§8.4). */
  referrerNotice: ReferrerNotice | null;
}

/**
 * Structured reward notification of the inviter, ready to be delivered by the platform adapter.
 *
 * The service deliberately carries **no Persian prose**: the text is produced by the UX formatter
 * (`formatRewardGrantedNotice`), so all user-facing wording stays in one layer.
 */
export interface ReferrerNotice {
  userId: string;
  platform: Platform;
  chatId: string | null;
  /** Successful referrals required for this reward (the real threshold that was reached). */
  threshold: number;
  /** Permanent alert slots this reward added. */
  slots: number;
  /** Effective alert capacity of the inviter after the grant. */
  totalCapacity: number;
}

/**
 * Phase 7 — the growth engine (§4–§10).
 *
 * Responsibilities, deliberately narrow:
 *  * own the *identity* rules of the referral system (codes, attribution, statistics);
 *  * perform the one atomic write that registers an invited user, records the relationship and
 *    appends the rewards it earns;
 *  * expose the statistics the UI shows.
 *
 * It does **not** reimplement alert capacity (that stays in `AlertService` via
 * `AlertCapacityService`), does not own delivery (the platform adapters do) and does not own the
 * menu (the existing `BotUxService` screens do).
 *
 * ## Why the atomics are where they are
 *
 * Every write of referral state goes through `UserStore.transact`, which runs on the store's existing
 * serialized write chain and persists the whole document atomically (tmp file + rename). Two
 * consequences that the tests rely on:
 *   * a user can be attributed to at most one inviter — the invitee key is written once, and the
 *     "was this user new?" decision is taken *inside* the same critical section (§6.1, §6.5);
 *   * a reward row is written exactly once per `(user, type, threshold)`, so a retry after a failure
 *     (or a second concurrent qualification) can never produce a duplicate bonus (§8.4).
 *
 * ## Known and documented limitations (§6.6, §10.4, §13.6)
 *
 *  * Identity is per platform: `bale:<id>` and `telegram:<id>` are different users, and this build has
 *    no verified cross-platform mapping. A referral therefore belongs to the platform it happened on —
 *    no guessing, no merging.
 *  * A referral is "successful" because the invited user arrived through a valid link and was
 *    registered. Registering several accounts is possible on any messaging platform; this system does
 *    not fingerprint users and does not claim to detect fake accounts.
 *  * Self-referral is judged strictly by internal identity (platform + platform user id), never by a
 *    display name, which is untrusted input.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: UserStore,
    private readonly capacity: AlertCapacityService,
  ) {}

  get enabled(): boolean {
    return this.config.referralEnabled;
  }

  get rewardsEnabled(): boolean {
    return this.config.referralRewardsEnabled;
  }

  /** Successful referrals required per reward — the *only* place this number is read (§12). */
  get referralsPerReward(): number {
    return this.config.referralRewardsPerThreshold;
  }

  /** Permanent alert slots added per reward — likewise a single read (§8.1). */
  get bonusSlotsPerReward(): number {
    return this.config.referralRewardBonusSlots;
  }

  /**
   * The referral code of a user, generated on first use and never rotated.
   *
   * Generation happens inside the store transaction: the code is unique by construction (the store
   * keeps a code → user map and rejects a collision inside the same critical section), and a user who
   * already has one always keeps it — a code that changes would break links that are already spread
   * across chats (§4.1 rules 1–3).
   */
  async referralCodeFor(userId: string): Promise<string | null> {
    const existing = this.store.findUser(userId);

    if (!existing) {
      return null;
    }

    if (isReferralCode(existing.referralCode)) {
      return existing.referralCode;
    }

    const outcome = await this.store.transact((tx) => {
      const current = tx.findUser(userId);

      if (!current) {
        return null;
      }

      if (isReferralCode(current.referralCode)) {
        return current.referralCode;
      }

      const generated = this.generateUniqueCode(tx);

      if (!generated) {
        return null;
      }

      return tx.assignReferralCode(userId, generated);
    });

    if (!outcome.result) {
      this.logger.error(
        `Could not assign a referral code to ${userId} (persisted=${outcome.persisted}).`,
      );
    }

    return outcome.result;
  }

  /**
   * The user's own platform and (already assigned) code, read synchronously for rendering.
   *
   * Rendering the referral screen must never trigger a write, so the code is assigned on the update
   * path (`handleUpdate`) and read here. A `null` code is a real state (the write did not reach the
   * disk): the screen then falls back to the "no link yet" copy instead of showing a broken one.
   */
  referralContext(
    userId: string,
  ): { platform: Platform; code: string | null } | null {
    const user = this.store.findUser(userId);

    if (!user) {
      return null;
    }

    return {
      platform: user.platform,
      code: isReferralCode(user.referralCode) ? user.referralCode : null,
    };
  }

  /**
   * Handle a `/start ref_<code>` arrival.
   *
   * Order of decisions (§5.3), each of which ends in an explicit outcome:
   *   1. the feature is on (otherwise nothing is created or modified at all),
   *   2. the code resolves to a user (otherwise the normal start flow continues),
   *   3. the code does not belong to the arriving identity (self-referral → no count, no grant),
   *   4. an existing user is never attributed (no retro-attribution, no inviter change),
   *   5. otherwise: register + attribute + evaluate rewards in **one** transaction.
   */
  async handleStartReferral(
    input: ReferralJoinInput,
  ): Promise<ReferralStartResult> {
    const now = input.now ?? new Date();

    if (!this.enabled) {
      this.logger.debug(
        `Ignored referral payload from ${input.platform}: the growth engine is disabled.`,
      );

      return {
        outcome: { kind: 'disabled' },
        user: null,
        noticeFa: null,
        referrerNotice: null,
      };
    }

    if (!isReferralCode(input.code)) {
      return {
        outcome: { kind: 'unknown-code' },
        user: null,
        noticeFa: null,
        referrerNotice: null,
      };
    }

    const inviter = this.store.findUserByReferralCode(input.code);

    if (!inviter) {
      this.logger.warn(
        `Referral payload with an unknown code rejected on ${input.platform}.`,
      );

      return {
        outcome: { kind: 'unknown-code' },
        user: null,
        noticeFa: null,
        referrerNotice: null,
      };
    }

    // Self-referral: judged on the stable internal identity (§6.2). Never on names/usernames.
    if (
      inviter.platform === input.platform &&
      inviter.platformUserId === input.platformUserId
    ) {
      return {
        outcome: { kind: 'self-referral' },
        user: inviter,
        noticeFa: '🙂 این لینک دعوت خودت است؛ دعوت از خودت ثبت نمیشود.',
        referrerNotice: null,
      };
    }

    const arrivingUser = this.store.findUserByPlatform(
      input.platform,
      input.platformUserId,
    );

    if (arrivingUser) {
      // The user is already registered: refresh the delivery chat, but never count or re-attribute.
      const updated = await this.store.upsertUser(
        input.platformUserId,
        input.platform,
        input.chatId,
      );

      return {
        outcome: { kind: 'existing-user' },
        user: updated,
        noticeFa:
          'ℹ️ این کد دعوت برای کاربران جدید است؛ حساب شما قبلاً ثبت شده.',
        referrerNotice: null,
      };
    }

    const joinedAt = now.toISOString();
    const outcome = await this.store.transact((tx) => {
      // Re-check inside the critical section: two concurrent first arrivals must not both be
      // treated as new, and the referral row is keyed by invitee, so a second write is impossible.
      const raced = tx.findByPlatform(input.platform, input.platformUserId);

      if (raced) {
        return {
          created: false as const,
          user: raced,
          referralWritten: false,
          granted: [],
        };
      }

      const { user, created } = tx.upsertUser({
        platform: input.platform,
        platformUserId: input.platformUserId,
        chatId: input.chatId,
      });

      if (!created) {
        return {
          created: false as const,
          user,
          referralWritten: false,
          granted: [],
        };
      }

      const referralWritten = tx.saveReferral({
        id: tx.nextId('ref'),
        inviterUserId: inviter.id,
        inviteeUserId: user.id,
        code: input.code,
        platform: input.platform,
        createdAt: joinedAt,
      });

      const granted = this.evaluateRewards(tx, inviter.id, joinedAt);

      return { created: true as const, user, referralWritten, granted };
    });

    const { created, user, referralWritten } = outcome.result;

    if (!created || !referralWritten) {
      // The identity was registered by someone else in the meantime: behave exactly like an
      // already-registered user — no count, no grant, no duplicate user (§5.4 rule 7).
      return {
        outcome: { kind: 'existing-user' },
        user,
        noticeFa:
          'ℹ️ این کد دعوت برای کاربران جدید است؛ حساب شما قبلاً ثبت شده.',
        referrerNotice: null,
      };
    }

    if (!outcome.persisted) {
      // The registration is in memory only: the relationship is **not** reported as successful, no
      // reward is announced, and the durable document stays clean — the conservative direction
      // (§6.4 "no counted-but-unregistered", §8.4 "never falsely report success").
      //
      // Recovery: the store logs the failed write, and because nothing durable changed, the *next*
      // arrival of an identity that is unknown to a fresh process registers it again and records the
      // referral then. Until that happens the identity is reported as already registered (no count),
      // which is the safe side to be wrong on.
      this.logger.error(
        `Referral from ${input.platform} was registered in memory but could not be persisted; not counted.`,
      );

      return {
        outcome: { kind: 'persist-failed' },
        user,
        noticeFa: null,
        referrerNotice: null,
      };
    }

    // Applying the rewards is a separate, idempotent step (§8.4). The inviter is notified only about
    // rewards that are *granted*, never about a row that failed to apply.
    const applied = await this.applyPendingRewards(inviter.id, now);

    this.logger.log(
      `Successful referral recorded on ${input.platform} (inviter ${inviter.id}); ${applied.length} reward(s) granted.`,
    );

    return {
      outcome: {
        kind: 'joined',
        referrerUserId: inviter.id,
        rewardsGranted: applied,
      },
      user,
      noticeFa: null,
      referrerNotice: this.noticeFor(inviter, applied),
    };
  }

  /**
   * Record the last valid user-initiated interaction (Phase 7 activity metric).
   *
   * Called only from the central inbound path — never from a publisher, a scheduler or a delivery
   * routine — which is what makes "active referred member" mean "a real person used the bot".
   * Failure to persist is logged by the store and never blocks the update.
   */
  async touchActivity(userId: string, now: Date = new Date()): Promise<void> {
    const user = this.store.findUser(userId);

    if (!user) {
      return;
    }

    const previous =
      typeof user.lastInteractionAt === 'string'
        ? Date.parse(user.lastInteractionAt)
        : Number.NaN;

    if (
      Number.isFinite(previous) &&
      now.getTime() - previous < ACTIVITY_WRITE_INTERVAL_MS
    ) {
      return;
    }

    await this.store.touchInteraction(userId, now.toISOString());
  }

  // --- reward accounting (§8) --------------------------------------------------

  /**
   * Evaluate the referral thresholds of one inviter **inside the running transaction**.
   *
   * A threshold is earned when the successful referral count reaches `k * referralsPerReward`. The
   * reward row is written once per threshold (`saveReward` is the uniqueness check) and starts as
   * `PENDING`; applying it is a separate, idempotent step, so a crash between "earned" and "applied"
   * leaves a recoverable row instead of a lost or duplicated bonus (§8.4).
   */
  private evaluateRewards(
    tx: UserTransaction,
    inviterUserId: string,
    now: string,
  ): RewardGrant[] {
    if (!this.rewardsEnabled) {
      return [];
    }

    const successful = tx.countReferralsByInviter(inviterUserId);
    const perReward = this.referralsPerReward;
    const earnedThresholds = Math.floor(successful / perReward);
    const bonusSlots = this.bonusSlotsPerReward;
    const maxBonus = this.config.referralMaxBonusSlots;
    const granted: RewardGrant[] = [];

    for (let threshold = 1; threshold <= earnedThresholds; threshold += 1) {
      // Every earned threshold is recorded, even when the configured ceiling currently prevents it
      // from being applied: the ledger must not silently drop what a user has already earned, and the
      // apply step is where the ceiling is enforced (`CAPACITY_CEILING_REACHED`) (§8.3, §12).
      if (threshold * bonusSlots > maxBonus) {
        this.logger.warn(
          `Referral reward threshold ${threshold} exceeds REFERRAL_MAX_BONUS_SLOTS (${maxBonus}); recorded but not applied.`,
        );
      }

      const written = tx.saveReward({
        id: tx.nextId('rwd'),
        userId: inviterUserId,
        rewardType: 'ALERT_CAPACITY',
        threshold,
        status: 'PENDING',
        referralsAtGrant: successful,
        capacityBonus: bonusSlots,
        createdAt: now,
        grantedAt: null,
        lastError: null,
      });

      if (!written) {
        // Already earned earlier: the ledger is the source of truth, nothing is re-issued (§8.4).
        continue;
      }

      granted.push({
        id: '',
        userId: inviterUserId,
        rewardType: 'ALERT_CAPACITY',
        threshold,
        status: 'PENDING',
        referralsAtGrant: successful,
        capacityBonus: bonusSlots,
        createdAt: now,
        grantedAt: null,
        lastError: null,
      });
    }

    return granted;
  }

  /**
   * Apply every pending reward of one user — the *effectively-once* half of the reward rule.
   *
   * The capacity itself is derived from the ledger by `AlertCapacityService` (status `GRANTED`), so
   * "applying" is a status transition with an explicit commit point: the row is only marked
   * `GRANTED` after its persisted bonus is visible to the capacity read. Re-running this method is
   * harmless, and a failure keeps the row `PENDING` for the next retry with the error recorded.
   */
  async applyPendingRewards(
    userId: string,
    now: Date = new Date(),
  ): Promise<RewardGrant[]> {
    if (!this.rewardsEnabled) {
      return [];
    }

    const pending = this.store
      .listRewards(userId)
      .filter((reward) => reward.status === 'PENDING');

    const applied: RewardGrant[] = [];

    for (const reward of pending) {
      const outcome = await this.store.transact((tx) => {
        const current = tx
          .listRewards(userId)
          .find(
            (row) =>
              row.rewardType === reward.rewardType &&
              row.threshold === reward.threshold,
          );

        if (!current || current.status !== 'PENDING') {
          return null;
        }

        // The configured ceiling is a hard stop: once it is reached, further rewards stay PENDING
        // (visible, retryable) instead of silently exceeding the documented maximum (§8.3).
        if (
          this.capacity.bonusSlotsFrom(tx.listRewards(userId)) >=
          this.capacity.maxBonusSlots
        ) {
          tx.updateReward(userId, current.rewardType, current.threshold, {
            status: 'PENDING',
            lastError: 'CAPACITY_CEILING_REACHED',
          });

          return null;
        }

        const updated = tx.updateReward(
          userId,
          current.rewardType,
          current.threshold,
          {
            status: 'GRANTED',
            grantedAt: now.toISOString(),
            lastError: null,
          },
        );

        return updated ? { ...current, status: 'GRANTED' as const } : null;
      });

      if (outcome.result) {
        applied.push(outcome.result);
      }
    }

    return applied;
  }

  /** Rewards already applied for a user (the number the UI may present as "granted"). */
  grantedRewardCount(userId: string): number {
    return this.capacity.grantedRewards(userId).length;
  }

  // --- statistics (§7) ---------------------------------------------------------

  /**
   * Everything the referral screen shows, derived from persisted data only.
   *
   * `successfulReferrals` comes from the referral rows, `grantedRewards` from the ledger (never from
   * a formula), and `activeReferrals` from the stored interaction timestamps inside the rolling
   * window. The progress numbers are explicitly *progress*: they never define what has been granted.
   */
  statsFor(userId: string, now: Date = new Date()): ReferralStats {
    const referrals = this.store.listReferralsByInviter(userId);
    const rewards = this.store.listRewards(userId);
    const windowStart = now.getTime() - this.config.referralActiveWindowMs;
    const active = referrals.filter((referral) => {
      const invitee = this.store.findUser(referral.inviteeUserId);
      const last = invitee?.lastInteractionAt;

      if (typeof last !== 'string') {
        // No recorded interaction = inactive. Absence is never read as "now" (§7.4).
        return false;
      }

      const timestamp = Date.parse(last);

      return Number.isFinite(timestamp) && timestamp >= windowStart;
    }).length;

    const perReward = this.referralsPerReward;
    const granted = rewards.filter((reward) => reward.status === 'GRANTED');
    const pending = rewards.filter((reward) => reward.status === 'PENDING');
    const earned = Math.floor(referrals.length / perReward);
    const effective = this.capacity.effectiveLimit(userId);

    return {
      successfulReferrals: referrals.length,
      activeReferrals: active,
      grantedRewards: granted.length,
      earnedThresholds: earned,
      pendingRewards: pending.length,
      remainingForNextReward: perReward - (referrals.length % perReward),
      referralsPerReward: perReward,
      effectiveAlertCapacity: effective.limit,
      baseAlertCapacity: effective.baseLimit,
    };
  }

  /** Does this user have an applied bonus? Used by the alert screen text. */
  hasGrantedReward(userId: string): boolean {
    return this.capacity.grantedRewards(userId).length > 0;
  }

  // --- helpers -----------------------------------------------------------------

  /**
   * Generate a code that no existing user owns. The lookup happens inside the caller's transaction, so
   * a collision can only be caused by an astronomically unlikely random repeat — and even then it is
   * rejected here instead of overwriting an existing code (§4.1 rule 3).
   */
  private generateUniqueCode(tx: UserTransaction): string | null {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateReferralCode();

      if (!tx.findByReferralCode(candidate)) {
        return candidate;
      }
    }

    this.logger.error('Could not generate a collision-free referral code.');

    return null;
  }

  /** Build the inviter's congratulation message for the rewards earned by one arrival (§8.4). */
  private noticeFor(
    inviter: User,
    granted: RewardGrant[],
  ): ReferrerNotice | null {
    if (granted.length === 0 || !inviter.chatId) {
      return null;
    }

    const first = granted[0];
    const total = this.capacity.effectiveLimit(inviter.id).limit;

    return {
      userId: inviter.id,
      platform: inviter.platform,
      chatId: inviter.chatId,
      // The threshold of the *reached* reward at the configured rule (3 → 3, 6 → 6, …), never a
      // hardcoded number (§8.2).
      threshold: first.threshold * this.referralsPerReward,
      slots: first.capacityBonus,
      totalCapacity: total,
    };
  }

  /** Log helper that never echoes identifiers into user-visible text. */
  describeOutcome(outcome: ReferralOutcome): string {
    return outcome.kind;
  }

  /** Exposed for diagnostics/tests: the internal log line for a failure. */
  logError(context: string, error: unknown): void {
    this.logger.error(`${context}: ${describeError(error)}`);
  }
}

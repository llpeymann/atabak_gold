import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { RewardGrant } from '../referrals/referral.types';
import { UserStore } from '../users/user.store';

/** Effective alert capacity of one user: the configured base plus applied bonuses. */
export interface EffectiveAlertCapacity {
  /** `MAX_ALERTS_PER_USER` — unchanged, and never reduced by Phase 7. */
  baseLimit: number;
  /** Permanent bonus slots from grant rows with status `GRANTED`. */
  bonusSlots: number;
  /** What the alert subsystem actually enforces for this user. */
  limit: number;
}

/**
 * Phase 7 — the capacity seam between the reward ledger and Phase 3 alerts (§8.3).
 *
 * This is deliberately a **read-only** service: the reward ledger (in the user document) is the single
 * source of truth, and the effective capacity is *derived* from it on every read. There is no second
 * counter to keep in sync, which is why re-applying a reward or replaying an arrival cannot inflate a
 * user's capacity twice.
 *
 * What this class must never do (§8.3): change a plan, grant administrator rights, bypass alert
 * validation, alter delivery rules, or reduce the capacity an existing user already had.
 */
@Injectable()
export class AlertCapacityService {
  constructor(
    private readonly config: AppConfigService,
    private readonly store: UserStore,
  ) {}

  /** Configured base capacity (`MAX_ALERTS_PER_USER`) — the pre-Phase-7 number. */
  get baseLimit(): number {
    return this.config.maxAlertsPerUser;
  }

  /** Documented ceiling for bonus slots, so a misconfigured rule can never mean "unlimited". */
  get maxBonusSlots(): number {
    return this.config.referralMaxBonusSlots;
  }

  /** Reward rows that are actually applied (only these contribute capacity). */
  grantedRewards(userId: string): RewardGrant[] {
    return this.store
      .listRewards(userId)
      .filter(
        (reward) =>
          reward.rewardType === 'ALERT_CAPACITY' && reward.status === 'GRANTED',
      );
  }

  /**
   * Bonus slots of a set of ledger rows, capped at the configured maximum.
   * Used both by the read path and by the reward application step (which cannot exceed the ceiling).
   */
  bonusSlotsFrom(rewards: RewardGrant[]): number {
    const total = rewards
      .filter(
        (reward) =>
          reward.rewardType === 'ALERT_CAPACITY' && reward.status === 'GRANTED',
      )
      .reduce((sum, reward) => {
        const bonus = reward.capacityBonus;

        // A reward is only ever able to *add* capacity: a corrupted or hand-edited row with a zero,
        // negative or non-numeric bonus contributes nothing (§8.3 — existing capacity is never
        // reduced, not even by bad data).
        if (
          typeof bonus !== 'number' ||
          !Number.isFinite(bonus) ||
          bonus <= 0
        ) {
          return sum;
        }

        return sum + bonus;
      }, 0);

    return Math.min(total, this.maxBonusSlots);
  }

  /** Effective capacity computed from an already-loaded ledger (transaction-safe). */
  effectiveLimitFrom(rewards: RewardGrant[]): EffectiveAlertCapacity {
    const bonusSlots = this.bonusSlotsFrom(rewards);

    return {
      baseLimit: this.baseLimit,
      bonusSlots,
      limit: this.baseLimit + bonusSlots,
    };
  }

  /** Effective capacity of a user, read from the persisted ledger. */
  effectiveLimit(userId: string): EffectiveAlertCapacity {
    return this.effectiveLimitFrom(this.store.listRewards(userId));
  }
}

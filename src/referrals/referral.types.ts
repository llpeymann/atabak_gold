import { Platform } from '../platform/platform.types';

/**
 * Phase 7 — Growth Engine domain contracts.
 *
 * The referral system is deliberately small: **one** attribution record per invited user and **one**
 * durable reward ledger. There is no second user model, no separate database and no parallel counter:
 * everything lives in the existing user document (`UserStore`) next to the users it describes.
 *
 * Three concepts are kept strictly apart (§4, §6, §8 of the phase specification):
 *
 *   Referral     — "this user arrived through that user's code", the frozen *successful referral*
 *                  definition is satisfied the moment this row exists (the invitee was registered in
 *                  the same write);
 *   RewardGrant  — one earned threshold of the referral rule, persisted once per (user, type,
 *                  threshold); the effective alert capacity is *derived* from these rows;
 *   Interaction  — the last valid user-initiated interaction timestamp, stored on the user record and
 *                  used only for the active-member reporting metric.
 */

/** The only reward type this phase defines (§8.1) — extra permanent price-alert capacity. */
export type RewardType = 'ALERT_CAPACITY';

/** Reward lifecycle. `PENDING` means "earned and recorded, but not applied yet" (§7.3, §8.4). */
export type RewardStatus = 'PENDING' | 'GRANTED';

/**
 * One successful referral: the invited user was registered while this row was written.
 *
 * `inviteeUserId` is the uniqueness key — a user can be attributed to exactly one inviter, forever
 * (§6.1). The row is written inside the same store transaction as the invited user's registration, so
 * "counted as successful" and "the user exists" can never diverge.
 */
export interface Referral {
  id: string;
  /** Inviter — the owner of the referral code. */
  inviterUserId: string;
  /** Invited user (unique across the whole referral namespace). */
  inviteeUserId: string;
  /** The code that was used (kept for auditing; the code itself is not a credential). */
  code: string;
  /** Platform the invited user arrived from (reporting only). */
  platform: Platform;
  createdAt: string;
}

/**
 * One granted (or pending) reward threshold.
 *
 * `UNIQUE(userId, rewardType, threshold)` is enforced by the store: the same threshold can never be
 * granted twice, not even under concurrent qualification (§8.4). The effective alert capacity is the
 * sum of `capacityBonus` over `GRANTED` rows — a derived entitlement, never a manually incremented
 * counter, which is what makes a retry harmless.
 */
export interface RewardGrant {
  id: string;
  userId: string;
  rewardType: RewardType;
  /** 1 for the first three successful referrals, 2 for six, 3 for nine, … (§8.1). */
  threshold: number;
  status: RewardStatus;
  /** How many successful referrals the inviter had when the threshold was earned (audit only). */
  referralsAtGrant: number;
  /** Capacity slots this grant contributes while `GRANTED` (frozen rule: exactly one). */
  capacityBonus: number;
  createdAt: string;
  grantedAt: string | null;
  /** Set when applying the grant failed; the grant stays recoverable (§8.4). */
  lastError: string | null;
}

/** Outcome of processing an incoming referral payload — every branch is user-facing or logged. */
export type ReferralOutcome =
  /** A new user was registered and the relationship was persisted. */
  | { kind: 'joined'; referrerUserId: string; rewardsGranted: RewardGrant[] }
  /** The invitee was already registered: attribution applies to new users only (§5.2). */
  | { kind: 'existing-user' }
  /** The payload resolved to the invitee's own identity (§6.2). */
  | { kind: 'self-referral' }
  /** The code does not resolve to a user (unknown code, deleted user, …). */
  | { kind: 'unknown-code' }
  /** The referral feature is switched off: nothing is created or modified (§12). */
  | { kind: 'disabled' }
  /** The user was created, but the relationship could not be persisted — never reported as success. */
  | { kind: 'persist-failed' };

/** What the referral screen shows — all values come from persisted data (§7). */
export interface ReferralStats {
  /** Qualified referrals of this user (unique invitee rows). */
  successfulReferrals: number;
  /** Referred users whose last valid interaction is inside the rolling window (§1.2). */
  activeReferrals: number;
  /** Rewards actually applied (ledger rows with status GRANTED) — the source of truth (§7.3). */
  grantedRewards: number;
  /** Thresholds earned by referral count, whether or not they are applied yet. */
  earnedThresholds: number;
  /** Rewards recorded but not applied yet (recoverable, never reported as granted). */
  pendingRewards: number;
  /** Successful referrals still missing for the next threshold. */
  remainingForNextReward: number;
  /** Frozen rule inputs, shown so the UI never has to hardcode them. */
  referralsPerReward: number;
  /** Effective alert capacity = base configuration + granted bonuses (§8.3). */
  effectiveAlertCapacity: number;
  baseAlertCapacity: number;
}

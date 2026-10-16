import { Platform } from '../platform/platform.types';
import { Referral, RewardGrant } from '../referrals/referral.types';

/**
 * Minimal user model for Phase 2, extended by Phase 7.
 *
 * Deliberately tiny: a stable platform identity, a delivery chat, the two Phase 7 fields and
 * timestamps. No names, no phone numbers, no platform profile data — nothing that is not required to
 * keep favorites apart, to attribute a referral or to count activity.
 */
export interface User {
  id: string;
  platform: Platform;
  platformUserId: string;
  /**
   * Chat the user last interacted from (Phase 3): notifications must be delivered to a chat the
   * bot has actually seen. `null` for records created before Phase 3 — the delivery layer then
   * falls back to `platformUserId` (the private-chat identity).
   */
  chatId: string | null;
  /**
   * Phase 7 — stable referral code of this user (assigned once on first registration, never rotated).
   *
   * It is an *attribution identifier*, not a credential: knowing it grants nothing beyond the ability
   * to invite somebody, and it reveals no internal id. `null`/absent for records created before
   * Phase 7 — a code is attached lazily when the user first opens the referral screen, which keeps
   * the backfill collision-safe and id-free (§14).
   */
  referralCode?: string | null;
  /**
   * Phase 7 — last *valid user-initiated* interaction (UTC ISO string), used only for the
   * active-referred-member metric. Outgoing messages, scheduled jobs and malformed requests never
   * touch it. `null`/absent = no interaction recorded yet (treated as inactive, never as "now").
   */
  lastInteractionAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A favorite symbol of a user.
 *
 * `UNIQUE(userId, symbol)` is enforced in the store (see `UserStore.upsertFavorite`); the
 * same pair can never be persisted twice, not even under concurrent requests.
 */
export interface Favorite {
  id: string;
  userId: string;
  symbol: string;
  createdAt: string;
  updatedAt: string;
}

/** Outcome of a favorite mutation — a rejected action is always explained, never silent. */
export type FavoriteMutationResult =
  | { ok: true; action: 'added' | 'removed' | 'unchanged'; favorite?: Favorite }
  | {
      ok: false;
      reason: 'LIMIT_REACHED' | 'UNKNOWN_SYMBOL' | 'USER_NOT_FOUND';
      limit?: number;
    };

/**
 * The persisted user document.
 *
 * Phase 7 adds two collections to the *existing* document — no second database, no migration step that
 * rewrites the file by hand: `version 1` documents (users + favorites only) load unchanged and the new
 * collections start empty (§14).
 */
export interface PersistedUserData {
  version: number;
  savedAt: string;
  users: User[];
  favorites: Favorite[];
  /** Phase 7 — successful referrals (one row per invited user). */
  referrals: Referral[];
  /** Phase 7 — durable reward ledger; the effective alert capacity is derived from it. */
  rewards: RewardGrant[];
}

/** Highest document version this build writes. */
export const USER_DATA_VERSION = 2;

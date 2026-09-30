import { Platform } from '../platform/platform.types';

/**
 * Minimal user model for Phase 2.
 *
 * Deliberately tiny: a stable platform identity plus timestamps. No names, no phone numbers,
 * no platform profile data — nothing that is not required to keep favorites apart.
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

export interface PersistedUserData {
  version: number;
  savedAt: string;
  users: User[];
  favorites: Favorite[];
}

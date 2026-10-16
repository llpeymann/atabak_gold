import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppConfigService } from '../config/app-config.service';
import { describeError } from '../common/log-safety';
import { Referral, RewardGrant } from '../referrals/referral.types';
import {
  Favorite,
  PersistedUserData,
  User,
  USER_DATA_VERSION,
} from './user.types';

/**
 * Persistence for users and favorites.
 *
 * Phase 2 deliberately reuses the persistence *technology* already proven in Phase 1
 * (`MarketStateStore`): a single JSON document written atomically (tmp file + rename) into a
 * configurable path. No second database is introduced for two small collections (§60).
 *
 * Guarantees:
 *  - `UNIQUE(userId, symbol)` for favorites is enforced here before every write,
 *  - writes are serialized through an internal queue, so two concurrent mutations can never
 *    interleave into a lost update (deterministic final state, §42),
 *  - a missing/corrupt file is tolerated: the bot starts empty and logs it (§33, §59).
 */
@Injectable()
export class UserStore {
  private readonly logger = new Logger(UserStore.name);
  private readonly filePath: string | null;
  private users = new Map<string, User>();
  private favorites = new Map<string, Favorite>();
  // Phase 7 — referral attribution and the reward ledger, kept in the same document as the users.
  private referralCodes = new Map<string, string>();
  private referrals = new Map<string, Referral>();
  private rewards = new Map<string, RewardGrant>();
  private loaded = false;
  /** Serializes write operations (last writer in the queue persists the newest state). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfigService) {
    this.filePath = this.config.userDataFile;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  /** Load once, on first use (bootstrap does it explicitly too). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await this.load();
  }

  async load(): Promise<void> {
    this.loaded = true;

    if (!this.filePath) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (!this.isPersistedUserData(parsed)) {
        this.logger.warn(
          `User data file ${this.filePath} has an unexpected shape — starting with empty user data.`,
        );
        return;
      }

      for (const user of parsed.users) {
        if (this.isUserShape(user)) {
          this.users.set(user.id, user);

          // The code index is derived from the users: it is a lookup structure, not a second source
          // of truth, so a lost index can never lose a code.
          if (
            typeof user.referralCode === 'string' &&
            user.referralCode !== ''
          ) {
            this.referralCodes.set(user.referralCode, user.id);
          }
        }
      }

      for (const favorite of parsed.favorites) {
        if (this.isFavoriteShape(favorite)) {
          this.favorites.set(this.favoriteKey(favorite), favorite);
        }
      }

      for (const referral of parsed.referrals ?? []) {
        if (this.isReferralShape(referral)) {
          this.referrals.set(referral.inviteeUserId, referral);
        }
      }

      for (const reward of parsed.rewards ?? []) {
        if (this.isRewardShape(reward)) {
          this.rewards.set(this.rewardKey(reward), reward);
        }
      }

      this.logger.log(
        `Restored ${this.users.size} user(s) and ${this.favorites.size} favorite(s) from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted user data found at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read user data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  /** All users (defensive copy — callers must not mutate in-memory state). */
  listUsers(): User[] {
    return [...this.users.values()].map((user) => ({ ...user }));
  }

  findUser(userId: string): User | null {
    const user = this.users.get(userId);

    return user ? { ...user } : null;
  }

  /**
   * Resolve (or create) the user behind a platform identity.
   * `chatId` is refreshed on every interaction so notifications always target a chat the bot has
   * seen (an older record without one keeps working via the platform identity fallback).
   */
  async upsertUser(
    platformUserId: string,
    platform: User['platform'],
    chatId: string | null = null,
  ): Promise<User> {
    await this.ensureLoaded();

    const existing = this.findUserByPlatform(platform, platformUserId);
    const now = new Date().toISOString();

    if (existing) {
      const updated: User = {
        ...existing,
        chatId: chatId ?? existing.chatId ?? null,
        updatedAt: now,
      };
      this.users.set(updated.id, updated);
      await this.persist();

      return { ...updated };
    }

    const user: User = {
      id: this.nextId('usr'),
      platform,
      platformUserId,
      chatId,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(user.id, user);
    await this.persist();

    return { ...user };
  }

  /**
   * Test/restore seam: registers a previously persisted user without touching timestamps.
   */
  hydrateUser(user: User): void {
    this.users.set(user.id, { ...user });
  }

  /** Favorites of exactly one user. Another user's data is unreachable through this API. */
  listFavorites(userId: string): Favorite[] {
    return [...this.favorites.values()]
      .filter((favorite) => favorite.userId === userId)
      .map((favorite) => ({ ...favorite }));
  }

  async addFavorite(userId: string, symbol: string): Promise<Favorite> {
    await this.ensureLoaded();

    const key = this.favoriteKey({ userId, symbol });
    const existing = this.favorites.get(key);

    if (existing) {
      // Idempotent: a repeated add is not an error and never creates a duplicate row.
      return { ...existing };
    }

    const now = new Date().toISOString();
    const favorite: Favorite = {
      id: this.nextId('fav'),
      userId,
      symbol,
      createdAt: now,
      updatedAt: now,
    };

    this.favorites.set(key, favorite);
    await this.persist();

    return { ...favorite };
  }

  async removeFavorite(userId: string, symbol: string): Promise<boolean> {
    await this.ensureLoaded();

    const key = this.favoriteKey({ userId, symbol });
    const removed = this.favorites.delete(key);

    if (removed) {
      await this.persist();
    }

    return removed;
  }

  /** Number of persisted favorites (used by tests/diagnostics). */
  get favoriteCount(): number {
    return this.favorites.size;
  }

  // --- Phase 7: transactions, referral attribution, reward ledger, activity ---

  /**
   * Run a multi-record operation under one critical section and persist the result **once**.
   *
   * The whole state lives in a single JSON document written atomically (tmp file + rename), so a
   * transaction here means exactly what it says: the invited user's registration, the referral row and
   * the reward rows of one arrival are written in the same snapshot — either all of them are in the new
   * document or none of them are (§6.4). This is the *only* place where referral state is mutated,
   * which is what keeps "counted as successful" and "the user exists" from diverging.
   *
   * `persisted` reports whether the snapshot reached the disk: when the write failed (read-only volume,
   * full disk, …), the operation result is kept in memory but the caller must not report durable success
   * (§8.4). Concurrency is handled by the store's write chain — never by an in-memory lock in a service.
   */
  async transact<T>(
    operation: (tx: UserTransaction) => T,
  ): Promise<UserTransactionResult<T>> {
    await this.ensureLoaded();

    const run = this.writeChain.then(async () => {
      const tx = new UserTransactionImpl({
        users: this.users,
        favorites: this.favorites,
        referralCodes: this.referralCodes,
        referrals: this.referrals,
        rewards: this.rewards,
      });

      const result = operation(tx);

      // Write directly: we are already inside the serialized section, so queueing through
      // `persist()` (which appends to the same chain) would wait for ourselves.
      const persisted = tx.dirty ? await this.writeFile(this.snapshot()) : true;

      return { result, persisted };
    });

    // Keep the chain alive even if an operation throws, so a failed transaction cannot deadlock the
    // next one (the error still reaches the caller).
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  /** All referrals of one inviter (newest last) — the only read path the statistics use. */
  listReferralsByInviter(inviterUserId: string): Referral[] {
    return [...this.referrals.values()]
      .filter((referral) => referral.inviterUserId === inviterUserId)
      .map((referral) => ({ ...referral }));
  }

  /** All referral rows (diagnostics/tests only). */
  listReferrals(): Referral[] {
    return [...this.referrals.values()].map((referral) => ({ ...referral }));
  }

  /** The reward ledger of one user, ordered by threshold. */
  listRewards(userId: string): RewardGrant[] {
    return [...this.rewards.values()]
      .filter((reward) => reward.userId === userId)
      .sort((left, right) => left.threshold - right.threshold)
      .map((reward) => ({ ...reward }));
  }

  /** Resolve a referral code to the user that owns it (`null` when the code is unknown). */
  findUserByReferralCode(code: string): User | null {
    const userId = this.referralCodes.get(code);

    if (!userId) {
      return null;
    }

    return this.findUser(userId);
  }

  /**
   * Record (or refresh) the last valid user-initiated interaction (Phase 7 activity metric).
   *
   * Only the central inbound path calls this, and only for a real user action — publishers, schedulers
   * and automated deliveries never do, which is what keeps the "active member" number honest (§1.2).
   * Returns `false` when the timestamp did not reach the disk.
   */
  async touchInteraction(userId: string, at: string): Promise<boolean> {
    await this.ensureLoaded();

    const user = this.users.get(userId);

    if (!user) {
      return false;
    }

    if (user.lastInteractionAt === at) {
      return true;
    }

    const outcome = await this.transact((tx) => {
      tx.touchInteraction(userId, at);
    });

    if (!outcome.persisted) {
      this.logger.error(
        `Could not persist the interaction timestamp of ${userId} (last activity kept in memory).`,
      );
    }

    return outcome.persisted;
  }

  private rewardKey(
    reward: Pick<RewardGrant, 'userId' | 'rewardType' | 'threshold'>,
  ): string {
    return `${reward.userId}::${reward.rewardType}::${reward.threshold}`;
  }

  /**
   * The user behind a platform identity, or `null` when this identity has never been seen.
   * Phase 7 needs this *before* a user is created: only a genuinely new user may be attributed to an
   * inviter (§1.1, §5.1).
   */
  findUserByPlatform(
    platform: User['platform'],
    platformUserId: string,
  ): User | null {
    for (const user of this.users.values()) {
      if (
        user.platform === platform &&
        user.platformUserId === platformUserId
      ) {
        return user;
      }
    }

    return null;
  }

  private favoriteKey(favorite: Pick<Favorite, 'userId' | 'symbol'>): string {
    return `${favorite.userId}::${favorite.symbol}`;
  }

  private nextId(prefix: string): string {
    // Collision-proof within the process and stable across restarts (stored, never derived).
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  /**
   * Atomic write of the whole document. Serialized so concurrent mutations always persist the
   * latest consistent snapshot instead of racing each other.
   */
  private persist(): Promise<boolean> {
    const snapshot = this.snapshot();

    const write = this.writeChain.then(() => this.writeFile(snapshot));

    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );

    return write;
  }

  /** `false` means the snapshot did not reach the disk — callers must not report durable success. */
  private async writeFile(payload: PersistedUserData): Promise<boolean> {
    if (!this.filePath) {
      return true;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);

      return true;
    } catch (error) {
      this.logger.error(
        `Could not persist user data to ${this.filePath}: ${describeError(error)}`,
      );

      return false;
    }
  }

  private snapshot(): PersistedUserData {
    return {
      version: USER_DATA_VERSION,
      savedAt: new Date().toISOString(),
      users: [...this.users.values()].map((user) => ({ ...user })),
      favorites: [...this.favorites.values()].map((favorite) => ({
        ...favorite,
      })),
      referrals: [...this.referrals.values()].map((referral) => ({
        ...referral,
      })),
      rewards: [...this.rewards.values()].map((reward) => ({ ...reward })),
    };
  }

  private isPersistedUserData(value: unknown): value is PersistedUserData {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<PersistedUserData>;

    return Array.isArray(candidate.users) && Array.isArray(candidate.favorites);
  }

  private isUserShape(value: unknown): value is User {
    const candidate = value as Partial<User> | null;

    if (
      typeof candidate?.id !== 'string' ||
      typeof candidate.platformUserId !== 'string' ||
      (candidate.platform !== 'bale' && candidate.platform !== 'telegram')
    ) {
      return false;
    }

    // Records persisted before Phase 3 have no chat id: normalize instead of dropping them.
    if (typeof candidate.chatId !== 'string') {
      candidate.chatId = null;
    }

    // Records persisted before Phase 7 have no interaction timestamp: absent means "no interaction
    // recorded", which the active-member metric reads as inactive (never as "now").
    if (typeof candidate.lastInteractionAt !== 'string') {
      candidate.lastInteractionAt = null;
    }

    return true;
  }

  private isReferralShape(value: unknown): value is Referral {
    const candidate = value as Partial<Referral> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.inviterUserId === 'string' &&
      typeof candidate.inviteeUserId === 'string'
    );
  }

  private isRewardShape(value: unknown): value is RewardGrant {
    const candidate = value as Partial<RewardGrant> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.userId === 'string' &&
      candidate.rewardType === 'ALERT_CAPACITY' &&
      typeof candidate.threshold === 'number' &&
      Number.isInteger(candidate.threshold) &&
      candidate.threshold >= 1
    );
  }

  private isFavoriteShape(value: unknown): value is Favorite {
    const candidate = value as Partial<Favorite> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.userId === 'string' &&
      typeof candidate.symbol === 'string'
    );
  }
}

/**
 * Result of a transaction: the operation's own value plus whether the snapshot reached the disk.
 *
 * The distinction matters for the referral flow: an in-memory-only success must never be reported to
 * the user as a persisted referral or a granted reward (§6.4, §8.4).
 */
export interface UserTransactionResult<T> {
  result: T;
  persisted: boolean;
}

/**
 * The mutation surface available inside `UserStore.transact`.
 *
 * Deliberately narrow: creation of a user (with the "created vs. already known" signal the referral
 * flow needs), persistence of a referral relationship, the reward ledger and the activity timestamp.
 * Favorites and other concerns keep using their existing methods.
 */
export interface UserTransaction {
  /** The stored user for an internal id, or `null`. */
  findUser(userId: string): User | null;
  /** The stored user behind a platform identity, or `null` (used to detect a genuinely new user). */
  findByPlatform(
    platform: User['platform'],
    platformUserId: string,
  ): User | null;
  /** The owner of a referral code, or `null` when the code is unknown. */
  findByReferralCode(code: string): User | null;
  /**
   * Create the user when the platform identity is unknown, or update the existing record.
   * `created` is `true` only for a genuinely new identity — the referral flow attributes on that
   * signal alone, so a repeated `/start` can never re-attribute or double count (§6.1).
   */
  upsertUser(input: UserUpsertInput): { user: User; created: boolean };
  /** Attach a code to a user once; returns the code actually stored (existing one wins). */
  assignReferralCode(userId: string, code: string): string | null;
  /** True when the invitee is already attributed to some inviter (uniqueness key). */
  hasReferralFor(inviteeUserId: string): boolean;
  /** Persist a successful referral; returns `false` when it was already present (idempotent). */
  saveReferral(referral: Referral): boolean;
  /** Persist a reward row; returns `false` when this threshold already exists (idempotent). */
  saveReward(reward: RewardGrant): boolean;
  /** Ledger rows of one user, ordered by threshold. */
  listRewards(userId: string): RewardGrant[];
  /** Successful referral count of an inviter inside the same critical section. */
  countReferralsByInviter(inviterUserId: string): number;
  /** Replace a ledger row (status transition PENDING → GRANTED / retry bookkeeping). */
  updateReward(
    userId: string,
    rewardType: RewardGrant['rewardType'],
    threshold: number,
    patch: Partial<RewardGrant>,
  ): boolean;
  /** Update the rolling activity timestamp of a user. */
  touchInteraction(userId: string, at: string): boolean;
  /** Mint an id in the shared store namespace. */
  nextId(prefix: string): string;
}

/**
 * Input accepted by `UserTransaction.upsertUser` — the same three values as the existing
 * `upsertUser`, plus the code to attach when the record is created.
 */
export interface UserUpsertInput {
  platformUserId: string;
  platform: User['platform'];
  chatId: string | null;
  referralCode?: string | null;
}

/** The only writer of `UserStore` state during a transaction. */
class UserTransactionImpl implements UserTransaction {
  private mutationCount = 0;

  constructor(
    private readonly state: {
      users: Map<string, User>;
      favorites: Map<string, Favorite>;
      referralCodes: Map<string, string>;
      referrals: Map<string, Referral>;
      rewards: Map<string, RewardGrant>;
    },
  ) {}

  /** Anything mutated during this transaction? (Drives the single write.) */
  get dirty(): boolean {
    return this.mutationCount > 0;
  }

  findUser(userId: string): User | null {
    const user = this.state.users.get(userId);

    return user ? { ...user } : null;
  }

  findByPlatform(
    platform: User['platform'],
    platformUserId: string,
  ): User | null {
    for (const user of this.state.users.values()) {
      if (
        user.platform === platform &&
        user.platformUserId === platformUserId
      ) {
        return { ...user };
      }
    }

    return null;
  }

  findByReferralCode(code: string): User | null {
    const userId = this.state.referralCodes.get(code);

    return userId ? this.findUser(userId) : null;
  }

  upsertUser(input: UserUpsertInput): { user: User; created: boolean } {
    const existing = this.findByPlatform(input.platform, input.platformUserId);
    const now = new Date().toISOString();

    if (existing) {
      const updated: User = {
        ...existing,
        chatId: input.chatId ?? existing.chatId ?? null,
        updatedAt: now,
      };

      this.state.users.set(updated.id, updated);
      this.mutationCount += 1;

      return { user: { ...updated }, created: false };
    }

    const id = this.nextId('usr');
    const created: User = {
      id,
      platform: input.platform,
      platformUserId: input.platformUserId,
      chatId: input.chatId,
      referralCode: input.referralCode ?? null,
      lastInteractionAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.state.users.set(id, created);
    this.mutationCount += 1;

    if (created.referralCode) {
      this.state.referralCodes.set(created.referralCode, id);
    }

    return { user: { ...created }, created: true };
  }

  assignReferralCode(userId: string, code: string): string | null {
    const user = this.state.users.get(userId);

    if (!user) {
      return null;
    }

    if (user.referralCode) {
      return user.referralCode;
    }

    const updated: User = {
      ...user,
      referralCode: code,
      updatedAt: new Date().toISOString(),
    };

    this.state.users.set(userId, updated);
    this.state.referralCodes.set(code, userId);
    this.mutationCount += 1;

    return code;
  }

  hasReferralFor(inviteeUserId: string): boolean {
    return this.state.referrals.has(inviteeUserId);
  }

  saveReferral(referral: Referral): boolean {
    if (this.state.referrals.has(referral.inviteeUserId)) {
      return false;
    }

    this.state.referrals.set(referral.inviteeUserId, { ...referral });
    this.mutationCount += 1;

    return true;
  }

  saveReward(reward: RewardGrant): boolean {
    const key = rewardKeyOf(reward);

    if (this.state.rewards.has(key)) {
      return false;
    }

    this.state.rewards.set(key, { ...reward });
    this.mutationCount += 1;

    return true;
  }

  listRewards(userId: string): RewardGrant[] {
    return [...this.state.rewards.values()]
      .filter((reward) => reward.userId === userId)
      .sort((left, right) => left.threshold - right.threshold)
      .map((reward) => ({ ...reward }));
  }

  countReferralsByInviter(inviterUserId: string): number {
    let count = 0;

    for (const referral of this.state.referrals.values()) {
      if (referral.inviterUserId === inviterUserId) {
        count += 1;
      }
    }

    return count;
  }

  updateReward(
    userId: string,
    rewardType: RewardGrant['rewardType'],
    threshold: number,
    patch: Partial<RewardGrant>,
  ): boolean {
    const key = rewardKeyOf({ userId, rewardType, threshold });
    const existing = this.state.rewards.get(key);

    if (!existing) {
      return false;
    }

    this.state.rewards.set(key, { ...existing, ...patch });
    this.mutationCount += 1;

    return true;
  }

  touchInteraction(userId: string, at: string): boolean {
    const user = this.state.users.get(userId);

    if (!user) {
      return false;
    }

    this.state.users.set(userId, { ...user, lastInteractionAt: at });
    this.mutationCount += 1;

    return true;
  }

  nextId(prefix: string): string {
    // Same shape as `UserStore.nextId` (stored, never derived) — collision-proof within the process.
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function rewardKeyOf(
  reward: Pick<RewardGrant, 'userId' | 'rewardType' | 'threshold'>,
): string {
  return `${reward.userId}::${reward.rewardType}::${reward.threshold}`;
}

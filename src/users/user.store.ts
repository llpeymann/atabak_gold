import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppConfigService } from '../config/app-config.service';
import { describeError } from '../common/log-safety';
import { Favorite, PersistedUserData, User } from './user.types';

const USER_DATA_VERSION = 1;

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
        }
      }

      for (const favorite of parsed.favorites) {
        if (this.isFavoriteShape(favorite)) {
          this.favorites.set(this.favoriteKey(favorite), favorite);
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

  private findUserByPlatform(
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
  private persist(): Promise<void> {
    const snapshot = this.snapshot();

    this.writeChain = this.writeChain.then(() => this.writeFile(snapshot));

    return this.writeChain;
  }

  private async writeFile(payload: PersistedUserData): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      this.logger.error(
        `Could not persist user data to ${this.filePath}: ${describeError(error)}`,
      );
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

    return true;
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

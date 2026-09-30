import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import { UserStore } from './user.store';
import { FavoriteMutationResult, User } from './user.types';

/** One entry of a resolved favorites list (state may legitimately be missing). */
export interface FavoriteEntry {
  symbol: string;
}

/**
 * User-facing identity and favorites rules.
 *
 * Everything that decides *whether* a favorite may change lives here, so the bot router stays
 * a pure presenter:
 *  - the symbol is validated against the canonical Phase 1 registry (never a local list),
 *  - the configurable `MAX_FAVORITES` limit is enforced before any write,
 *  - every mutation is scoped to the user resolved from the platform identity — a callback
 *    payload can never address another user's data (§41, §52).
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: UserStore,
  ) {}

  get maxFavorites(): number {
    return this.config.maxFavorites;
  }

  /** Resolve or create the user behind the platform identity. */
  async resolveUser(
    platform: Platform,
    platformUserId: string,
    chatId: string | null = null,
  ): Promise<User> {
    return this.store.upsertUser(platformUserId, platform, chatId);
  }

  /** Valid symbols come from the Phase 1 registry — no duplicate list exists in the bot. */
  isSupportedSymbol(symbol: string): boolean {
    return this.config.symbolRegistry.some(
      (definition) => definition.symbol === symbol,
    );
  }

  listFavoriteSymbols(userId: string): string[] {
    return this.store
      .listFavorites(userId)
      .map((favorite) => favorite.symbol)
      .filter((symbol) => this.isSupportedSymbol(symbol));
  }

  isFavorite(userId: string, symbol: string): boolean {
    return this.store
      .listFavorites(userId)
      .some((favorite) => favorite.symbol === symbol);
  }

  async addFavorite(
    userId: string,
    symbol: string,
  ): Promise<FavoriteMutationResult> {
    if (!this.store.findUser(userId)) {
      return { ok: false, reason: 'USER_NOT_FOUND' };
    }

    if (!this.isSupportedSymbol(symbol)) {
      this.logger.warn(
        `Rejected favorite for unsupported symbol "${symbol}" (user ${userId}).`,
      );
      return { ok: false, reason: 'UNKNOWN_SYMBOL' };
    }

    if (this.isFavorite(userId, symbol)) {
      // Idempotent: pressing an already-selected symbol is not an error.
      return { ok: true, action: 'unchanged' };
    }

    const limit = this.maxFavorites;
    if (this.store.listFavorites(userId).length >= limit) {
      return { ok: false, reason: 'LIMIT_REACHED', limit };
    }

    const favorite = await this.store.addFavorite(userId, symbol);

    return { ok: true, action: 'added', favorite };
  }

  async removeFavorite(
    userId: string,
    symbol: string,
  ): Promise<FavoriteMutationResult> {
    if (!this.store.findUser(userId)) {
      return { ok: false, reason: 'USER_NOT_FOUND' };
    }

    if (!this.isSupportedSymbol(symbol)) {
      this.logger.warn(
        `Rejected removal of unsupported symbol "${symbol}" (user ${userId}).`,
      );
      return { ok: false, reason: 'UNKNOWN_SYMBOL' };
    }

    const removed = await this.store.removeFavorite(userId, symbol);

    return { ok: true, action: removed ? 'removed' : 'unchanged' };
  }
}

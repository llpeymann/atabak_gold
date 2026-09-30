import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { describeError } from '../../common/log-safety';
import { SECTION_NAMES } from '../../market/symbols';
import { User } from '../../users/user.types';
import { UserService } from '../../users/user.service';
import { PlatformRegistry } from '../../platform/platform-registry.service';
import { asCommand, PlatformAdapter } from '../../platform/platform-adapter';
import {
  InboundCallback,
  InboundMessage,
  InboundUpdate,
  Keyboard,
  Platform,
} from '../../platform/platform.types';
import { CallbackAction, parseCallbackData, ScreenKey } from './callback-data';
import { MarketViewService } from './market-view.service';
import { UxEventLogService } from './ux-event-log.service';
import {
  formatAlertsPlaceholder,
  formatChannelScreen,
  formatEmptySection,
  formatExpiredCallback,
  formatFavoriteLimitReached,
  formatFavoritesManageScreen,
  formatFavoritesScreen,
  formatMarketSnapshot,
  formatMenuScreen,
  formatPriceScreen,
  formatWelcomeScreen,
} from './ux-format';
import {
  channelKeyboard,
  expiredCallbackKeyboard,
  favoritesKeyboard,
  favoritesManageKeyboard,
  mainMenuKeyboard,
  menuKeyboard,
  pricesKeyboard,
  screenFooter,
  sectionKeyboard,
} from './ux-keyboards';

/** Logical screens; `menu` and `favorites-manage` are navigation states, not callbacks (§39). */
type UxScreen = ScreenKey | 'menu' | 'favorites-manage' | 'expired';

/** Callback actions that simply open a screen (everything except favorite mutations). */
type NavigationAction = Extract<
  CallbackAction,
  { kind: 'menu' | 'home' | 'back' | 'noop' | 'screen' | 'manage-favorites' }
>;

interface NavigationState {
  screen: UxScreen;
}

interface RenderedScreen {
  screen: UxScreen;
  text: string;
  keyboard: Keyboard;
}

/**
 * Bot UX router.
 *
 * Responsibilities (§4): receive interactions, route commands and buttons, keep navigation
 * state, read validated market state, manage favorites, format answers and send them through the
 * platform adapter.
 *
 * Explicitly *not* a responsibility: fetching external market data, validating prices,
 * calculating changes/daily statistics, mutating market state, or implementing alerts.
 * The only market dependency is `MarketViewService`, which is a read-only projection of the
 * Phase 1 state — so a user interaction physically cannot reach the external API (§3, §50).
 */
@Injectable()
export class BotUxService {
  private readonly logger = new Logger(BotUxService.name);
  /** Navigation state is intentionally in-memory: it may reset on restart (§33). */
  private readonly sessions = new Map<string, NavigationState>();

  constructor(
    private readonly config: AppConfigService,
    private readonly platformRegistry: PlatformRegistry,
    private readonly views: MarketViewService,
    private readonly users: UserService,
    private readonly events: UxEventLogService,
  ) {}

  /** Entry point used by the inbound poller (and by tests). Never throws for bad input. */
  async handleUpdate(update: InboundUpdate): Promise<void> {
    if (update.kind === 'ignored') {
      this.events.record('update_ignored', {
        platform: update.platform,
        screen: update.reason,
      });
      return;
    }

    const adapter = this.platformRegistry.resolve(update.platform);

    if (!adapter) {
      this.logger.warn(
        `Ignored an update from an unconfigured platform: ${update.platform}.`,
      );
      return;
    }

    try {
      const user = await this.users.resolveUser(
        update.platform,
        update.platformUserId,
      );

      if (update.kind === 'callback') {
        await this.handleCallback(adapter, user, update);
      } else {
        await this.handleMessage(adapter, user, update);
      }
    } catch (error) {
      // The user gets a safe message; the technical detail stays server-side (§24, §49).
      this.logger.error(
        `Failed to handle update ${update.updateId} on ${update.platform}: ${describeError(error)}`,
      );
      await this.sendSafeFailure(adapter, update);
    }
  }

  // --- inbound handling -------------------------------------------------------

  private async handleMessage(
    adapter: PlatformAdapter,
    user: User,
    message: InboundMessage,
  ): Promise<void> {
    const command = asCommand(message);

    if (command === 'start') {
      this.events.record('start', {
        platform: adapter.platform,
        userId: user.id,
      });
      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: formatWelcomeScreen(),
        keyboard: mainMenuKeyboard(),
      });
      return;
    }

    if (command === 'menu' || (command === null && message.text === null)) {
      this.events.record('menu_open', {
        platform: adapter.platform,
        userId: user.id,
      });
      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: formatMenuScreen(),
        keyboard: menuKeyboard(),
      });
      return;
    }

    if (command === 'prices') {
      const screen = this.renderScreen('prices', user.id);
      this.remember(user.id, 'prices');
      this.events.record('prices_view', {
        platform: adapter.platform,
        userId: user.id,
        screen: 'prices',
      });
      await adapter.render({
        chatId: message.chatId,
        text: screen.text,
        keyboard: screen.keyboard,
      });
      return;
    }

    // Anything else is not a command the product supports: stay helpful, do not invent APIs.
    this.events.record('unknown_command', {
      platform: adapter.platform,
      userId: user.id,
      screen: 'menu',
    });
    this.remember(user.id, 'menu');
    await adapter.render({
      chatId: message.chatId,
      text: formatMenuScreen(),
      keyboard: menuKeyboard(),
    });
  }

  private async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callback: InboundCallback,
  ): Promise<void> {
    const action = parseCallbackData(callback.data);

    // Acknowledge first: the platform stops the loading spinner and the user gets immediate
    // feedback even when the requested screen is being rendered (§26).
    await adapter.acknowledge(callback.callbackId);

    if (!action) {
      this.events.record('invalid_callback', {
        platform: adapter.platform,
        userId: user.id,
      });
      this.logger.warn(
        `Invalid or outdated callback data from user ${user.id}: "${truncateForLog(callback.data)}".`,
      );

      const rendered = this.expiredScreen();
      this.remember(user.id, 'expired');
      await adapter.render({
        chatId: callback.chatId,
        text: rendered.text,
        keyboard: rendered.keyboard,
        editMessageId: callback.messageId,
      });
      return;
    }

    if (action.kind === 'favorite') {
      await this.handleFavoriteAction(
        adapter,
        user,
        callback,
        action.op,
        action.symbol,
      );
      return;
    }

    const target = this.resolveTarget(action, user.id);
    const rendered = this.renderScreen(target, user.id);
    this.remember(user.id, rendered.screen);

    this.recordScreenEvent(action, user, adapter.platform);

    await adapter.render({
      chatId: callback.chatId,
      text: rendered.text,
      keyboard: rendered.keyboard,
      editMessageId: callback.messageId,
    });
  }

  private async handleFavoriteAction(
    adapter: PlatformAdapter,
    user: User,
    callback: InboundCallback,
    op: 'add' | 'remove',
    symbol: string,
  ): Promise<void> {
    // The symbol is validated against the canonical registry inside `UserService`; ownership
    // always comes from the resolved user, never from the callback payload (§41, §52).
    const result =
      op === 'add'
        ? await this.users.addFavorite(user.id, symbol)
        : await this.users.removeFavorite(user.id, symbol);

    if (!result.ok && result.reason === 'LIMIT_REACHED') {
      const limit = result.limit ?? this.users.maxFavorites;
      this.events.record('favorite_limit_reached', {
        platform: adapter.platform,
        userId: user.id,
        symbol,
      });
      await adapter.acknowledge(
        callback.callbackId,
        formatFavoriteLimitReached(limit),
      );
    } else if (!result.ok && result.reason === 'UNKNOWN_SYMBOL') {
      this.events.record('favorite_unknown_symbol', {
        platform: adapter.platform,
        userId: user.id,
        symbol,
      });
      await adapter.acknowledge(
        callback.callbackId,
        'این نماد پشتیبانی نمیشود.',
      );
    } else if (result.ok && result.action === 'added') {
      this.events.record('favorite_added', {
        platform: adapter.platform,
        userId: user.id,
        symbol,
      });
    } else if (result.ok && result.action === 'removed') {
      this.events.record('favorite_removed', {
        platform: adapter.platform,
        userId: user.id,
        symbol,
      });
    } else if (result.ok && result.action === 'unchanged') {
      this.events.record('favorite_duplicate', {
        platform: adapter.platform,
        userId: user.id,
        symbol,
      });
    }

    const rendered = this.renderScreen('favorites-manage', user.id);
    this.remember(user.id, 'favorites-manage');

    await adapter.render({
      chatId: callback.chatId,
      text: rendered.text,
      keyboard: rendered.keyboard,
      editMessageId: callback.messageId,
    });
  }

  private resolveTarget(action: NavigationAction, userId: string): UxScreen {
    switch (action.kind) {
      case 'screen':
        return action.screen;
      case 'manage-favorites':
        return 'favorites-manage';
      case 'back':
        return this.parentOf(this.currentScreen(userId));
      case 'menu':
      case 'home':
      case 'noop':
      default:
        return 'menu';
    }
  }

  private recordScreenEvent(
    action: NavigationAction,
    user: User,
    platform: Platform,
  ): void {
    const base = { platform, userId: user.id };

    switch (action.kind) {
      case 'screen':
        switch (action.screen) {
          case 'prices':
            this.events.record('prices_view', base);
            return;
          case 'gold':
            this.events.record('gold_view', base);
            return;
          case 'coins':
            this.events.record('coin_view', base);
            return;
          case 'market':
            this.events.record('market_view', base);
            return;
          case 'favorites':
            this.events.record('favorites_view', base);
            return;
          case 'alerts':
            this.events.record('alerts_clicked', base);
            return;
          case 'channel':
            this.events.record('channel_clicked', base);
            return;
          default:
            return;
        }
      case 'manage-favorites':
        this.events.record('favorites_manage_open', base);
        return;
      case 'back':
        this.events.record('back', base);
        return;
      case 'menu':
      case 'home':
        this.events.record('home', base);
        return;
      default:
        return;
    }
  }

  // --- rendering --------------------------------------------------------------

  private renderScreen(screen: UxScreen, userId: string): RenderedScreen {
    const now = new Date();
    const displayUnit = this.config.displayUnit;

    switch (screen) {
      case 'menu':
        return {
          screen: 'menu',
          text: formatMenuScreen(),
          keyboard: menuKeyboard(),
        };

      case 'prices': {
        const view = this.views.buildPriceList(
          ['gold', 'coins', 'currency'],
          now,
        );
        return {
          screen: 'prices',
          text: formatPriceScreen('💰 قیمت لحظهای بازار', view, displayUnit, {
            emptyText: formatEmptySection('بازار'),
          }),
          keyboard: pricesKeyboard(),
        };
      }

      case 'gold': {
        const view = this.views.buildPriceList(['gold'], now);
        return {
          screen: 'gold',
          text: formatPriceScreen('🟡 طلا', view, displayUnit, {
            emptyText: formatEmptySection(SECTION_NAMES.gold),
            includeSectionTitles: false,
          }),
          keyboard: sectionKeyboard('gold'),
        };
      }

      case 'coins': {
        const view = this.views.buildPriceList(['coins'], now);
        return {
          screen: 'coins',
          text: formatPriceScreen('🪙 سکه', view, displayUnit, {
            emptyText: formatEmptySection(SECTION_NAMES.coins),
            includeSectionTitles: false,
          }),
          keyboard: sectionKeyboard('coins'),
        };
      }

      case 'market': {
        const view = this.views.buildMarketSnapshot(now);
        return {
          screen: 'market',
          text: formatMarketSnapshot(view, displayUnit),
          keyboard: sectionKeyboard('market'),
        };
      }

      case 'favorites': {
        const symbols = this.users.listFavoriteSymbols(userId);
        const view = this.views.buildPriceListForSymbols(symbols, now);
        return {
          screen: 'favorites',
          text: formatFavoritesScreen(
            view,
            displayUnit,
            this.users.maxFavorites,
          ),
          keyboard: favoritesKeyboard(),
        };
      }

      case 'favorites-manage': {
        const view = this.views.buildFavoritesManage(userId);
        return {
          screen: 'favorites-manage',
          text: formatFavoritesManageScreen(view),
          keyboard: favoritesManageKeyboard(view),
        };
      }

      case 'alerts':
        return {
          screen: 'alerts',
          text: formatAlertsPlaceholder(),
          // A placeholder has nothing to refresh: only back and home make sense here.
          keyboard: screenFooter(),
        };

      case 'channel':
        return {
          screen: 'channel',
          text: formatChannelScreen(this.config.channelHandle),
          keyboard: channelKeyboard(this.config.channelUrl),
        };

      default:
        return this.expiredScreen();
    }
  }

  private expiredScreen(): RenderedScreen {
    return {
      screen: 'expired',
      text: formatExpiredCallback(),
      keyboard: expiredCallbackKeyboard(),
    };
  }

  private async sendSafeFailure(
    adapter: PlatformAdapter,
    update: InboundMessage | InboundCallback,
  ): Promise<void> {
    try {
      await adapter.render({
        chatId: update.chatId,
        text:
          '⚠️ دریافت اطلاعات بازار با مشکل مواجه شد.\n\n' +
          'لطفاً چند لحظه بعد دوباره تلاش کنید.',
        keyboard: expiredCallbackKeyboard(),
        editMessageId: update.kind === 'callback' ? update.messageId : null,
      });
    } catch (error) {
      // Even the fallback may fail (network): log it, never rethrow into the poll loop.
      this.logger.error(
        `Could not deliver the fallback message to ${update.platform}: ${describeError(error)}`,
      );
    }
  }

  // --- navigation state -------------------------------------------------------

  private remember(userId: string, screen: UxScreen): void {
    this.sessions.set(userId, { screen });
  }

  private currentScreen(userId: string): UxScreen {
    return this.sessions.get(userId)?.screen ?? 'menu';
  }

  /** Back always returns to the logical parent — never into a loop (§8). */
  private parentOf(screen: UxScreen): UxScreen {
    switch (screen) {
      case 'favorites-manage':
        return 'favorites';
      case 'menu':
        return 'menu';
      default:
        return 'menu';
    }
  }

  /** Exposed for tests/diagnostics only. */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /** Convenience used by tests to render a screen without an inbound update. */
  renderForTest(screen: UxScreen, userId: string): RenderedScreen {
    return this.renderScreen(screen, userId);
  }
}

function truncateForLog(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 64)}…`;
}

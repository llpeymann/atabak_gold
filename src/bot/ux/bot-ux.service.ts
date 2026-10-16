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
import {
  AlertCallbackAction,
  CallbackAction,
  isCampaignAction,
  isAlertAction,
  isContentAction,
  parseCallbackData,
  ScreenKey,
} from './callback-data';
import { ContentAdminService } from '../content/content-admin.service';
import { CampaignAdminService } from '../campaign/campaign-admin.service';
import { CampaignTrackingService } from '../../campaigns/campaign-tracking.service';
import { BotDestinationService } from '../destination.service';
import { BotRoute, parseStartPayload, screenForRoute } from '../deep-link';
import {
  ReferralService,
  ReferrerNotice,
} from '../../referrals/referral.service';
import { ReferralOutcome } from '../../referrals/referral.types';
import { AlertTypeKey } from './alert-callback.types';
import { AlertService } from '../../alerts/alert.service';
import {
  AlertDelivery,
  AlertType,
  isPercentAlert,
} from '../../alerts/alert.types';
import { tehranDateFa, tehranTimeFa } from '../../common/tehran-time';
import {
  ALERT_TEXTS,
  formatAlertsHub,
  formatAlertConfirmation,
  formatAlertCreatedScreen,
  formatAlertDetailScreen,
  formatAlertLimitReached,
  formatAlertWizardCancelled,
  formatAlertsListScreen,
  formatDeleteConfirmation,
  formatEditPrompt,
  formatInvalidTargetRetry,
  formatSymbolPrompt,
  formatTargetPrompt,
  formatTypePrompt,
} from '../../alerts/alert-format';
import {
  formatDailyReportScreen,
  formatLastUpdateScreen,
  formatMarketHub,
  formatMovementScreen,
} from './market-format';
import { parsePercentInput, parsePriceInput } from './number-input';
import { MarketViewService } from './market-view.service';
import { UxEventLogService } from './ux-event-log.service';
import {
  formatChannelInviteLine,
  formatChannelScreen,
  formatCampaignUnavailableScreen,
  formatChannelUnavailableScreen,
  formatEmptySection,
  formatExpiredCallback,
  formatFavoriteLimitReached,
  formatFavoritesManageScreen,
  formatFavoritesScreen,
  formatMenuScreen,
  formatUnknownStartScreen,
  formatPriceScreen,
  formatWelcomeScreen,
  formatReferralDisabledScreen,
  formatReferralScreen,
  formatReferralWelcomeNote,
  formatRewardGrantedNotice,
} from './ux-format';
import {
  alertCanceledKeyboard,
  alertConfirmKeyboard,
  alertCreatedKeyboard,
  alertDeleteConfirmKeyboard,
  alertDetailKeyboard,
  alertSymbolKeyboard,
  alertTargetInputKeyboard,
  alertTypeKeyboard,
  alertsKeyboard,
  alertsListKeyboard,
  channelKeyboard,
  dailyReportKeyboard,
  expiredCallbackKeyboard,
  favoritesKeyboard,
  fullReportKeyboard,
  marketKeyboard,
  favoritesManageKeyboard,
  mainMenuKeyboard,
  menuKeyboard,
  pricesKeyboard,
  referralKeyboard,
  sectionKeyboard,
} from './ux-keyboards';

/** Logical screens; `menu` and `favorites-manage` are navigation states, not callbacks (§39). */
/** Referral outcomes a user-facing note exists for (the rest show the plain welcome screen). */
type ReferralNoteKind = 'joined' | 'existing' | 'self';

type ReferralOutcomeKind = ReferralOutcome['kind'];

type UxScreen =
  | ScreenKey
  | 'menu'
  | 'favorites-manage'
  | 'expired'
  | 'alerts-list'
  | 'alert-detail'
  | 'alert-wizard'
  | 'alert-created';

/** Callback actions that simply open a screen (everything except mutations). */
type NavigationAction = Extract<
  CallbackAction,
  { kind: 'menu' | 'home' | 'back' | 'noop' | 'screen' | 'manage-favorites' }
>;

/**
 * Temporary "create/edit alert" wizard state (Phase 3 §24–§28, §69).
 *
 * In memory only and scoped per user: it never survives a restart (the spec explicitly allows
 * that) and it can never leak between users. `startedAt` makes an abandoned wizard expire.
 */
interface AlertWizard {
  step: 'symbol' | 'type' | 'target' | 'confirm' | 'edit-target';
  symbol: string | null;
  type: AlertType | null;
  targetPrice: number | null;
  targetPercent: number | null;
  /** Set while editing an existing alert instead of creating one. */
  editAlertId: string | null;
  startedAt: number;
}

interface NavigationState {
  screen: UxScreen;
  wizard?: AlertWizard;
}

interface RenderParams {
  alertId?: string;
  notice?: string;
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
  /**
   * One-shot user-facing note about the referral of this very update (Phase 7).
   *
   * In memory like `sessions`: losing it after a restart only means the user sees the normal welcome
   * screen without the extra sentence — no referral data lives here.
   */
  private readonly referralNotes = new Map<string, ReferralNoteKind>();

  constructor(
    private readonly config: AppConfigService,
    private readonly platformRegistry: PlatformRegistry,
    private readonly views: MarketViewService,
    private readonly users: UserService,
    private readonly events: UxEventLogService,
    private readonly alerts: AlertService,
    private readonly contentAdmin: ContentAdminService,
    private readonly destinations: BotDestinationService,
    // Phase 7 — growth engine. Injected as `growth` because the router already has a `users`.
    private readonly growth: ReferralService,
    // Phase 8 — campaign funnel ingestion and the (admin-only) campaign dashboard. Both are appended
    // last, so every earlier phase keeps its constructor position (§19 backward compatibility).
    private readonly campaignTracking: CampaignTrackingService,
    private readonly campaignAdmin: CampaignAdminService,
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
      // Phase 8 — a campaign link is recognized from the same `/start <payload>` grammar as the
      // Phase 6 routes and the Phase 7 referral codes. Whether this is a *new* identity is answered
      // before the registration below, because only a genuinely new identity may be counted as a
      // campaign start (§8.3) — and the record is written only after that registration succeeded.
      const campaignPayload = this.campaignStartOf(update);
      const isNewIdentity = campaignPayload
        ? this.users.findByPlatform(update.platform, update.platformUserId) ===
          null
        : false;

      // Phase 7 — a referral arrival is handled *before* the generic registration: the referral must
      // be recorded in the same write as the registration, and "was this identity new?" can only be
      // answered before that write (§5.1, §6.1).
      const referralCode = this.referralCodeOf(update);
      const referralResult = referralCode
        ? await this.growth.handleStartReferral({
            platform: update.platform,
            platformUserId: update.platformUserId,
            chatId: update.chatId,
            code: referralCode,
          })
        : null;

      const user =
        referralResult?.user ??
        (await this.users.resolveUser(
          update.platform,
          update.platformUserId,
          update.chatId,
        ));

      if (referralResult) {
        this.recordReferralEvent(
          referralResult.outcome.kind,
          user.id,
          update.platform,
        );

        const note = this.referralNoteFor(referralResult.outcome.kind);

        if (note) {
          this.referralNotes.set(user.id, note);
        }
      }

      // A stable referral code is assigned on the first update that has no code yet: existing users
      // are therefore migrated lazily and collision-safely, without a bulk rewrite of the document.
      if (this.growth.enabled) {
        await this.growth.referralCodeFor(user.id);
      }

      // Phase 8 — the start is recorded *after* the identity is durably registered, and never for a
      // returning user: re-opening the same link is not a new start. A failure here is logged and the
      // user experience continues unchanged (the campaign layer is never allowed to break `/start`).
      if (campaignPayload && isNewIdentity && this.campaignTracking.enabled) {
        const ingestion = await this.campaignTracking.recordStart({
          platform: update.platform,
          platformUserId: update.platformUserId,
          payload: campaignPayload.raw,
        });

        this.events.record(
          ingestion.recorded
            ? 'campaign_start_recorded'
            : 'campaign_start_rejected',
          {
            platform: update.platform,
            userId: user.id,
            screen: ingestion.recorded
              ? 'recorded'
              : truncateForLog(ingestion.reason),
          },
        );

        // Channel membership is a capability, not an assumption: with verification switched off (the
        // default) nothing is asked, and on a platform without a verified `getChatMember` the join
        // stays “unavailable” instead of being guessed (§8.4).
        if (this.config.campaignChannelJoinVerification !== 'disabled') {
          const membership =
            await this.campaignTracking.verifyMembershipTransition({
              platform: update.platform,
              platformUserId: update.platformUserId,
            });

          if (membership.checked) {
            this.events.record('campaign_membership_checked', {
              platform: update.platform,
              userId: user.id,
              screen: membership.state,
            });
          }
        }
      }

      if (update.kind === 'callback') {
        await this.handleCallback(adapter, user, update);
      } else {
        await this.handleMessage(adapter, user, update);
      }

      // Phase 7 — the reward message to the inviter is delivered only after the grant was persisted,
      // through the same platform adapter as every other message. A failure here never reverses a
      // grant and never duplicates it.
      if (referralResult?.referrerNotice) {
        await this.deliverReferrerNotice(referralResult.referrerNotice);
      }

      // Phase 7 — activity is recorded last and only for an update that was actually processed as a
      // real user action. Automated deliveries, scheduled publications and rejected payloads never
      // reach this line, which is what keeps the active-member metric meaningful (§1.2).
      await this.growth.touchActivity(user.id);
    } catch (error) {
      // The user gets a safe message; the technical detail stays server-side (§24, §49).
      this.logger.error(
        `Failed to handle update ${update.updateId} on ${update.platform}: ${describeError(error)}`,
      );
      await this.sendSafeFailure(adapter, update);
    }
  }

  // --- Phase 7: growth engine (referral arrival) -------------------------------

  /**
   * The referral code carried by this update, or `null`.
   *
   * Only a plain message whose *first* token is `/start` is considered, and only the payload the
   * Phase 6 parser classifies as a referral — a callback, a forwarded text or a second token can
   * therefore never start an attribution (§5.1, §13.1).
   */
  private referralCodeOf(update: InboundUpdate): string | null {
    if (update.kind !== 'message') {
      return null;
    }

    const payload = parseStartPayload(update.text);

    return payload.kind === 'referral' ? payload.code : null;
  }

  /**
   * The campaign payload carried by this update, or `null`.
   *
   * Only a plain message whose first token is `/start` is considered (the same restriction as the
   * referral path), so a callback, forwarded text or a second token can never register a campaign
   * start. The token itself is never logged.
   */
  private campaignStartOf(
    update: InboundUpdate,
  ): { raw: string; token: string } | null {
    if (update.kind !== 'message') {
      return null;
    }

    const payload = parseStartPayload(update.text);

    return payload.kind === 'campaign'
      ? { raw: payload.raw, token: payload.token }
      : null;
  }

  /** Log the *fact* of a referral arrival. No code, link or third-party identity is ever logged. */
  private recordReferralEvent(
    kind: ReferralOutcomeKind,
    userId: string,
    platform: Platform,
  ): void {
    const base = { platform, userId };

    switch (kind) {
      case 'joined':
        this.events.record('referral_join_recorded', base);
        return;
      case 'self-referral':
      case 'existing-user':
      case 'unknown-code':
      case 'persist-failed':
        // Every non-counted arrival is recorded as a rejection: honest statistics, and a diagnosable
        // trail for a link that looks broken to users (§5.4, §13.3).
        this.events.record('referral_join_rejected', { ...base, screen: kind });
        return;
      case 'disabled':
        return;
    }
  }

  /**
   * Deliver the inviter's congratulation message.
   *
   * The grant is already persisted when this runs (the referral service returns the notice only after
   * a successful write), so a delivery failure is logged and nothing else happens: no reversal, no
   * retry loop that could duplicate the message, and the number stays visible in the referral screen.
   */
  private async deliverReferrerNotice(notice: ReferrerNotice): Promise<void> {
    if (!notice.chatId) {
      this.logger.warn(
        `Referral reward notice for ${notice.userId} skipped: no delivery chat is known yet.`,
      );
      return;
    }

    const adapter = this.platformRegistry.resolve(notice.platform);

    if (!adapter) {
      this.logger.warn(
        `Referral reward notice for ${notice.userId} skipped: ${notice.platform} is not configured.`,
      );
      return;
    }

    try {
      await adapter.render({
        chatId: notice.chatId,
        text: formatRewardGrantedNotice(notice),
        keyboard: mainMenuKeyboard({ referral: this.growth.enabled }),
      });
      this.events.record('referral_reward_granted', {
        platform: notice.platform,
        userId: notice.userId,
      });
    } catch (error) {
      this.logger.error(
        `Could not deliver the referral reward notice to ${notice.userId}: ${describeError(error)}`,
      );
    }
  }

  // --- inbound handling -------------------------------------------------------

  private async handleMessage(
    adapter: PlatformAdapter,
    user: User,
    message: InboundMessage,
  ): Promise<void> {
    // A wizard waiting for a number consumes the next plain message (Phase 3 §27/§28).
    if (await this.consumeWizardInput(adapter, user, message)) {
      return;
    }

    const command = asCommand(message);

    if (command === 'start') {
      await this.handleStart(adapter, user, message);
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
        keyboard: menuKeyboard({ referral: this.growth.enabled }),
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

    // Phase 5 — the editorial content surface. It is admin-gated server-side; a non-admin gets the
    // ordinary menu (the existence of the surface is not disclosed by an error, §22).
    if (command === 'content' || this.contentAdmin.owns(message.text ?? '')) {
      const handled = await this.contentAdmin.handleCommand(
        adapter,
        user,
        message.text ?? '',
      );

      if (handled) {
        return;
      }

      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: formatMenuScreen(),
        keyboard: mainMenuKeyboard({ referral: this.growth.enabled }),
      });
      return;
    }

    // Phase 8 — the campaign dashboard. Admin-gated server-side; a non-admin sees the ordinary menu
    // and the existence of the surface is not disclosed (§15).
    if (command === 'campaign' || this.campaignAdmin.owns(message.text ?? '')) {
      const handled = await this.campaignAdmin.handleCommand(
        adapter,
        user,
        message.text ?? '',
      );

      if (handled) {
        return;
      }

      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: formatMenuScreen(),
        keyboard: mainMenuKeyboard({ referral: this.growth.enabled }),
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
      keyboard: menuKeyboard({ referral: this.growth.enabled }),
    });
  }

  private async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callback: InboundCallback,
  ): Promise<void> {
    const action = parseCallbackData(callback.data);

    // Phase 5 — the content surface acknowledges the press itself (its toasts differ per action),
    // so it is dispatched *before* the generic acknowledgement: exactly one answer per callback.
    if (action && isContentAction(action)) {
      await this.contentAdmin.handleCallback(
        adapter,
        user,
        callback.callbackId,
        typeof callback.messageId === 'number' ? callback.messageId : undefined,
        action,
      );
      return;
    }

    // Phase 8 — the campaign dashboard answers its own buttons (its toasts differ per action), so it
    // is dispatched before the generic acknowledgement: exactly one answer per callback.
    if (action && isCampaignAction(action)) {
      await this.campaignAdmin.handleCallback(
        adapter,
        user,
        callback.callbackId,
        typeof callback.messageId === 'number' ? callback.messageId : undefined,
        action,
      );
      return;
    }

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

    if (isAlertAction(action)) {
      await this.handleAlertAction(adapter, user, callback, action);
      return;
    }

    const target = this.resolveTarget(action, user.id);

    if (target !== 'alert-wizard') {
      // Any explicit navigation away from the wizard ends it (no stale half-finished state).
      this.clearWizard(user.id);
    }

    const rendered = this.withChannelInvite(
      this.renderScreen(target, user.id),
      adapter.platform,
    );
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
          // Phase 4 — the intelligence screens are logged with the market vocabulary.
          case 'report':
          case 'report-full':
            this.events.record('market_report_view', base);
            return;
          case 'movement':
            this.events.record('market_movement_view', base);
            return;
          case 'last-update':
            this.events.record('market_last_update_view', base);
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
          // Phase 7 — opening the referral screen. Only the *fact* is logged: no code, no link and
          // no invitee data ever reach the event log.
          case 'referral':
            this.events.record('referral_open', base);
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

  /** Map a referral outcome to the one-shot note kind the welcome screen understands. */
  private referralNoteFor(kind: ReferralOutcomeKind): ReferralNoteKind | null {
    switch (kind) {
      case 'joined':
        return 'joined';
      case 'existing-user':
        return 'existing';
      case 'self-referral':
        return 'self';
      // `unknown-code`, `disabled` and `persist-failed` show the normal welcome screen: nothing is
      // claimed to the user that was not recorded.
      default:
        return null;
    }
  }

  // --- rendering --------------------------------------------------------------

  private renderScreen(
    screen: UxScreen,
    userId: string,
    params: RenderParams = {},
  ): RenderedScreen {
    const now = new Date();
    const displayUnit = this.config.displayUnit;

    switch (screen) {
      case 'menu':
        return {
          screen: 'menu',
          text: formatMenuScreen(),
          keyboard: menuKeyboard({ referral: this.growth.enabled }),
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

      // Phase 4 — `📊 بازار` is the entry point of the market intelligence screens (§29).
      case 'market': {
        return {
          screen: 'market',
          text: formatMarketHub(),
          keyboard: marketKeyboard(),
        };
      }

      case 'report': {
        const view = this.views.buildIntelligence(now);
        return {
          screen: 'report',
          text: formatDailyReportScreen(view, displayUnit),
          keyboard: dailyReportKeyboard(),
        };
      }

      case 'report-full': {
        const view = this.views.buildIntelligence(now);
        return {
          screen: 'report-full',
          text: formatDailyReportScreen(view, displayUnit, { detailed: true }),
          keyboard: fullReportKeyboard(),
        };
      }

      case 'movement': {
        const view = this.views.buildIntelligence(now);
        return {
          screen: 'movement',
          text: formatMovementScreen(view, displayUnit),
          keyboard: sectionKeyboard('movement'),
        };
      }

      case 'last-update': {
        const view = this.views.buildIntelligence(now);
        return {
          screen: 'last-update',
          text: formatLastUpdateScreen(view),
          keyboard: sectionKeyboard('last-update'),
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
          text: formatAlertsHub(),
          keyboard: alertsKeyboard(),
        };

      case 'alerts-list':
        return this.renderAlertsList(userId, params.notice);

      case 'alert-detail':
        return this.renderAlertDetail(
          userId,
          params.alertId ?? null,
          params.notice,
        );

      case 'alert-wizard':
        return this.renderAlertWizard(userId);

      case 'alert-created':
        return this.renderAlertCreated(userId, params.alertId ?? null);

      case 'referral': {
        // Phase 7: everything shown here is read from persistence (§7); no cached counters, no
        // optimistic numbers. A disabled engine explains itself instead of disappearing.
        if (!this.growth.enabled) {
          return {
            screen: 'referral',
            text: formatReferralDisabledScreen(),
            keyboard: referralKeyboard(null),
          };
        }

        const context = this.growth.referralContext(userId);

        if (!context) {
          return this.expiredScreen();
        }

        const stats = this.growth.statsFor(userId);
        const link = context.code
          ? this.destinations.referralLink(context.platform, context.code)
          : null;

        return {
          screen: 'referral',
          text: formatReferralScreen(stats, link),
          keyboard: referralKeyboard(link),
        };
      }

      case 'channel': {
        // Phase 6: a missing channel destination is answered with an explanation instead of a button
        // that cannot work (§7 rule 8).
        const url =
          this.destinations.channelUrl('bale') ??
          this.destinations.channelUrl('telegram');

        return {
          screen: 'channel',
          text: url
            ? formatChannelScreen(this.config.channelHandle)
            : formatChannelUnavailableScreen(),
          keyboard: channelKeyboard(url),
        };
      }

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

  /**
   * `/start` and `/start <payload>` (Phase 6 §6).
   *
   * The payload is parsed by the route registry and then handed to the *existing* feature: the same
   * screens and the same alert wizard the menu buttons use. A payload can therefore never do anything
   * a normal button press could not do — no shortcut around validation, permissions or confirmation.
   */
  private async handleStart(
    adapter: PlatformAdapter,
    user: User,
    message: InboundMessage,
  ): Promise<void> {
    const payload = parseStartPayload(message.text);

    this.events.record('start', {
      platform: adapter.platform,
      userId: user.id,
    });

    if (payload.kind === 'none') {
      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: formatWelcomeScreen(),
        keyboard: mainMenuKeyboard({ referral: this.growth.enabled }),
      });
      return;
    }

    if (payload.kind === 'unknown') {
      // Never execute a different feature for an unknown payload: log it (without the full user
      // record) and show the normal menu with a short explanation.
      this.logger.warn(
        `Unknown start payload "${truncateForLog(payload.raw)}" from ${adapter.platform}.`,
      );
      this.events.record('start_unknown_payload', {
        platform: adapter.platform,
        userId: user.id,
      });
      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: `${formatUnknownStartScreen()}\n\n${formatMenuScreen()}`,
        keyboard: menuKeyboard({ referral: this.growth.enabled }),
      });
      return;
    }

    if (payload.kind === 'referral') {
      // The attribution itself already happened *before* the session was resolved (see
      // `handleUpdate`), because a referral must be recorded in the same write as the registration.
      // Here only the user-facing part remains: the normal welcome/menu (plus a one-line note when
      // there is something to explain). A referral link can therefore never block or replace the
      // normal start flow (§5.4).
      const note = this.referralNotes.get(user.id) ?? null;
      this.referralNotes.delete(user.id);
      this.remember(user.id, 'menu');
      await adapter.render({
        chatId: message.chatId,
        text: note
          ? `${formatReferralWelcomeNote(note)}\n\n${formatWelcomeScreen()}`
          : formatWelcomeScreen(),
        keyboard: mainMenuKeyboard({ referral: this.growth.enabled }),
      });
      return;
    }

    if (payload.kind === 'campaign') {
      // A tracked campaign link: it behaves like the route it names, and when the campaign is not
      // accepting traffic the user gets the ordinary menu plus one short, non-technical line. Nothing
      // about the campaign is disclosed beyond the fact that the link is no longer active (§7.4).
      const resolution = this.campaignTracking.resolve(
        payload.token,
        new Date(),
      );

      this.events.record('start_campaign', {
        platform: adapter.platform,
        userId: user.id,
        screen: resolution?.campaign.destination ?? 'unknown',
      });

      if (!resolution || !resolution.accepting) {
        this.remember(user.id, 'menu');
        await adapter.render({
          chatId: message.chatId,
          text: `${formatCampaignUnavailableScreen()}\n\n${formatMenuScreen()}`,
          keyboard: menuKeyboard({ referral: this.growth.enabled }),
        });
        return;
      }

      await this.enterRoute(
        adapter,
        user,
        message.chatId,
        resolution.campaign.destinationType === 'CHANNEL_INVITE'
          ? 'channel'
          : (resolution.campaign.destination as BotRoute),
        'campaign',
      );
      return;
    }

    await this.enterRoute(
      adapter,
      user,
      message.chatId,
      payload.route,
      'route',
    );
  }

  /**
   * Open one approved route for a user.
   *
   * Shared by `/start <route>` (Phase 6) and by a tracked campaign link (Phase 8), so a campaign can
   * *reuse* the existing screens instead of growing a parallel flow: the campaign only decides which
   * route is opened, never how it is rendered.
   */
  private async enterRoute(
    adapter: PlatformAdapter,
    user: User,
    chatId: string,
    route: BotRoute,
    source: 'route' | 'campaign',
  ): Promise<void> {
    this.events.record(
      source === 'route' ? 'start_route' : 'start_campaign_route',
      {
        platform: adapter.platform,
        userId: user.id,
        screen: screenForRoute(route) ?? 'alert-wizard',
      },
    );

    // The alert route enters the *existing* wizard — it never creates an alert by itself (§4.2).
    if (route === 'alert') {
      this.startWizard(user.id, 'symbol');
      const screen = this.renderScreen('alert-wizard', user.id);
      await adapter.render({
        chatId,
        text: screen.text,
        keyboard: screen.keyboard,
      });
      return;
    }

    const screen = this.withChannelInvite(
      this.renderScreen(screenForRoute(route) ?? 'menu', user.id),
      adapter.platform,
    );

    this.remember(user.id, screen.screen);
    await adapter.render({
      chatId,
      text: screen.text,
      keyboard: screen.keyboard,
    });
  }

  // --- Phase 3: alert flows ----------------------------------------------------

  /** Routes every alert button. Ownership and state are always re-checked server-side (§68). */
  private async handleAlertAction(
    adapter: PlatformAdapter,
    user: User,
    callback: InboundCallback,
    action: AlertCallbackAction,
  ): Promise<void> {
    switch (action.kind) {
      case 'alert-new':
        this.events.record('alert_create_started', {
          platform: adapter.platform,
          userId: user.id,
        });
        this.startWizard(user.id, 'symbol');
        return this.render(
          adapter,
          callback,
          this.renderScreen('alert-wizard', user.id),
        );

      case 'alert-symbol': {
        const wizard = this.wizardMatching(user.id, 'symbol');

        if (!wizard || !this.alerts.isSupportedSymbol(action.symbol)) {
          return this.render(adapter, callback, this.expiredScreen());
        }

        wizard.symbol = action.symbol;
        wizard.step = 'type';
        return this.render(
          adapter,
          callback,
          this.renderScreen('alert-wizard', user.id),
        );
      }

      case 'alert-type': {
        const wizard = this.wizardMatching(user.id, 'type');

        if (!wizard) {
          return this.render(adapter, callback, this.expiredScreen());
        }

        wizard.type = alertTypeFromKey(action.type);
        wizard.step = 'target';
        return this.render(
          adapter,
          callback,
          this.renderScreen('alert-wizard', user.id),
        );
      }

      case 'alert-confirm':
        return this.confirmWizard(adapter, user, callback);

      case 'alert-cancel':
        this.clearWizard(user.id);
        this.events.record('alert_create_cancelled', {
          platform: adapter.platform,
          userId: user.id,
        });
        return this.render(adapter, callback, {
          screen: 'alert-wizard',
          text: formatAlertWizardCancelled(),
          keyboard: alertCanceledKeyboard(),
        });

      case 'alert-list': {
        this.clearWizard(user.id);
        this.events.record('alerts_view', {
          platform: adapter.platform,
          userId: user.id,
        });
        this.remember(user.id, 'alerts-list');
        return this.render(
          adapter,
          callback,
          this.renderScreen('alerts-list', user.id),
        );
      }

      case 'alert-view': {
        this.clearWizard(user.id);
        this.events.record('alert_detail_view', {
          platform: adapter.platform,
          userId: user.id,
        });
        this.remember(user.id, 'alert-detail');
        return this.render(adapter, callback, {
          ...this.renderScreen('alert-detail', user.id, {
            alertId: action.alertId,
          }),
        });
      }

      case 'alert-enable':
      case 'alert-disable': {
        const alert = this.alerts.findForUser(user.id, action.alertId);

        if (!alert) {
          return this.render(adapter, callback, this.notFoundScreen());
        }

        const result =
          action.kind === 'alert-enable'
            ? await this.alerts.enable(user.id, action.alertId)
            : await this.alerts.disable(user.id, action.alertId);

        if (!result.ok) {
          return this.render(adapter, callback, {
            screen: 'alert-detail',
            text: this.alertFailureText(result.reason, user.id),
            keyboard: alertDetailKeyboard(alert.status, alert.id),
          });
        }

        const enabled = result.alert.status === 'ACTIVE';
        this.events.record(enabled ? 'alert_enabled' : 'alert_disabled', {
          platform: adapter.platform,
          userId: user.id,
          symbol: alert.symbol,
        });

        return this.render(adapter, callback, {
          ...this.renderScreen('alert-detail', user.id, {
            alertId: alert.id,
            notice: enabled
              ? '🔔 هشدار دوباره فعال شد.'
              : '🔕 هشدار غیرفعال شد.',
          }),
        });
      }

      case 'alert-edit': {
        const alert = this.alerts.findForUser(user.id, action.alertId);

        if (!alert || alert.status === 'TRIGGERED') {
          return this.render(adapter, callback, this.notFoundScreen());
        }

        this.startWizard(user.id, 'edit-target', {
          symbol: alert.symbol,
          type: alert.type,
          editAlertId: alert.id,
        });
        return this.render(
          adapter,
          callback,
          this.renderScreen('alert-wizard', user.id),
        );
      }

      case 'alert-delete': {
        const alert = this.alerts.findForUser(user.id, action.alertId);

        if (!alert) {
          return this.render(adapter, callback, this.notFoundScreen());
        }

        return this.render(adapter, callback, {
          screen: 'alert-detail',
          text: formatDeleteConfirmation(
            alert,
            this.alerts.definitionFor(alert.symbol),
            this.config.displayUnit,
          ),
          keyboard: alertDeleteConfirmKeyboard(alert.id),
        });
      }

      case 'alert-delete-confirm': {
        const alert = this.alerts.findForUser(user.id, action.alertId);

        if (!alert) {
          return this.render(adapter, callback, this.notFoundScreen());
        }

        const removed = await this.alerts.remove(user.id, action.alertId);

        if (!removed.ok) {
          return this.render(adapter, callback, this.notFoundScreen());
        }

        this.events.record('alert_deleted', {
          platform: adapter.platform,
          userId: user.id,
          symbol: alert.symbol,
        });

        return this.render(adapter, callback, {
          ...this.renderScreen('alerts-list', user.id, {
            notice: '🗑 هشدار حذف شد.',
          }),
        });
      }

      default:
        return this.render(adapter, callback, this.expiredScreen());
    }
  }

  /** Confirmation press: the only place an alert is created or an edit is persisted (§31, §38). */
  private async confirmWizard(
    adapter: PlatformAdapter,
    user: User,
    callback: InboundCallback,
  ): Promise<void> {
    const wizard = this.wizardMatching(user.id, 'confirm');

    if (!wizard || wizard.symbol === null || wizard.type === null) {
      return this.render(adapter, callback, this.expiredScreen());
    }

    if (wizard.editAlertId !== null) {
      const result = await this.alerts.edit(user.id, wizard.editAlertId, {
        targetPrice: wizard.targetPrice,
        targetPercent: wizard.targetPercent,
      });

      if (!result.ok) {
        this.events.record('alert_invalid_target', {
          platform: adapter.platform,
          userId: user.id,
          symbol: wizard.symbol,
        });
        return this.render(adapter, callback, {
          screen: 'alert-detail',
          text: this.alertFailureText(result.reason, user.id),
          keyboard: alertDetailKeyboard('ACTIVE', wizard.editAlertId),
        });
      }

      this.events.record('alert_updated', {
        platform: adapter.platform,
        userId: user.id,
        symbol: result.alert.symbol,
      });
      this.clearWizard(user.id);

      return this.render(adapter, callback, {
        ...this.renderScreen('alert-detail', user.id, {
          alertId: result.alert.id,
          notice: '✅ هشدار ویرایش شد.',
        }),
      });
    }

    const result = await this.alerts.create(user.id, {
      type: wizard.type,
      symbol: wizard.symbol,
      targetPrice: wizard.targetPrice,
      targetPercent: wizard.targetPercent,
    });

    if (!result.ok) {
      if (result.reason === 'LIMIT_REACHED') {
        const limit = result.limit ?? this.alerts.effectiveMaxAlerts(user.id);
        this.events.record('alert_limit_reached', {
          platform: adapter.platform,
          userId: user.id,
        });
        this.clearWizard(user.id);
        return this.render(adapter, callback, {
          screen: 'alerts-list',
          text: formatAlertLimitReached(limit),
          keyboard: alertsKeyboard(),
        });
      }

      if (result.reason === 'DUPLICATE') {
        this.events.record('alert_duplicate', {
          platform: adapter.platform,
          userId: user.id,
          symbol: wizard.symbol,
        });
      } else {
        this.events.record('alert_invalid_target', {
          platform: adapter.platform,
          userId: user.id,
          symbol: wizard.symbol,
        });
      }

      return this.render(adapter, callback, {
        screen: 'alert-wizard',
        text: this.alertFailureText(result.reason, user.id),
        keyboard: alertCanceledKeyboard(),
      });
    }

    this.events.record('alert_created', {
      platform: adapter.platform,
      userId: user.id,
      symbol: result.alert.symbol,
    });

    // Phase 8 — the funnel event is recorded only *after* Phase 3 persisted the alert, through this
    // single authoritative path: there is no second alert engine and no listener that could double
    // count (§8.5). An unattributed user simply produces no campaign event.
    if (this.campaignTracking.enabled) {
      const attribution = await this.campaignTracking.recordAlertCreated({
        platform: adapter.platform,
        platformUserId: user.platformUserId,
        alertId: result.alert.id,
      });

      if (attribution.recorded) {
        this.events.record('campaign_alert_recorded', {
          platform: adapter.platform,
          userId: user.id,
          screen: attribution.campaignId ?? 'unknown',
        });
      }
    }

    this.clearWizard(user.id);

    return this.render(
      adapter,
      callback,
      this.renderScreen('alert-created', user.id, { alertId: result.alert.id }),
    );
  }

  /**
   * Consume the numeric answer of the wizard. Returns `true` when the message was handled here
   * (so it is not interpreted as a command).
   */
  private async consumeWizardInput(
    adapter: PlatformAdapter,
    user: User,
    message: InboundMessage,
  ): Promise<boolean> {
    const wizard = this.sessions.get(user.id)?.wizard;

    if (
      !wizard ||
      (wizard.step !== 'target' && wizard.step !== 'edit-target')
    ) {
      return false;
    }

    if (message.text === null || message.text.trim().startsWith('/')) {
      // A command is never a numeric answer.
      return false;
    }

    const definition =
      wizard.symbol === null ? null : this.alerts.definitionFor(wizard.symbol);

    if (!definition || wizard.type === null) {
      this.clearWizard(user.id);
      await adapter.render({
        chatId: message.chatId,
        text: this.alertFailureText('UNKNOWN_SYMBOL', user.id),
        keyboard: alertCanceledKeyboard(),
      });
      return true;
    }

    const percentAlert = isPercentAlert(wizard.type);
    const parsed = percentAlert
      ? parsePercentInput(message.text)
      : parsePriceInput(message.text);

    const check = this.alerts.checkTarget({
      type: wizard.type,
      symbol: definition.symbol,
      targetPrice: percentAlert ? null : parsed,
      targetPercent: percentAlert ? parsed : null,
    });

    if (!check.ok) {
      this.events.record('alert_invalid_target', {
        platform: adapter.platform,
        userId: user.id,
        symbol: definition.symbol,
      });

      if (check.reason !== 'INVALID_TARGET') {
        // Typing another number cannot fix this (no usable price / unsupported symbol):
        // say so and close the wizard instead of looping the user.
        this.clearWizard(user.id);
        await adapter.render({
          chatId: message.chatId,
          text: this.alertFailureText(check.reason, user.id),
          keyboard: alertCanceledKeyboard(),
        });
        return true;
      }

      // Keep the wizard open and ask again: a wrong number must not silently become a target.
      await adapter.render({
        chatId: message.chatId,
        text: formatInvalidTargetRetry(
          formatTargetPrompt(definition, wizard.type, this.config.displayUnit),
        ),
        keyboard: alertTargetInputKeyboard(),
      });
      return true;
    }

    wizard.targetPrice = percentAlert ? null : parsed;
    wizard.targetPercent = percentAlert ? parsed : null;
    wizard.step = 'confirm';

    this.events.record('alert_wizard_input', {
      platform: adapter.platform,
      userId: user.id,
      symbol: definition.symbol,
    });

    await adapter.render({
      chatId: message.chatId,
      text: this.confirmationText(wizard, definition),
      keyboard: alertConfirmKeyboard(),
    });
    return true;
  }

  /** Confirmation text, including the "already met" warning of §14 and the §32 summary. */
  private confirmationText(
    wizard: AlertWizard,
    definition: ReturnType<AlertService['definitionFor']>,
  ): string {
    if (definition === null || wizard.type === null) {
      return ALERT_TEXTS.unknownSymbol;
    }

    const snapshot = this.alerts.priceSnapshot(definition.symbol);
    const percentAlert = isPercentAlert(wizard.type);
    // The baseline that will actually be stored: the current usable Phase 1 price.
    const baseline = percentAlert
      ? this.alerts.latestUsablePrice(definition.symbol)
      : null;
    const approximateTarget =
      percentAlert && baseline !== null
        ? approximatePercentTarget(baseline, wizard.targetPercent, wizard.type)
        : null;

    return formatAlertConfirmation({
      definition,
      type: wizard.type,
      target: wizard.targetPrice,
      percent: wizard.targetPercent,
      direction:
        wizard.type === 'PERCENT_DECREASE'
          ? 'DOWN'
          : wizard.type === 'PERCENT_INCREASE'
            ? 'UP'
            : null,
      baseline,
      approximateTarget,
      currentPrice: snapshot?.price ?? null,
      displayUnit: this.config.displayUnit,
      alreadyMet: this.alerts.isConditionAlreadyMet({
        type: wizard.type,
        symbol: definition.symbol,
        targetPrice: wizard.targetPrice,
      }),
    });
  }

  private async render(
    adapter: PlatformAdapter,
    callback: InboundCallback,
    screen: RenderedScreen,
  ): Promise<void> {
    const withInvite = this.withChannelInvite(screen, adapter.platform);

    await adapter.render({
      chatId: callback.chatId,
      text: withInvite.text,
      keyboard: withInvite.keyboard,
      editMessageId: callback.messageId,
    });
  }

  /**
   * Phase 6 — Bot → Channel (§5.2).
   *
   * One shared helper adds the channel invitation to the *market-intelligence* screens only: those are
   * the answers where an invitation adds genuine value. It is never a universal footer, it never
   * changes the report values, and it disappears completely when the invitation is disabled or the
   * platform has no configured channel destination (§7 rule 8).
   */
  private withChannelInvite(
    screen: RenderedScreen,
    platform: Platform,
  ): RenderedScreen {
    if (!MARKET_REPORT_SCREENS.includes(screen.screen)) {
      return screen;
    }

    const row = this.destinations.channelInviteRow(platform);

    if (!row) {
      return screen;
    }

    return {
      ...screen,
      text: `${screen.text}\n\n${formatChannelInviteLine()}`,
      keyboard: [...row, ...screen.keyboard],
    };
  }

  /**
   * Failure text of an alert action — the capacity sentence always quotes the *effective* limit of
   * that user (configured base + applied referral bonuses, §8.3), never the raw configuration value.
   */
  private alertFailureText(reason: string, userId: string): string {
    switch (reason) {
      case 'LIMIT_REACHED':
        return formatAlertLimitReached(this.alerts.effectiveMaxAlerts(userId));
      case 'DUPLICATE':
        return ALERT_TEXTS.duplicate;
      case 'NO_VALID_PRICE':
        return ALERT_TEXTS.noValidPrice;
      case 'UNKNOWN_SYMBOL':
        return ALERT_TEXTS.unknownSymbol;
      case 'ALERT_NOT_FOUND':
        return ALERT_TEXTS.notFound;
      case 'INVALID_STATE':
        return ALERT_TEXTS.invalidState;
      default:
        return ALERT_TEXTS.invalidTarget;
    }
  }

  private notFoundScreen(): RenderedScreen {
    return {
      screen: 'alerts-list',
      text: ALERT_TEXTS.notFound,
      keyboard: alertsKeyboard(),
    };
  }

  // --- alert screens ----------------------------------------------------------

  private renderAlertsList(userId: string, notice?: string): RenderedScreen {
    const alerts = this.alerts.listForUser(userId);
    const definitions = new Map(
      alerts.map((alert) => [
        alert.symbol,
        this.alerts.definitionFor(alert.symbol),
      ]),
    );
    const resolved = new Map(
      [...definitions.entries()]
        .filter(
          (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
            entry[1] !== null,
        )
        .map(([symbol, definition]) => [symbol, definition]),
    );
    const displayUnit = this.config.displayUnit;
    const base = formatAlertsListScreen(
      alerts,
      resolved,
      displayUnit,
      this.alerts.effectiveMaxAlerts(userId),
    );

    return {
      screen: 'alerts-list',
      text: notice ? `${notice}\n\n${base}` : base,
      keyboard: alertsListKeyboard(
        alerts.map((alert) => ({
          id: alert.id,
          label: resolved.get(alert.symbol)?.label ?? alert.symbol,
          status: alert.status,
        })),
      ),
    };
  }

  private renderAlertDetail(
    userId: string,
    alertId: string | null,
    notice?: string,
  ): RenderedScreen {
    const alert =
      alertId === null ? null : this.alerts.findForUser(userId, alertId);

    if (!alert) {
      return this.notFoundScreen();
    }

    const definition = this.alerts.definitionFor(alert.symbol);
    const delivery = this.alerts.findDelivery(alert.id);

    return {
      screen: 'alert-detail',
      text: formatAlertDetailScreen(
        alert,
        definition,
        this.config.displayUnit,
        {
          createdTimeFa: tehranStamp(alert.createdAt),
          triggeredTimeFa: alert.triggeredAt
            ? tehranStamp(alert.triggeredAt)
            : null,
          deliveryNote: joinNotes(notice, deliveryNote(delivery)),
        },
      ),
      keyboard: alertDetailKeyboard(alert.status, alert.id),
    };
  }

  private renderAlertWizard(userId: string): RenderedScreen {
    const wizard = this.activeWizard(userId);

    if (!wizard) {
      return this.expiredScreen();
    }

    const definition =
      wizard.symbol === null ? null : this.alerts.definitionFor(wizard.symbol);

    switch (wizard.step) {
      case 'symbol':
        return {
          screen: 'alert-wizard',
          text: formatSymbolPrompt(),
          keyboard: alertSymbolKeyboard(
            this.alerts
              .listSymbolSnapshots()
              .map((snapshot) => snapshot.definition),
          ),
        };
      case 'edit-target': {
        const alert =
          wizard.editAlertId === null
            ? null
            : this.alerts.findForUser(userId, wizard.editAlertId);

        if (!alert) {
          return this.expiredScreen();
        }

        return {
          screen: 'alert-wizard',
          text: formatEditPrompt(alert, definition, this.config.displayUnit),
          keyboard: alertTargetInputKeyboard(),
        };
      }
      case 'type':
        return {
          screen: 'alert-wizard',
          text: formatTypePrompt(definition),
          keyboard: alertTypeKeyboard(),
        };
      case 'target':
        return {
          screen: 'alert-wizard',
          text:
            definition === null || wizard.type === null
              ? ALERT_TEXTS.unknownSymbol
              : formatTargetPrompt(
                  definition,
                  wizard.type,
                  this.config.displayUnit,
                ),
          keyboard: alertTargetInputKeyboard(),
        };
      case 'confirm':
      default: {
        if (definition === null || wizard.type === null) {
          return this.expiredScreen();
        }

        return {
          screen: 'alert-wizard',
          text: this.confirmationText(wizard, definition),
          keyboard: alertConfirmKeyboard(),
        };
      }
    }
  }

  private renderAlertCreated(
    userId: string,
    alertId: string | null,
  ): RenderedScreen {
    const alert =
      alertId === null ? null : this.alerts.findForUser(userId, alertId);

    if (!alert) {
      return this.renderAlertsList(userId);
    }

    return {
      screen: 'alert-created',
      text: formatAlertCreatedScreen(
        alert,
        this.alerts.definitionFor(alert.symbol),
        this.config.displayUnit,
      ),
      keyboard: alertCreatedKeyboard(),
    };
  }

  // --- wizard state -----------------------------------------------------------

  private startWizard(
    userId: string,
    step: AlertWizard['step'],
    seed: Partial<AlertWizard> = {},
  ): void {
    this.sessions.set(userId, {
      screen: 'alert-wizard',
      wizard: {
        step,
        symbol: seed.symbol ?? null,
        type: seed.type ?? null,
        targetPrice: null,
        targetPercent: null,
        editAlertId: seed.editAlertId ?? null,
        startedAt: Date.now(),
      },
    });
  }

  /** The wizard of this user, or `null` when there is none / it has expired (§69). */
  private activeWizard(userId: string): AlertWizard | null {
    const state = this.sessions.get(userId);
    const wizard = state?.wizard;

    if (!state || !wizard) {
      return null;
    }

    if (Date.now() - wizard.startedAt > this.config.alertWizardTtlMs) {
      this.clearWizard(userId);
      this.logger.log(
        `Dropped an expired alert wizard for user ${userId} (step ${wizard.step}).`,
      );
      return null;
    }

    return wizard;
  }

  /** The wizard only continues from the step the button belongs to. */
  private wizardMatching(
    userId: string,
    step: AlertWizard['step'],
  ): AlertWizard | null {
    const wizard = this.activeWizard(userId);

    return wizard && wizard.step === step ? wizard : null;
  }

  private clearWizard(userId: string): void {
    const state = this.sessions.get(userId);

    if (state?.wizard) {
      this.sessions.set(userId, { screen: state.screen });
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
      // Phase 4 — every market intelligence screen is a child of the `📊 بازار` hub (§29).
      case 'report':
      case 'report-full':
      case 'movement':
      case 'last-update':
        return 'market';
      case 'favorites-manage':
        return 'favorites';
      case 'alerts-list':
      case 'alert-created':
        return 'alerts';
      case 'alert-detail':
      case 'alert-wizard':
        return 'alerts-list';
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

/** Keyboard key → alert behaviour (the reverse mapping lives in `callback-data`). */
function alertTypeFromKey(key: AlertTypeKey): AlertType {
  switch (key) {
    case 'above':
      return 'PRICE_ABOVE';
    case 'below':
      return 'PRICE_BELOW';
    case 'up':
      return 'PERCENT_INCREASE';
    default:
      return 'PERCENT_DECREASE';
  }
}

/** Presentation-only helper for the confirmation screen (§32): never the authoritative check. */
function approximatePercentTarget(
  baseline: number,
  percent: number | null,
  type: AlertType,
): number | null {
  if (percent === null || !Number.isFinite(baseline) || baseline <= 0) {
    return null;
  }

  const factor = type === 'PERCENT_DECREASE' ? -1 : 1;

  return baseline * (1 + (factor * percent) / 100);
}

/** Tehran date+time stamp used by the alert screens. */
function tehranStamp(iso: string): string | null {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? null
    : `${tehranDateFa(date)} — ${tehranTimeFa(date)}`;
}

/** User-facing delivery state of a triggered alert (never a technical error). */
function deliveryNote(delivery: AlertDelivery | null): string | null {
  if (!delivery) {
    return null;
  }

  if (delivery.status === 'SENT') {
    return '✅ پیام هشدار برای شما ارسال شد.';
  }

  if (delivery.status === 'PENDING') {
    return '⏳ پیام هشدار در صف ارسال است.';
  }

  if (delivery.skippedReason === 'ALERT_DELETED') {
    return 'ℹ️ پیام هشدار ارسال نشد (هشدار حذف شده بود).';
  }

  if (delivery.skippedReason === 'DELIVERY_OUTCOME_UNKNOWN') {
    return 'ℹ️ وضعیت ارسال پیام هشدار نامشخص است.';
  }

  return '⚠️ ارسال پیام هشدار ناموفق بود.';
}

function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const parts = notes.filter(
    (note): note is string => typeof note === 'string' && note !== '',
  );

  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * Screens that may carry the channel invitation (Phase 6 §5.2) — the four market-*report* answers.
 * The `market` hub itself is navigation, not a report, and is deliberately excluded.
 */
const MARKET_REPORT_SCREENS: readonly UxScreen[] = [
  'report',
  'report-full',
  'movement',
  'last-update',
];

function truncateForLog(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 64)}…`;
}

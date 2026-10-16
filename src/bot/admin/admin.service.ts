/**
 * Phase 10 — the conversational administrative surface.
 *
 * Responsibilities, and the boundaries that keep it honest:
 *
 *  * **It orchestrates, it does not own.** Prices come from Phase 1, identities from Phase 2, alerts
 *    from Phase 3, publications from Phase 5/6, referrals from Phase 7, campaigns from Phase 8, leads
 *    from Phase 9 and the durable admin state (audit, incidents, activity, broadcasts) from
 *    `src/admin`. Nothing is recomputed here and no owner service is bypassed.
 *  * **Authorization before anything else.** Every command and every button re-resolves the *acting
 *    platform identity* against the allow-lists, then checks the capability the action needs. A
 *    missing capability is a refusal, not merely a hidden button (§12).
 *  * **Confirmation for high-impact actions.** Publishing changes, test messages, alert enable/
 *    disable, risky retries and starting a broadcast are shown on a confirmation screen first, and
 *    only the confirmed press performs them.
 *  * **Honest output.** Screens print sources, mark unmeasurable metrics as «نامشخص», mask personal
 *    identifiers, and never claim a delivery that no platform confirmed.
 *  * **Bounded work.** Every list is paginated, every read is a store read (never a per-row external
 *    call), and the broadcast never sends from inside a callback — the durable worker does that.
 */

import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { escapeHtml } from '../../common/html';
import { describeError, truncate } from '../../common/log-safety';
import { PlatformAdapter } from '../../platform/platform-adapter';
import { PlatformRegistry } from '../../platform/platform-registry.service';
import { Platform } from '../../platform/platform.types';
import { Alert } from '../../alerts/alert.types';
import { AlertService } from '../../alerts/alert.service';
import { AlertStore } from '../../alerts/alert.store';
import { AlertNotificationService } from '../../alerts/alert-notification.service';
import { ChannelEngineService } from '../../channel/channel-engine.service';
import { ChannelPublisher } from '../../channel/channel-publisher.service';
import { PublicationStore } from '../../channel/publication.store';
import { CampaignMetricsService } from '../../campaigns/campaign-metrics.service';
import { CampaignStore } from '../../campaigns/campaign.store';
import { CampaignTrackingService } from '../../campaigns/campaign-tracking.service';
import { SalesNotificationService } from '../../sales/sales-notification.service';
import { SalesService } from '../../sales/sales.service';
import { LeadStatus } from '../../sales/sales.types';
import { User } from '../../users/user.types';
import { UserStore } from '../../users/user.store';
import { AdminAccessService } from '../../admin/admin-access.service';
import { AdminActivityService } from '../../admin/admin-activity.service';
import { AdminAuditService } from '../../admin/admin-audit.service';
import {
  AdminBroadcastService,
  AuditActor,
} from '../../admin/admin-broadcast.service';
import { AdminErrorService } from '../../admin/admin-error.service';
import { AdminMetricsService } from '../../admin/admin-metrics.service';
import {
  AdminCapability,
  BroadcastAudience,
  MetricSection,
  ReportWindow,
} from '../../admin/admin.types';
import {
  formatAdminAlertDetail,
  formatAdminAlertsList,
  formatAdminCampaignsList,
  formatAdminHubScreen,
  formatAdminLeadsList,
  formatAdminUserDetailScreen,
  formatAdminUsersListScreen,
  formatAuditScreen,
  formatBroadcastAudienceScreen,
  formatBroadcastCancelledScreen,
  formatBroadcastConfirmScreen,
  formatBroadcastHubScreen,
  formatBroadcastPreviewScreen,
  formatBroadcastReportScreen,
  formatCampaignFunnelScreen,
  formatChannelsScreen,
  formatDashboardSection,
  formatHealthScreen,
  formatIncidentDetail,
  formatIncidentsScreen,
  formatMetricDictionaryScreen,
  num,
} from '../../admin/admin-format';
import {
  AdminAlertFilterToken,
  AdminCallbackAction,
  AdminIncidentFilterToken,
  AdminLeadFilterToken,
  AdminUserFilterToken,
  callbackDataForAdminHub,
  callbackDataForAdminStats,
} from '../ux/callback-data';
import {
  adminAlertDetailKeyboard,
  adminAlertStateConfirmKeyboard,
  adminAlertsKeyboard,
  adminAuditKeyboard,
  adminBroadcastAudienceKeyboard,
  adminBroadcastConfirmKeyboard,
  adminBroadcastKeyboard,
  adminBroadcastPreviewKeyboard,
  adminBroadcastReportKeyboard,
  adminCampaignFunnelKeyboard,
  adminCampaignsKeyboard,
  adminChannelsKeyboard,
  adminDictionaryKeyboard,
  adminErrorsKeyboard,
  adminHubKeyboard,
  adminIncidentDetailKeyboard,
  adminLeadsKeyboard,
  adminPublishingConfirmKeyboard,
  adminStatsKeyboard,
  adminTestMessageConfirmKeyboard,
  adminTextInputKeyboard,
  adminUserDetailKeyboard,
  adminUsersKeyboard,
} from './admin-keyboards';

type PeriodPreset = 'today' | '7d' | '30d' | 'all';

interface AdminSession {
  screen: string;
  page: number;
  preset: 'today' | '7d' | '30d' | 'all' | 'custom';
  customFrom: string | null;
  customTo: string | null;
  window: ReportWindow | null;
  section: number;
  ref: string | null;
  userFilter: AdminUserFilterToken;
  userQuery: string | null;
  alertFilter: AdminAlertFilterToken;
  leadFilter: AdminLeadFilterToken;
  incidentFilter: AdminIncidentFilterToken;
  /** Broadcast draft kept in memory until the preview is accepted (never persisted before that). */
  broadcastAudience: BroadcastAudience | null;
  broadcastText: string | null;
  pending: AdminPending | null;
}

interface AdminPending {
  kind: 'broadcast-text' | 'from-day' | 'to-day' | 'user-search';
  audience: BroadcastAudience | null;
  startedAt: number;
}

/** How many leads are shown per page (the Phase 9 query bound is the page size). */
const LEAD_PAGE_SIZE = 5;
const PENDING_TTL_MS = 15 * 60_000;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly sessions = new Map<string, AdminSession>();

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: PlatformRegistry,
    private readonly access: AdminAccessService,
    private readonly activity: AdminActivityService,
    private readonly audit: AdminAuditService,
    private readonly errors: AdminErrorService,
    private readonly metrics: AdminMetricsService,
    private readonly broadcast: AdminBroadcastService,
    private readonly users: UserStore,
    private readonly alertStore: AlertStore,
    private readonly alerts: AlertService,
    private readonly alertNotifications: AlertNotificationService,
    private readonly publication: PublicationStore,
    private readonly publisher: ChannelPublisher,
    private readonly engine: ChannelEngineService,
    private readonly sales: SalesService,
    private readonly salesNotifications: SalesNotificationService,
    private readonly campaignStore: CampaignStore,
    private readonly campaignMetrics: CampaignMetricsService,
    private readonly tracking: CampaignTrackingService,
  ) {}

  /** `true` when the text belongs to this service (checked by the router before the menu). */
  owns(text: string): boolean {
    const trimmed = text.trim();

    return trimmed === '/admin' || trimmed.startsWith('/admin ');
  }

  /** Role of a sender, or `null`. The router uses it only to decide whether to *render* a button. */
  roleOf(platform: Platform, platformUserId: string): 'OWNER' | 'ADMIN' | null {
    return this.access.roleOf(platform, platformUserId);
  }

  get enabled(): boolean {
    return this.access.enabled;
  }

  /**
   * Record one qualifying user action (called by the router's single inbound path).
   *
   * Exposed here so the router needs exactly one dependency for the admin system; the measurement
   * itself lives in `AdminActivityService`.
   */
  async recordUserAction(input: {
    platform: Platform;
    platformUserId: string;
    userId: string;
  }): Promise<void> {
    await this.activity.recordUserAction(input);
  }

  hasPendingInput(userId: string): boolean {
    return this.sessionOf(userId).pending !== null;
  }

  /** An unfinished input never lingers: a command or a navigation clears it. */
  clearPending(userId: string): void {
    this.sessionOf(userId).pending = null;
  }

  // --- commands -----------------------------------------------------------------

  async handleCommand(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    const trimmed = text.trim();

    if (!this.owns(trimmed)) {
      return false;
    }

    const actor = await this.authorize(adapter, user, 'manage', {
      action: 'ADMIN_OPEN',
      incident: false,
    });

    if (!actor) {
      // Not an administrator: the ordinary menu is shown and the surface is not disclosed (§12.1).
      return false;
    }

    const argument = trimmed.replace(/^\/admin\s*/u, '').trim();

    await this.openScreenFrom(adapter, user, actor, argument);

    return true;
  }

  /** Consume a pending text input (broadcast text, custom range, user search). */
  async consumeInput(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    const session = this.sessionOf(user.id);
    const pending = session.pending;

    if (!pending) {
      return false;
    }

    if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
      session.pending = null;
      await this.renderExpiredInput(adapter, user);
      return true;
    }

    const actor = await this.authorize(adapter, user, 'manage', {
      action: 'ADMIN_VIEW',
      incident: false,
    });

    if (!actor) {
      session.pending = null;
      return false;
    }

    const input = text.trim();

    switch (pending.kind) {
      case 'broadcast-text': {
        if (input === '') {
          await adapter.render({
            chatId: chatOf(user),
            text: '⚠️ متن خالی است. یک متن بنویسید یا انصراف بزنید.',
            keyboard: adminTextInputKeyboard(() => callbackDataForAdminHub()),
          });

          return true;
        }

        session.pending = null;
        session.broadcastText = input;
        session.broadcastAudience = pending.audience;

        await this.renderBroadcastPreview(
          adapter,
          user,
          input,
          pending.audience,
        );

        return true;
      }
      case 'from-day': {
        session.pending = null;

        if (!/^\d{4}-\d{2}-\d{2}$/u.test(input)) {
          await this.notice(
            adapter,
            user,
            '⚠️ تاریخ شروع نامعتبر است (نمونه: 2026-10-01).',
          );
          return true;
        }

        session.customFrom = input;
        session.pending = {
          kind: 'to-day',
          audience: null,
          startedAt: Date.now(),
        };

        await adapter.render({
          chatId: chatOf(user),
          text: '📅 تاریخ پایان بازه را به شکل YYYY-MM-DD بفرستید.',
          keyboard: adminTextInputKeyboard(() =>
            callbackDataForAdminStats('today', 0),
          ),
        });

        return true;
      }
      case 'to-day': {
        session.pending = null;

        if (!/^\d{4}-\d{2}-\d{2}$/u.test(input)) {
          await this.notice(
            adapter,
            user,
            '⚠️ تاریخ پایان نامعتبر است (نمونه: 2026-10-16).',
          );
          return true;
        }

        const resolution = this.metrics.window('custom', new Date(), {
          fromDayKey: session.customFrom,
          toDayKey: input,
        });

        if (!resolution.ok) {
          await this.notice(adapter, user, `⚠️ ${resolution.message}`);
          return true;
        }

        session.customTo = input;
        session.preset = 'custom';
        session.window = resolution.window;
        session.section = 0;

        await this.renderStats(adapter, user, session);

        return true;
      }
      case 'user-search': {
        session.pending = null;
        session.userQuery = input === '' ? null : input;
        session.page = 1;

        await this.renderUsers(adapter, user, session);

        return true;
      }
      default: {
        session.pending = null;
        return false;
      }
    }
  }

  // --- callbacks ----------------------------------------------------------------

  async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
    action: AdminCallbackAction,
  ): Promise<void> {
    const capability = capabilityFor(action);

    if (capability === null) {
      await adapter.acknowledge(callbackId);
      return;
    }

    const actor = await this.authorize(adapter, user, capability, {
      action: action.kind,
      incident: true,
    });

    if (!actor) {
      const role = this.roleOf(adapter.platform, user.platformUserId);

      await adapter.acknowledge(
        callbackId,
        role === null
          ? 'این عملیات در دسترس نیست.'
          : 'سطح دسترسی شما برای این عملیات کافی نیست.',
      );

      return;
    }

    const session = this.sessionOf(user.id);

    // Any navigation ends a half-finished text input: a stale draft must never be applied to a screen
    // the administrator has already left (§5.3). The broadcast flow keeps its text in the session (it
    // was confirmed by the preview), so nothing is lost.
    session.pending = null;

    try {
      switch (action.kind) {
        case 'admin-hub':
          await adapter.acknowledge(callbackId);
          await this.renderHub(adapter, user, actor, messageId);
          break;
        case 'admin-stats':
          session.preset = action.preset;
          session.section = action.section;
          session.window = this.requireWindow(action.preset, session);
          await adapter.acknowledge(callbackId);
          await this.renderStats(adapter, user, session, messageId);
          break;
        case 'admin-stats-custom':
          session.pending = {
            kind: 'from-day',
            audience: null,
            startedAt: Date.now(),
          };
          await adapter.acknowledge(callbackId);
          await adapter.render({
            chatId: chatOf(user),
            text:
              '📅 تاریخ شروع بازه را به شکل YYYY-MM-DD (به وقت تهران) بفرستید.\n' +
              `بیشترین طول بازه: ${num(this.config.adminReportMaxDays)} روز.`,
            keyboard: adminTextInputKeyboard(() =>
              callbackDataForAdminStats('today', 0),
            ),
            editMessageId: messageId,
          });
          break;
        case 'admin-dict':
          await adapter.acknowledge(callbackId);
          await adapter.render({
            chatId: chatOf(user),
            text: formatMetricDictionaryScreen(),
            keyboard: adminDictionaryKeyboard(),
            editMessageId: messageId,
          });
          break;
        case 'admin-users':
          session.userFilter = action.filter;
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderUsers(adapter, user, session, messageId);
          break;
        case 'admin-user':
          session.ref = action.userId;
          await adapter.acknowledge(callbackId);
          await this.renderUser(adapter, user, actor, action.userId, messageId);
          break;
        case 'admin-user-search':
          session.pending = {
            kind: 'user-search',
            audience: null,
            startedAt: Date.now(),
          };
          await adapter.acknowledge(callbackId);
          await adapter.render({
            chatId: chatOf(user),
            text:
              '🔍 عبارت جست‌وجو را بفرستید: شناسهٔ داخلی (<code>usr_12</code>)، شناسهٔ پلتفرمی یا ' +
              'کد دعوت.\nبرای پاک‌کردن جست‌وجو یک پیام خالی بفرستید.',
            keyboard: adminTextInputKeyboard(() => callbackDataForAdminHub()),
            editMessageId: messageId,
          });
          break;
        case 'admin-channels':
          await adapter.acknowledge(callbackId);
          await this.renderChannels(adapter, user, actor, session, messageId);
          break;
        case 'admin-channel-history':
          await adapter.acknowledge(callbackId);
          await this.renderChannelHistory(adapter, user, session, messageId);
          break;
        case 'admin-publishing':
          if (!action.confirmed) {
            await adapter.acknowledge(callbackId);
            await adapter.render({
              chatId: chatOf(user),
              text:
                action.op === 'disable'
                  ? '⛔️ <b>غیرفعال کردن انتشار</b>\n\nاز این پس هیچ انتشار زمان‌بندی‌شده یا ' +
                    'رویدادی به کانال فرستاده نمی‌شود (کارهای در انتظار باقی می‌مانند).\n\nبا تأیید، ' +
                    'این تغییر ذخیره و در رخدادنگار ثبت می‌شود.'
                  : '✅ <b>فعال کردن انتشار</b>\n\nانتشار زمان‌بندی‌شده و رویدادی از سر گرفته ' +
                    'می‌شود. هیچ پیامی به‌صورت دستی ساخته نمی‌شود.',
              keyboard: adminPublishingConfirmKeyboard(action.op),
              editMessageId: messageId,
            });
            break;
          }

          await this.applyPublishingChange(
            adapter,
            user,
            actor,
            action.op,
            callbackId,
            messageId,
          );
          break;
        case 'admin-test-message':
          if (!action.confirmed) {
            await adapter.acknowledge(callbackId);
            await this.renderTestMessageConfirm(
              adapter,
              user,
              action.destination,
              messageId,
            );
            break;
          }

          await this.sendTestMessage(
            adapter,
            user,
            actor,
            action.destination,
            callbackId,
            messageId,
          );
          break;
        case 'admin-alerts':
          session.alertFilter = action.filter;
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderAlerts(adapter, user, actor, session, messageId);
          break;
        case 'admin-alert':
          session.ref = action.alertId;
          await adapter.acknowledge(callbackId);
          await this.renderAlert(
            adapter,
            user,
            actor,
            action.alertId,
            messageId,
          );
          break;
        case 'admin-alert-state':
          if (!action.confirmed) {
            await adapter.acknowledge(callbackId);
            await adapter.render({
              chatId: chatOf(user),
              text:
                action.op === 'disable'
                  ? '⛔️ <b>غیرفعال کردن هشدار</b>\n\nهشدار از ظرفیت مؤثر کاربر خارج می‌شود و ' +
                    'دیگر بررسی نمی‌شود. رکوردهای قبلی و رویدادهای رزروشده دست‌نخورده می‌مانند.'
                  : '✅ <b>فعال کردن هشدار</b>\n\nهشدار دوباره فعال می‌شود؛ ظرفیت مؤثر کاربر ' +
                    'دوباره بررسی می‌شود و در صورت پرشدن، فعال‌سازی انجام نمی‌شود.',
              keyboard: adminAlertStateConfirmKeyboard({
                alertId: action.alertId,
                op: action.op,
              }),
              editMessageId: messageId,
            });
            break;
          }

          await this.applyAlertState(
            adapter,
            user,
            actor,
            action.alertId,
            action.op,
            callbackId,
            messageId,
          );
          break;
        case 'admin-leads':
          session.leadFilter = action.filter;
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderLeads(adapter, user, actor, session, messageId);
          break;
        case 'admin-campaigns':
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderCampaigns(adapter, user, actor, session, messageId);
          break;
        case 'admin-campaign-funnel':
          session.ref = action.campaignId;
          await adapter.acknowledge(callbackId);
          await this.renderFunnel(
            adapter,
            user,
            actor,
            session,
            action.campaignId,
            messageId,
          );
          break;
        case 'admin-errors':
          session.incidentFilter = action.filter;
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderErrors(adapter, user, actor, session, messageId);
          break;
        case 'admin-error':
          session.ref = action.incidentId;
          await adapter.acknowledge(callbackId);
          await this.renderIncident(
            adapter,
            user,
            action.incidentId,
            messageId,
          );
          break;
        case 'admin-error-act':
          await this.applyIncidentAction(
            adapter,
            user,
            actor,
            action.incidentId,
            action.op,
            callbackId,
            messageId,
          );
          break;
        case 'admin-error-retry':
          await this.retryIncident(
            adapter,
            user,
            actor,
            action.incidentId,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast':
        case 'admin-broadcast-list':
          await adapter.acknowledge(callbackId);
          await this.renderBroadcastHub(adapter, user, session, messageId);
          break;
        case 'admin-broadcast-audience':
          await this.chooseAudience(
            adapter,
            user,
            action,
            session,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast-text':
          if (!session.broadcastAudience) {
            await adapter.acknowledge(
              callbackId,
              'ابتدا مخاطبان را انتخاب کنید.',
            );
            break;
          }

          session.pending = {
            kind: 'broadcast-text',
            audience: session.broadcastAudience,
            startedAt: Date.now(),
          };
          await adapter.acknowledge(callbackId);
          await adapter.render({
            chatId: chatOf(user),
            text:
              '✍️ متن پیام را بفرستید (متن ساده، بدون قالب‌بندی).\n' +
              `حداکثر ${num(this.config.adminBroadcastMaxLength)} نویسه.`,
            keyboard: adminTextInputKeyboard(() => callbackDataForAdminHub()),
            editMessageId: messageId,
          });
          break;
        case 'admin-broadcast-preview':
          if (!session.broadcastText || !session.broadcastAudience) {
            await adapter.acknowledge(callbackId, 'پیش‌نویسی موجود نیست.');
            break;
          }

          await adapter.acknowledge(callbackId);
          await this.renderBroadcastPreview(
            adapter,
            user,
            session.broadcastText,
            session.broadcastAudience,
            messageId,
          );
          break;
        case 'admin-broadcast-save':
          await this.prepareBroadcast(
            adapter,
            user,
            actor,
            session,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast-start':
          await this.startBroadcast(
            adapter,
            user,
            actor,
            action.reference,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast-cancel':
          await this.cancelBroadcast(
            adapter,
            user,
            actor,
            action.reference,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast-retry':
          await this.retryBroadcast(
            adapter,
            user,
            actor,
            action.reference,
            callbackId,
            messageId,
          );
          break;
        case 'admin-broadcast-report':
          await adapter.acknowledge(callbackId);
          await this.renderBroadcastReport(
            adapter,
            user,
            action.reference,
            messageId,
          );
          break;
        case 'admin-audit':
          session.page = action.page;
          await adapter.acknowledge(callbackId);
          await this.renderAudit(adapter, user, session, messageId);
          break;
        default:
          await adapter.acknowledge(callbackId);
          break;
      }
    } catch (error) {
      this.logger.error(
        `Admin action ${action.kind} failed: ${describeError(error)}`,
      );
      await adapter.acknowledge(callbackId, 'انجام این عملیات ممکن نشد.');
      await this.errors.record({
        source: 'admin',
        category: 'ACTION_FAILED',
        severity: 'HIGH',
        summary: `اجرای عملیات مدیریتی ${action.kind} ناموفق بود: ${truncate(
          describeError(error),
          120,
        )}`,
        retryable: false,
      });
    }
  }

  // --- authorization ------------------------------------------------------------

  /**
   * Resolve the acting administrator and check one capability.
   *
   * The refusal is recorded in the audit trail (and, for a button press, as an operational incident):
   * a failed privileged attempt is evidence, not silence (§13.2).
   */
  /**
   * Resolve the acting administrator and check one capability.
   *
   * The refusal is awaited, not fired and forgotten: a denial is a security record, and a record that
   * can be lost on shutdown is not a record (§2, §12.4).
   */
  private async authorize(
    adapter: PlatformAdapter,
    user: User,
    capability: AdminCapability,
    options: { action: string; incident: boolean },
  ): Promise<AuditActor | null> {
    const role = this.access.roleOf(adapter.platform, user.platformUserId);

    if (role !== null && this.access.can(role, capability)) {
      return {
        key: this.access.actorKey(adapter.platform, user.platformUserId),
        role,
      };
    }

    await this.audit.record({
      actor: this.access.actorKey(adapter.platform, user.platformUserId),
      role: role ?? 'SYSTEM',
      action: 'ADMIN_DENIED',
      targetType: 'admin',
      targetRef: capability,
      result: 'DENIED',
      reason:
        role === null
          ? `not on the admin allow-list (${options.action})`
          : `missing capability ${capability} (${options.action})`,
    });

    if (options.incident) {
      await this.errors.record({
        source: 'admin',
        category: 'UNAUTHORIZED_ATTEMPT',
        severity: 'HIGH',
        summary: `تلاش دسترسی مدیریتی بدون مجوز (${capability}) — ${options.action}`,
        reference: this.access.actorKey(adapter.platform, user.platformUserId),
        retryable: false,
      });
    }

    return null;
  }

  // --- hub / dashboard ----------------------------------------------------------

  private async renderHub(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    messageId?: number,
  ): Promise<void> {
    const described = this.access.describe();
    const lastAudit = this.audit.list(1)[0] ?? null;

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminHubScreen({
        owners: [...described.owners],
        admins: [...described.admins],
        broadcastEnabled: this.broadcast.enabled,
        activeBroadcasts: this.broadcast.activeJobs().length,
        openIncidents: this.errors.openCount(),
        lastAuditAt: lastAudit?.at ?? null,
      }),
      keyboard: this.hubKeyboard(actor),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_OPEN',
      targetType: 'admin',
      targetRef: 'hub',
      result: 'OK',
    });
  }

  /**
   * The hub keyboard for one actor. When no actor is known the owner-only row is omitted — the safe
   * default — because hiding a button is a presentation decision, never an authorization one.
   */
  private hubKeyboard(actor?: AuditActor) {
    return adminHubKeyboard({
      broadcastEnabled: this.broadcast.enabled,
      activeBroadcasts: this.broadcast.activeJobs().length,
      canAudit:
        actor && actor.role !== 'SYSTEM'
          ? this.access.can(actor.role, 'audit')
          : false,
    });
  }

  private requireWindow(
    preset: PeriodPreset,
    session: AdminSession,
  ): ReportWindow {
    if (session.preset === 'custom' && session.window) {
      return session.window;
    }

    const resolution = this.metrics.window(preset, new Date());

    if (!resolution.ok) {
      throw new Error(`Unexpected window rejection: ${resolution.message}`);
    }

    session.preset = preset;
    session.window = resolution.window;

    return resolution.window;
  }

  private statsPreset(session: AdminSession): PeriodPreset {
    return session.preset === 'custom' ? 'today' : session.preset;
  }

  private async renderStats(
    adapter: PlatformAdapter,
    user: User,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = session.window ?? this.requireWindow('today', session);
    const sections: MetricSection[] = this.metrics.dashboard(window);
    const allTime = this.metrics.window('all', new Date());
    const allTimeWindow = allTime.ok ? allTime.window : window;
    const sectionCount = sections.length + 1;
    const section = Math.min(Math.max(0, session.section), sectionCount - 1);

    session.section = section;
    session.screen = 'stats';

    if (section === sectionCount - 1) {
      await adapter.render({
        chatId: chatOf(user),
        text: formatHealthScreen(this.metrics.systemHealth(new Date()), window),
        keyboard: adminStatsKeyboard(
          this.statsPreset(session),
          section,
          sectionCount,
        ),
        editMessageId: messageId,
      });

      return;
    }

    await adapter.render({
      chatId: chatOf(user),
      text: formatDashboardSection(
        sections[section],
        window,
        section,
        sectionCount,
        allTimeWindow,
      ),
      keyboard: adminStatsKeyboard(
        this.statsPreset(session),
        section,
        sectionCount,
      ),
      editMessageId: messageId,
    });
  }

  private async openScreenFrom(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    argument: string,
  ): Promise<void> {
    const session = this.sessionOf(user.id);

    switch (argument) {
      case '':
      case 'menu':
        await this.renderHub(adapter, user, actor);
        return;
      case 'stats':
        session.window = this.requireWindow('today', session);
        await this.renderStats(adapter, user, session);
        return;
      case 'users':
        await this.renderUsers(adapter, user, session);
        return;
      case 'channels':
        await this.renderChannels(adapter, user, actor, session);
        return;
      case 'alerts':
        await this.renderAlerts(adapter, user, actor, session);
        return;
      case 'leads':
        await this.renderLeads(adapter, user, actor, session);
        return;
      case 'campaigns':
        await this.renderCampaigns(adapter, user, actor, session);
        return;
      case 'errors':
        await this.renderErrors(adapter, user, actor, session);
        return;
      case 'broadcast':
        await this.renderBroadcastHub(adapter, user, session);
        return;
      case 'audit':
        await this.renderAudit(adapter, user, session);
        return;
      default:
        this.logger.warn(`Unknown /admin argument from ${actor.key}.`);
        await this.renderHub(adapter, user, actor);
        return;
    }
  }

  // --- users --------------------------------------------------------------------

  private async renderUsers(
    adapter: PlatformAdapter,
    user: User,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const recent = this.recentWindow();
    const query = session.userQuery?.toLowerCase() ?? null;
    const allUsers = this.users.listUsers();
    // Batched lookups (one pass over each store) instead of a query per rendered row (§16).
    const alertsByUser = countBy(
      this.alertStore
        .listAlerts()
        .filter((alert) => alert.status !== 'DELETED'),
      (alert) => alert.userId,
    );
    const referralsByUser = countBy(
      this.users.listReferrals(),
      (referral) => referral.inviterUserId,
    );

    const filtered = allUsers
      .filter((row) => {
        if (session.userFilter === 'bale' && row.platform !== 'bale') {
          return false;
        }

        if (session.userFilter === 'telegram' && row.platform !== 'telegram') {
          return false;
        }

        if (session.userFilter === 'new' && !isWithin(recent, row.createdAt)) {
          return false;
        }

        if (
          session.userFilter === 'inactive' &&
          this.activity.isActiveIn(
            `${row.platform}:${row.platformUserId}`,
            recent,
          )
        ) {
          return false;
        }

        if (query !== null && query !== '') {
          const haystack =
            `${row.id} ${row.platformUserId} ${row.referralCode ?? ''}`.toLowerCase();

          if (!haystack.includes(query)) {
            return false;
          }
        }

        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const pageSize = this.config.adminPageSize;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, session.page), pageCount);
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

    session.page = page;
    session.screen = 'users';

    const renderRows = rows.map((row) => ({
      userId: row.id,
      platform: row.platform,
      createdAt: row.createdAt,
      lastInteractionAt: row.lastInteractionAt ?? null,
      isNew: isWithin(recent, row.createdAt),
      alerts: alertsByUser.get(row.id) ?? 0,
      referrals: referralsByUser.get(row.id) ?? 0,
      leads: this.sales.listLeadsByIdentity(
        `${row.platform}:${row.platformUserId}`,
      ).length,
    }));

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminUsersListScreen({
        rows: renderRows,
        page,
        pageCount,
        total: filtered.length,
        filterLabel: userFilterLabel(session.userFilter),
        query: session.userQuery,
      }),
      keyboard: adminUsersKeyboard({
        filter: session.userFilter,
        page,
        pageCount,
        rows: renderRows,
      }),
      editMessageId: messageId,
    });
  }

  private async renderUser(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    userId: string,
    messageId?: number,
  ): Promise<void> {
    const target = this.users.listUsers().find((row) => row.id === userId);

    if (!target) {
      await this.notice(adapter, user, 'این کاربر پیدا نشد.', messageId);
      return;
    }

    const identityKey = `${target.platform}:${target.platformUserId}`;
    const alerts = this.alertStore
      .listAlerts()
      .filter((alert) => alert.userId === target.id);
    const leads = this.sales.listLeadsByIdentity(identityKey);

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminUserDetailScreen({
        userId: target.id,
        platform: target.platform,
        platformUserId: target.platformUserId,
        chatId: target.chatId,
        createdAt: target.createdAt,
        lastInteractionAt: target.lastInteractionAt ?? null,
        referralCode: target.referralCode ?? null,
        activityDays: this.activity.daysOf(identityKey),
        alerts: {
          total: alerts.filter((alert) => alert.status !== 'DELETED').length,
          active: alerts.filter((alert) => alert.status === 'ACTIVE').length,
          triggered: alerts.filter((alert) => alert.status === 'TRIGGERED')
            .length,
        },
        referrals: {
          successful: this.users
            .listReferrals()
            .filter((referral) => referral.inviterUserId === target.id).length,
          grantedRewards: this.users
            .listRewards(target.id)
            .filter((reward) => reward.status === 'GRANTED').length,
        },
        leads: {
          total: leads.length,
          open: leads.filter((lead) => isOpenLead(lead.status)).length,
        },
        notificationDestinations: target.chatId ? 1 : 0,
      }),
      keyboard: adminUserDetailKeyboard(target.id),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'user',
      targetRef: target.id,
      result: 'OK',
    });
  }

  /** The documented 30-day window used by the “new” / “inactive” user filters. */
  private recentWindow(): ReportWindow {
    const resolution = this.metrics.window('30d', new Date());

    if (!resolution.ok) {
      throw new Error(`Unexpected 30d window rejection: ${resolution.message}`);
    }

    return resolution.window;
  }

  // --- channels -----------------------------------------------------------------

  private async renderChannels(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = this.metrics.window('today', new Date());
    const todayWindow = window.ok ? window.window : this.recentWindow();
    const destinations = this.publisher.destinations.map((destination) => ({
      platform: destination.platform,
      destination: destination.destination,
      key: this.publisher.destinationKey,
    }));
    const jobs = this.publication.listJobs();
    const deliveries = jobs.flatMap((job) =>
      this.publication.listDeliveries(job.id),
    );
    const inWindow = deliveries.filter((delivery) =>
      isWithin(todayWindow, delivery.lastAttemptAt ?? delivery.createdAt),
    );
    const sorted = [...deliveries].sort((left, right) =>
      (right.lastAttemptAt ?? right.createdAt).localeCompare(
        left.lastAttemptAt ?? left.createdAt,
      ),
    );
    const last = sorted[0];
    const failures = latestFailures(sorted);

    session.screen = 'channels';

    await adapter.render({
      chatId: chatOf(user),
      text: formatChannelsScreen({
        publishingEnabled: this.engine.publishingEnabled,
        configuredPlatforms: this.registry
          .getInboundPlatforms()
          .map((platform) => String(platform)),
        destinations,
        window: todayWindow,
        deliveries: {
          sent: inWindow.filter((delivery) => delivery.status === 'SENT')
            .length,
          failed: inWindow.filter((delivery) => delivery.status === 'FAILED')
            .length,
          unknown: inWindow.filter((delivery) => delivery.status === 'UNKNOWN')
            .length,
          attempts: inWindow.reduce(
            (total, delivery) => total + delivery.attemptCount,
            0,
          ),
        },
        lastDelivery: last
          ? {
              platform: last.platform,
              status: last.status,
              externalMessageId: last.externalMessageId,
              at: last.lastAttemptAt ?? last.createdAt,
              error: last.status === 'SENT' ? null : last.lastError,
            }
          : null,
        retryState: {
          pending: jobs.filter((job) => job.status === 'PENDING').length,
          publishing: jobs.filter((job) => job.status === 'PUBLISHING').length,
          failed: jobs.filter((job) => job.status === 'FAILED').length,
        },
        recentFailures: failures,
        windowDeliveries: inWindow.length,
      }),
      keyboard: adminChannelsKeyboard({
        publishingEnabled: this.engine.publishingEnabled,
        destinationCount: destinations.length,
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'channels',
      targetRef: `${destinations.length} destination(s)`,
      result: 'OK',
    });
  }

  private async renderChannelHistory(
    adapter: PlatformAdapter,
    user: User,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = this.requireWindow('7d', session);
    const jobs = this.publication
      .listJobs()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const lines: string[] = [];

    for (const job of jobs.slice(0, 10)) {
      const deliveries = this.publication.listDeliveries(job.id);

      if (
        deliveries.length === 0 ||
        !deliveries.some((delivery) =>
          isWithin(window, delivery.lastAttemptAt ?? delivery.createdAt),
        )
      ) {
        continue;
      }

      const confirmed = deliveries.filter(
        (delivery) => delivery.status === 'SENT',
      );
      const proof = confirmed.find(
        (delivery) => delivery.externalMessageId !== null,
      );

      lines.push(
        `• <code>${escapeHtml(job.id)}</code> · ${escapeHtml(job.messageType)} · ${escapeHtml(
          job.status,
        )}\n` +
          `   تأییدشده: ${num(confirmed.length)}/${num(deliveries.length)}` +
          (proof?.externalMessageId
            ? ` · شناسهٔ پیام: <code>${escapeHtml(truncate(proof.externalMessageId, 12))}</code>`
            : '') +
          (job.skipReason
            ? `\n   دلیل رد: ${escapeHtml(job.skipReason)}`
            : '') +
          (job.lastError
            ? `\n   خطا: ${escapeHtml(truncate(job.lastError, 80))}`
            : ''),
      );
    }

    session.screen = 'channel-history';

    await adapter.render({
      chatId: chatOf(user),
      text:
        '📜 <b>تاریخچهٔ تحویل کانال</b>\n\n' +
        (lines.length
          ? lines.join('\n\n')
          : 'در این بازه تحویلی ثبت نشده است.') +
        '\n\n<i>شناسهٔ پیام پلتفرم تنها مدرک تحویل است؛ «در انتظار» و «ناموفق» جدا شمرده می‌شوند.</i>',
      keyboard: adminChannelsKeyboard({
        publishingEnabled: this.engine.publishingEnabled,
        destinationCount: this.publisher.destinations.length,
      }),
      editMessageId: messageId,
    });
  }

  private async renderTestMessageConfirm(
    adapter: PlatformAdapter,
    user: User,
    destination: number,
    messageId?: number,
  ): Promise<void> {
    const target = this.publisher.destinations[destination - 1];

    await adapter.render({
      chatId: chatOf(user),
      text: target
        ? '✉️ <b>پیام آزمایشی</b>\n\n' +
          `مقصد: ${escapeHtml(target.platform)} → ` +
          `<code>${escapeHtml(truncate(target.destination, 16))}</code>\n\n` +
          'یک متن کوتاه به همین مقصد فرستاده می‌شود و نتیجهٔ واقعی پلتفرم گزارش می‌گردد.\n\n' +
          '<i>«پذیرش» به‌معنای «قابل مشاهده بودن برای مخاطب» نیست و همین‌طور هم گزارش می‌شود. ' +
          'هیچ توکنی نمایش داده نمی‌شود.</i>'
        : '⚠️ مقصدی با این شماره تنظیم نشده است؛ پیام آزمایشی ارسال نمی‌شود.',
      keyboard: adminTestMessageConfirmKeyboard(destination),
      editMessageId: messageId,
    });
  }

  private async applyPublishingChange(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    op: 'enable' | 'disable',
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const enable = op === 'enable';
    const before = this.engine.publishingEnabled;

    // The Phase 5 engine owns the switch (nothing here writes its document directly).
    await this.engine.setPublishingEnabled(enable);

    await adapter.acknowledge(
      callbackId,
      enable ? 'انتشار فعال شد.' : 'انتشار غیرفعال شد.',
    );

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'CHANNEL_PUBLISHING_TOGGLED',
      targetType: 'publishing',
      targetRef: 'channel',
      result: 'OK',
      fromState: before ? 'enabled' : 'disabled',
      toState: enable ? 'enabled' : 'disabled',
      reason: enable ? 'فعال‌سازی از پنل مدیریت' : 'غیرفعال‌سازی از پنل مدیریت',
    });

    await this.renderChannels(
      adapter,
      user,
      actor,
      this.sessionOf(user.id),
      messageId,
    );
  }

  private async sendTestMessage(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    destinationIndex: number,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const target = this.publisher.destinations[destinationIndex - 1];

    if (!target) {
      await adapter.acknowledge(callbackId, 'این مقصد تنظیم نشده است.');
      return;
    }

    // The existing delivery path is used unchanged — the same publisher, the same client, the same
    // failure classification. No parallel “test sender” exists.
    const outcome = await this.publisher.publish(target, {
      publicationId: `admin-test-${Date.now()}`,
      messageType: 'BRANDED',
      text: `✉️ پیام آزمایشی از پنل مدیریت اتابک — ${escapeHtml(
        new Intl.DateTimeFormat('fa-IR', {
          timeZone: 'Asia/Tehran',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date()),
      )}`,
      parseMode: 'HTML',
      cta: null,
      media: null,
      destinationKey: this.publisher.destinationKey,
      meta: {
        reportingDate: null,
        symbols: [],
        variant: null,
        contentRevision: null,
      },
    });

    const accepted = outcome.status === 'SENT';

    await adapter.acknowledge(
      callbackId,
      accepted ? 'پلتفرم پیام را پذیرفت.' : 'پلتفرم پیام را نپذیرفت.',
    );

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'CHANNEL_TEST_MESSAGE',
      targetType: 'channel-destination',
      targetRef: `${target.platform}:${truncate(target.destination, 12)}`,
      result: accepted ? 'OK' : 'FAILED',
      toState: accepted ? 'accepted' : outcome.status,
      reason: accepted
        ? outcome.messageId === null
          ? 'پذیرش بدون شناسهٔ پیام'
          : 'پذیرش با شناسهٔ پیام'
        : truncate(outcome.error ?? 'بدون پیام خطا', 120),
    });

    if (!accepted) {
      await this.errors.record({
        source:
          target.platform === 'telegram'
            ? 'platform-telegram'
            : 'platform-bale',
        category: 'TEST_MESSAGE_FAILED',
        severity: 'MEDIUM',
        summary: `پیام آزمایشی به یک مقصد کانال تحویل نشد: ${truncate(
          outcome.error ?? outcome.status,
          120,
        )}`,
        retryable: outcome.failureKind === 'RETRYABLE',
      });
    }

    await adapter.render({
      chatId: chatOf(user),
      text: accepted
        ? '✅ <b>پیام آزمایشی</b>\n\nپلتفرم پیام را پذیرفت' +
          (outcome.messageId === null
            ? '، اما شناسهٔ پیام برنگرداند (مدرک تحویل ثبت نشد).\n'
            : ` (شناسهٔ پیام: <code>${escapeHtml(outcome.messageId)}</code>).\n`) +
          '<i>«پذیرش» یعنی پلتفرم درخواست را قبول کرد؛ مشاهدهٔ آن برای مخاطب تأیید نشده است.</i>'
        : '❌ <b>پیام آزمایشی ارسال نشد</b>\n\n' +
          `دلیل: ${escapeHtml(truncate(outcome.error ?? 'پلتفرم خطای نامشخص برگرداند', 160))}\n` +
          `<i>وضعیت تحویل: ${escapeHtml(outcome.status)}${
            outcome.failureKind
              ? ` · نوع خطا: ${escapeHtml(outcome.failureKind)}`
              : ''
          }</i>`,
      keyboard: adminChannelsKeyboard({
        publishingEnabled: this.engine.publishingEnabled,
        destinationCount: this.publisher.destinations.length,
      }),
      editMessageId: messageId,
    });
  }

  // --- alerts -------------------------------------------------------------------

  private async renderAlerts(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = this.requireWindow('today', session);
    const all = this.alertStore
      .listAlerts()
      .filter((alert) => alert.status !== 'DELETED');
    const filtered = all.filter((alert) =>
      matchesAlertFilter(alert, session.alertFilter),
    );
    const pageSize = this.config.adminPageSize;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, session.page), pageCount);
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
    const deliveries = this.alertStore.listDeliveries();

    session.page = page;
    session.screen = 'alerts';

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminAlertsList({
        rows: rows.map((alert) => ({
          alertId: alert.id,
          userRef: alert.userId,
          platform: alert.platform,
          status: alert.status,
          summary: alertSummaryFa(alert),
          createdAt: alert.createdAt,
        })),
        page,
        pageCount,
        total: filtered.length,
        filterLabel: alertFilterLabel(session.alertFilter),
        window,
        windowCreated: all.filter((alert) => isWithin(window, alert.createdAt))
          .length,
        deliveries: {
          sent: deliveries.filter((delivery) => delivery.status === 'SENT')
            .length,
          pending: deliveries.filter(
            (delivery) => delivery.status === 'PENDING',
          ).length,
          failed: deliveries.filter((delivery) => delivery.status === 'FAILED')
            .length,
        },
      }),
      keyboard: adminAlertsKeyboard({
        filter: session.alertFilter,
        page,
        pageCount,
        rows: rows.map((alert) => ({ alertId: alert.id })),
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'alerts',
      targetRef: `${session.alertFilter}:${page}`,
      result: 'OK',
    });
  }

  private async renderAlert(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    alertId: string,
    messageId?: number,
  ): Promise<void> {
    const alert = this.alertStore
      .listAlerts()
      .find((row) => row.id === alertId);

    if (!alert) {
      await this.notice(adapter, user, 'این هشدار پیدا نشد.', messageId);
      return;
    }

    const deliveries = this.alertStore
      .listDeliveries()
      .filter((delivery) => delivery.alertId === alert.id);
    const last = [...deliveries].sort((left, right) =>
      (right.lastAttemptAt ?? right.triggeredAt).localeCompare(
        left.lastAttemptAt ?? left.triggeredAt,
      ),
    )[0];

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminAlertDetail({
        alertId: alert.id,
        ownerRef: alert.userId,
        platform: alert.platform,
        status: alert.status,
        createdLabel: alert.createdAt,
        conditionLabel: alertSummaryFa(alert),
        effectiveCapacity: this.alerts.effectiveMaxAlerts(alert.userId),
        usedCapacity: this.alerts.countForCapacity(alert.userId),
        deliveries: {
          total: deliveries.length,
          sent: deliveries.filter((delivery) => delivery.status === 'SENT')
            .length,
          pending: deliveries.filter(
            (delivery) => delivery.status === 'PENDING',
          ).length,
          failed: deliveries.filter((delivery) => delivery.status === 'FAILED')
            .length,
        },
        lastDelivery: last
          ? {
              status: last.status,
              at: last.lastAttemptAt ?? last.triggeredAt,
              error: last.lastError,
            }
          : null,
      }),
      keyboard: adminAlertDetailKeyboard({
        alertId: alert.id,
        status: alert.status,
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'alert',
      targetRef: alert.id,
      result: 'OK',
    });
  }

  private async applyAlertState(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    alertId: string,
    op: 'disable' | 'enable',
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const alert = this.alertStore
      .listAlerts()
      .find((row) => row.id === alertId);

    if (!alert) {
      await adapter.acknowledge(callbackId, 'این هشدار پیدا نشد.');
      return;
    }

    // Phase 3 stays the owner: it checks the legal transition and the *effective* capacity (base
    // limit + the Phase 7 reward slots). The administrator's own rights were verified above.
    const result =
      op === 'disable'
        ? await this.alerts.disable(alert.userId, alert.id)
        : await this.alerts.enable(alert.userId, alert.id);

    if (!result.ok) {
      await adapter.acknowledge(
        callbackId,
        result.reason === 'LIMIT_REACHED'
          ? 'ظرفیت مؤثر این کاربر پر است؛ فعال‌سازی ممکن نیست.'
          : 'این تغییر از نظر قوانین فاز ۳ مجاز نیست.',
      );

      await this.audit.record({
        actor: actor.key,
        role: actor.role,
        action: op === 'disable' ? 'ALERT_DISABLED' : 'ALERT_ENABLED',
        targetType: 'alert',
        targetRef: alert.id,
        result: 'FAILED',
        reason: result.reason,
      });

      return;
    }

    await adapter.acknowledge(
      callbackId,
      op === 'disable' ? 'هشدار غیرفعال شد.' : 'هشدار فعال شد.',
    );

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: op === 'disable' ? 'ALERT_DISABLED' : 'ALERT_ENABLED',
      targetType: 'alert',
      targetRef: alert.id,
      result: 'OK',
      fromState: alert.status,
      toState: result.alert.status,
      reason: `مالک: ${alert.userId}`,
    });

    await this.renderAlert(adapter, user, actor, alert.id, messageId);
  }

  // --- leads --------------------------------------------------------------------

  private async renderLeads(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = this.requireWindow('today', session);
    const page = Math.max(1, session.page);
    const offset = (page - 1) * LEAD_PAGE_SIZE;
    const filter = leadQuery(session.leadFilter, window);
    const rows = this.sales.listLeads({
      ...filter,
      limit: LEAD_PAGE_SIZE,
      offset,
    });
    const total = this.sales.countLeads(filter);
    const pageCount = Math.max(1, Math.ceil(total / LEAD_PAGE_SIZE));

    session.page = Math.min(page, pageCount);
    session.screen = 'leads';

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminLeadsList({
        rows: rows.map((lead) => ({
          leadId: lead.leadId,
          reference: lead.reference,
          status: lead.status,
          createdAt: lead.createdAt,
          updatedAt: lead.updatedAt,
          identityRef: lead.identityKey,
        })),
        page: session.page,
        pageCount,
        total,
        counts: this.sales.countByStatus(),
        filterLabel: leadFilterLabel(session.leadFilter),
      }),
      keyboard: adminLeadsKeyboard({
        filter: session.leadFilter,
        page: session.page,
        pageCount,
        rows: rows.map((lead) => ({
          leadId: lead.leadId,
          reference: lead.reference,
        })),
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'leads',
      targetRef: `${session.leadFilter}:${session.page}`,
      result: 'OK',
    });
  }

  // --- campaigns ----------------------------------------------------------------

  private async renderCampaigns(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const window = this.requireWindow('30d', session);
    const campaigns = this.campaignStore
      .listCampaigns()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const pageSize = this.config.adminPageSize;
    const pageCount = Math.max(1, Math.ceil(campaigns.length / pageSize));
    const page = Math.min(Math.max(1, session.page), pageCount);
    const rows = campaigns.slice((page - 1) * pageSize, page * pageSize);
    const aggregate = this.campaignMetrics.aggregateReport({
      from: new Date(window.from),
      to: new Date(window.to),
      label: window.labelFa,
    });

    session.page = page;
    session.screen = 'campaigns';

    await adapter.render({
      chatId: chatOf(user),
      text: formatAdminCampaignsList({
        rows: rows.map((campaign) => ({
          campaignId: campaign.campaignId,
          name: campaign.name,
          status: campaign.status,
          active: campaign.status === 'ACTIVE',
          createdAt: campaign.createdAt,
          destination: campaign.destination,
        })),
        page,
        pageCount,
        total: campaigns.length,
        trackingEnabled: this.tracking.enabled,
        window,
        aggregate: {
          campaigns: aggregate.campaigns.length,
          clicks: metricValue(aggregate.totals, 'clicksRaw'),
          starts: metricValue(aggregate.totals, 'totalStarts'),
          verifiedJoins: metricValue(aggregate.totals, 'verifiedJoins'),
        },
      }),
      keyboard: adminCampaignsKeyboard({
        page,
        pageCount,
        rows: rows.map((campaign) => ({ campaignId: campaign.campaignId })),
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'campaigns',
      targetRef: String(page),
      result: 'OK',
    });
  }

  private async renderFunnel(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    campaignId: string,
    messageId?: number,
  ): Promise<void> {
    const window = this.requireWindow('30d', session);
    const report = this.campaignMetrics.campaignReport(campaignId, {
      from: new Date(window.from),
      to: new Date(window.to),
      label: window.labelFa,
    });

    if (!report) {
      await this.notice(adapter, user, 'این کمپین پیدا نشد.', messageId);
      return;
    }

    session.screen = 'funnel';

    await adapter.render({
      chatId: chatOf(user),
      text: formatCampaignFunnelScreen({
        campaignId,
        name: report.campaign.name,
        window,
        stages: FUNNEL_STAGES.map((stage) => {
          const metric = report.metrics.find(
            (row) => row.key === stage.metricKey,
          );

          return {
            key: stage.metricKey,
            labelFa: stage.labelFa,
            value: metric ? metric.value : null,
            unavailableReason:
              metric?.unavailableReason ??
              (metric
                ? 'این مرحله در این بازه قابل اندازه‌گیری نیست.'
                : 'این مرحله در فاز ۸ ثبت نمی‌شود.'),
          };
        }),
        notes: report.notes,
      }),
      keyboard: adminCampaignFunnelKeyboard(campaignId),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'campaign-funnel',
      targetRef: campaignId,
      result: 'OK',
    });
  }

  // --- error center -------------------------------------------------------------

  private async renderErrors(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const filter = incidentQuery(session.incidentFilter);
    const pageSize = this.config.adminPageSize;
    const total = this.errors.count(filter);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, session.page), pageCount);
    const rows = this.errors.list({
      ...filter,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const window = this.requireWindow('7d', session);

    session.page = page;
    session.screen = 'errors';

    await adapter.render({
      chatId: chatOf(user),
      text: formatIncidentsScreen({
        rows,
        page,
        pageCount,
        total,
        filterLabel: incidentFilterLabel(session.incidentFilter),
        openBySeverity: this.errors.openBySeverity(),
        sources: this.errors.occurrenceBreakdown(window.from, window.to),
        pruned: this.errors.prunedCounters,
      }),
      keyboard: adminErrorsKeyboard({
        filter: session.incidentFilter,
        page,
        pageCount,
        rows,
      }),
      editMessageId: messageId,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'ADMIN_VIEW',
      targetType: 'incidents',
      targetRef: `${session.incidentFilter}:${page}`,
      result: 'OK',
    });
  }

  private async renderIncident(
    adapter: PlatformAdapter,
    user: User,
    incidentId: string,
    messageId?: number,
  ): Promise<void> {
    const incident = this.errors.find(incidentId);

    if (!incident) {
      await this.notice(adapter, user, 'این رویداد پیدا نشد.', messageId);
      return;
    }

    await adapter.render({
      chatId: chatOf(user),
      text: formatIncidentDetail({
        incident,
        relatedAudit: [],
        retryHint: this.retryHint(incident.source, incident.retryable),
      }),
      keyboard: adminIncidentDetailKeyboard({
        incidentId: incident.incidentId,
        status: incident.status,
        retryable: incident.retryable,
      }),
      editMessageId: messageId,
    });
  }

  private retryHint(source: string, retryable: boolean): string {
    if (!retryable) {
      return 'این رویداد از پنل دوباره اجرا نمی‌شود؛ علت اصلی آن توسط همان ماژول مدیریت می‌شود.';
    }

    switch (source) {
      case 'channel-publisher':
        return 'تلاش دوباره فقط وقتی ممکن است که هیچ مقصدی تحویل تأییدشده نداشته باشد.';
      case 'alert-notification':
      case 'sales-notification':
        return 'تلاش دوباره، اعلان‌های معلق همان صف را از سر می‌گیرد (بدون ارسال تکراری).';
      case 'broadcast':
        return 'برای ارسال گروهی از صفحهٔ خودش «تلاش دوباره برای ناموفق‌ها» را بزنید.';
      default:
        return 'این رویداد تلاش دوبارهٔ ایمن ندارد.';
    }
  }

  private async applyIncidentAction(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    incidentId: string,
    op: 'review' | 'resolve' | 'reopen',
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const incident = this.errors.find(incidentId);

    if (!incident) {
      await adapter.acknowledge(callbackId, 'این رویداد پیدا نشد.');
      return;
    }

    const updated =
      op === 'review'
        ? await this.errors.review(incidentId, actor.key)
        : op === 'resolve'
          ? await this.errors.resolve(incidentId, actor.key)
          : await this.errors.reopen(incidentId, actor.key);

    if (!updated) {
      await adapter.acknowledge(callbackId, 'ثبت این تغییر ممکن نشد.');
      return;
    }

    await adapter.acknowledge(
      callbackId,
      op === 'review'
        ? 'به‌عنوان بررسی‌شده ثبت شد.'
        : op === 'resolve'
          ? 'به‌عنوان رفع‌شده ثبت شد.'
          : 'بازگشایی شد.',
    );

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: op === 'resolve' ? 'INCIDENT_RESOLVED' : 'INCIDENT_REVIEWED',
      targetType: 'incident',
      targetRef: incidentId,
      result: 'OK',
      fromState: incident.status,
      toState: updated.status,
    });

    await this.renderIncident(adapter, user, incidentId, messageId);
  }

  /**
   * Retry, but only where repeating the operation is genuinely safe. There is no “retry everything”
   * (§10.5): an operation that cannot be repeated safely explains why instead of pretending.
   */
  private async retryIncident(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    incidentId: string,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const incident = this.errors.find(incidentId);

    if (!incident) {
      await adapter.acknowledge(callbackId, 'این رویداد پیدا نشد.');
      return;
    }

    if (!incident.retryable) {
      await adapter.acknowledge(
        callbackId,
        'این رویداد تلاش دوبارهٔ ایمن ندارد.',
      );
      return;
    }

    const result = await this.performRetry(incident.source, incident.reference);

    await adapter.acknowledge(
      callbackId,
      result.accepted ? 'تلاش دوباره آغاز شد.' : 'تلاش دوباره ممکن نشد.',
    );

    await this.errors.recordRetry(incidentId, {
      actor: actor.key,
      result: result.detail,
    });

    await this.audit.record({
      actor: actor.key,
      role: actor.role,
      action: 'INCIDENT_RETRIED',
      targetType: 'incident',
      targetRef: incidentId,
      result: result.accepted ? 'OK' : 'FAILED',
      reason: result.detail,
    });

    await this.renderIncident(adapter, user, incidentId, messageId);
  }

  private async performRetry(
    source: string,
    reference: string | null,
  ): Promise<{ accepted: boolean; detail: string }> {
    switch (source) {
      case 'channel-publisher': {
        if (!reference) {
          return { accepted: false, detail: 'ارجاع کار انتشار ثبت نشده است.' };
        }

        const job = this.engine.findJob(reference);

        if (!job) {
          return { accepted: false, detail: 'کار انتشار پیدا نشد.' };
        }

        const alreadySent = this.engine
          .deliveriesOf(job.id)
          .filter((delivery) => delivery.status === 'SENT');

        if (alreadySent.length > 0) {
          // Re-running would duplicate a message a destination already confirmed: refuse.
          return {
            accepted: false,
            detail:
              'یک مقصد این کار را قبلاً تأیید کرده است؛ برای جلوگیری از ارسال تکراری انجام نشد.',
          };
        }

        const outcome = await this.engine.execute(job.id, new Date());

        return {
          accepted:
            outcome.status === 'PUBLISHED' || outcome.status === 'PENDING',
          detail: `نتیجهٔ تلاش دوباره: ${outcome.status}${
            outcome.skipReason ? ` (${outcome.skipReason})` : ''
          }`,
        };
      }
      case 'alert-notification': {
        const recovered = await this.alertNotifications.recoverPending();

        return {
          accepted: true,
          detail: `اعلان‌های معلق بازگردانده‌شده: ${recovered}`,
        };
      }
      case 'sales-notification': {
        const recovered = await this.salesNotifications.recoverPending();

        return {
          accepted: true,
          detail: `اعلان‌های معلق بازگردانده‌شده: ${recovered}`,
        };
      }
      case 'broadcast':
        return {
          accepted: false,
          detail:
            'برای ارسال گروهی از صفحهٔ خودش «تلاش دوباره برای ناموفق‌ها» را بزنید.',
        };
      default:
        return { accepted: false, detail: 'این منبع تلاش دوبارهٔ ایمن ندارد.' };
    }
  }

  // --- broadcast ----------------------------------------------------------------

  private async renderBroadcastHub(
    adapter: PlatformAdapter,
    user: User,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const jobs = this.broadcast.list(5);
    const prepared = jobs.find((job) => job.status === 'PREPARED') ?? null;
    const last = jobs[0] ?? null;

    session.screen = 'broadcast';

    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastHubScreen({
        enabled: this.broadcast.enabled,
        jobs,
        activeCount: this.broadcast.activeJobs().length,
        maxRecipients: this.config.adminBroadcastMaxRecipients,
        batchSize: this.config.adminBroadcastBatchSize,
        maxAttempts: this.config.adminBroadcastMaxAttempts,
      }),
      keyboard: adminBroadcastKeyboard({
        enabled: this.broadcast.enabled,
        activeCount: this.broadcast.activeJobs().length,
        preparedReference: prepared?.reference ?? null,
        lastReference: last?.reference ?? null,
      }),
      editMessageId: messageId,
    });
  }

  private async chooseAudience(
    adapter: PlatformAdapter,
    user: User,
    action: Extract<AdminCallbackAction, { kind: 'admin-broadcast-audience' }>,
    session: AdminSession,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    if (!this.broadcast.enabled) {
      await adapter.acknowledge(
        callbackId,
        'ارسال گروهی در تنظیمات خاموش است.',
      );
      return;
    }

    const audience = audienceFrom(action);

    if (!audience) {
      await adapter.acknowledge(callbackId, 'این مخاطبان معتبر نیست.');
      return;
    }

    session.broadcastAudience = audience;
    session.broadcastText = null;
    session.screen = 'broadcast-audience';

    const preview = this.broadcast.resolveAudience(audience);

    await adapter.acknowledge(callbackId);
    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastAudienceScreen({
        audienceLabel: preview.label,
        estimate: preview.recipients.length,
        excluded: preview.excluded,
        limit: preview.limit,
        limitExceeded: preview.limitExceeded,
        consentNote:
          'این نسخه مدل رضایت/لغو اشتراک ندارد؛ شرط ارسال «هویت واقعی با گفت‌وگوی قابل‌ارسال» ' +
          'است، و هر هویتی که کنار گذاشته می‌شود با دلیلش شمرده می‌شود.',
      }),
      keyboard: adminBroadcastAudienceKeyboard(this.broadcast.enabled),
      editMessageId: messageId,
    });
  }

  private async renderBroadcastPreview(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    audience: BroadcastAudience | null,
    messageId?: number,
  ): Promise<void> {
    if (!audience) {
      await this.notice(
        adapter,
        user,
        'ابتدا مخاطبان را انتخاب کنید.',
        messageId,
      );
      return;
    }

    const preview = this.broadcast.resolveAudience(audience);

    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastPreviewScreen({
        textPreview: text,
        audienceLabel: preview.label,
        estimate: preview.recipients.length,
        maxLength: this.config.adminBroadcastMaxLength,
      }),
      keyboard: adminBroadcastPreviewKeyboard(),
      editMessageId: messageId,
    });
  }

  private async prepareBroadcast(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    session: AdminSession,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    if (!session.broadcastText || !session.broadcastAudience) {
      await adapter.acknowledge(callbackId, 'پیش‌نویسی موجود نیست.');
      return;
    }

    const result = await this.broadcast.prepare({
      actor,
      text: session.broadcastText,
      audience: session.broadcastAudience,
    });

    if (!result.ok) {
      await adapter.acknowledge(callbackId, result.message);
      return;
    }

    await adapter.acknowledge(callbackId, 'پیش‌نویس ثبت شد (هنوز ارسال نشده).');
    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastConfirmScreen(result.value),
      keyboard: adminBroadcastConfirmKeyboard(result.value.reference),
      editMessageId: messageId,
    });
  }

  private async startBroadcast(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    reference: string,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const confirmed = await this.broadcast.confirm(reference, actor);

    if (!confirmed.ok) {
      await adapter.acknowledge(callbackId, confirmed.message);
      return;
    }

    // The worker sends in bounded batches; the first batch is triggered here so the operator sees
    // progress immediately. The report never claims more than the platform accepted.
    const tick = await this.broadcast.processTick(new Date());

    await adapter.acknowledge(
      callbackId,
      `ارسال آغاز شد (پذیرفته‌شده تا این لحظه: ${tick.sent}).`,
    );

    await this.renderBroadcastReport(adapter, user, reference, messageId);
  }

  private async cancelBroadcast(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    reference: string,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const result = await this.broadcast.cancel(reference, actor);

    if (!result.ok) {
      await adapter.acknowledge(callbackId, result.message);
      return;
    }

    await adapter.acknowledge(
      callbackId,
      'لغو شد (ارسال‌شده‌ها قابل بازگشت نیستند).',
    );
    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastCancelledScreen(
        result.value.job,
        result.value.skipped,
      ),
      keyboard: adminBroadcastReportKeyboard(result.value.job.reference),
      editMessageId: messageId,
    });
  }

  private async retryBroadcast(
    adapter: PlatformAdapter,
    user: User,
    actor: AuditActor,
    reference: string,
    callbackId: string,
    messageId?: number,
  ): Promise<void> {
    const result = await this.broadcast.retry(reference, actor);

    if (!result.ok) {
      await adapter.acknowledge(callbackId, result.message);
      return;
    }

    const tick = await this.broadcast.processTick(new Date());

    await adapter.acknowledge(
      callbackId,
      `تلاش دوباره برای ${result.value.requeued} گیرنده؛ پذیرفته‌شده در این تیک: ${tick.sent}.`,
    );

    await this.renderBroadcastReport(adapter, user, reference, messageId);
  }

  private async renderBroadcastReport(
    adapter: PlatformAdapter,
    user: User,
    reference: string,
    messageId?: number,
  ): Promise<void> {
    const report = this.broadcast.report(reference);

    if (!report) {
      await this.notice(adapter, user, 'این ارسال گروهی پیدا نشد.', messageId);
      return;
    }

    await adapter.render({
      chatId: chatOf(user),
      text: formatBroadcastReportScreen({
        job: report.job,
        totals: report.totals,
        attempts: report.attempts,
        notes: report.notes,
      }),
      keyboard: adminBroadcastReportKeyboard(report.job.reference),
      editMessageId: messageId,
    });
  }

  // --- audit --------------------------------------------------------------------

  private async renderAudit(
    adapter: PlatformAdapter,
    user: User,
    session: AdminSession,
    messageId?: number,
  ): Promise<void> {
    const cap = this.config.adminMaxAuditRecords;
    const all = this.audit.list();
    const pageSize = this.config.adminPageSize;
    const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
    const page = Math.min(Math.max(1, session.page), pageCount);

    session.page = page;
    session.screen = 'audit';

    await adapter.render({
      chatId: chatOf(user),
      text: formatAuditScreen({
        rows: all.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageCount,
        total: all.length,
        capNote:
          cap > 0
            ? `سیاست نگه‌داشت: حداکثر ${num(cap)} رکورد (حذف از قدیمی‌ترین‌ها)`
            : 'سیاست نگه‌داشت: هیچ رکوردی خودکار حذف نمی‌شود.',
      }),
      keyboard: adminAuditKeyboard(page, pageCount),
      editMessageId: messageId,
    });
  }

  // --- shared helpers -----------------------------------------------------------

  private sessionOf(userId: string): AdminSession {
    const existing = this.sessions.get(userId);

    if (existing) {
      return existing;
    }

    const created: AdminSession = {
      screen: 'hub',
      page: 1,
      preset: 'today',
      customFrom: null,
      customTo: null,
      window: null,
      section: 0,
      ref: null,
      userFilter: 'all',
      userQuery: null,
      alertFilter: 'all',
      leadFilter: 'all',
      incidentFilter: 'open',
      broadcastAudience: null,
      broadcastText: null,
      pending: null,
    };

    this.sessions.set(userId, created);

    return created;
  }

  private async notice(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    messageId?: number,
  ): Promise<void> {
    await adapter.render({
      chatId: chatOf(user),
      text: `${text}\n\nبرای ادامه از پنل مدیریت استفاده کنید.`,
      keyboard: this.hubKeyboard(),
      editMessageId: messageId,
    });
  }

  private async renderExpiredInput(
    adapter: PlatformAdapter,
    user: User,
  ): Promise<void> {
    await adapter.render({
      chatId: chatOf(user),
      text: '⌛️ زمان این ورودی گذشته است. لطفاً از ابتدا شروع کنید.',
      keyboard: this.hubKeyboard(),
    });
  }
}

// --- module-level helpers -------------------------------------------------------

function chatOf(user: User): string {
  return user.chatId ?? user.platformUserId;
}

function countBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = keyOf(row);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function isWithin(
  window: ReportWindow,
  iso: string | null | undefined,
): boolean {
  if (!iso) {
    return false;
  }

  const at = Date.parse(iso);

  return (
    Number.isFinite(at) &&
    at >= Date.parse(window.from) &&
    at < Date.parse(window.to)
  );
}

function isOpenLead(status: LeadStatus): boolean {
  return status === 'NEW' || status === 'CONTACTED' || status === 'QUALIFIED';
}

function alertSummaryFa(alert: Alert): string {
  const amount = new Intl.NumberFormat('fa-IR');

  if (alert.type === 'PRICE_ABOVE') {
    return `${alert.symbol} بالاتر از ${amount.format(alert.targetPrice ?? 0)}`;
  }

  if (alert.type === 'PRICE_BELOW') {
    return `${alert.symbol} پایین‌تر از ${amount.format(alert.targetPrice ?? 0)}`;
  }

  return `${alert.symbol} ${alert.direction === 'DOWN' ? 'کاهش' : 'افزایش'} ${amount.format(
    alert.targetPercent ?? 0,
  )}٪`;
}

function userFilterLabel(filter: AdminUserFilterToken): string {
  switch (filter) {
    case 'bale':
      return 'فقط بله';
    case 'telegram':
      return 'فقط تلگرام';
    case 'new':
      return 'ثبت‌شده در ۳۰ روز اخیر';
    case 'inactive':
      return 'غیرفعال در ۳۰ روز اخیر';
    default:
      return 'همه';
  }
}

function alertFilterLabel(filter: AdminAlertFilterToken): string {
  switch (filter) {
    case 'active':
      return 'فعال';
    case 'disabled':
      return 'غیرفعال';
    case 'triggered':
      return 'فعال‌شده';
    case 'bale':
      return 'بله';
    case 'telegram':
      return 'تلگرام';
    default:
      return 'همه';
  }
}

function leadFilterLabel(filter: AdminLeadFilterToken): string {
  switch (filter) {
    case 'open':
      return 'باز';
    case 'converted':
      return 'مشتری';
    case 'lost':
      return 'از‌دست‌رفته';
    case 'today':
      return 'امروز';
    default:
      return 'همه';
  }
}

function incidentFilterLabel(filter: AdminIncidentFilterToken): string {
  switch (filter) {
    case 'reviewed':
      return 'بررسی‌شده';
    case 'resolved':
      return 'رفع‌شده';
    case 'retryable':
      return 'قابل تلاش دوباره';
    case 'retryable-open':
      return 'باز و قابل تلاش دوباره';
    case 'all':
      return 'همه';
    default:
      return 'باز';
  }
}

function matchesAlertFilter(
  alert: Alert,
  filter: AdminAlertFilterToken,
): boolean {
  switch (filter) {
    case 'active':
      return alert.status === 'ACTIVE';
    case 'disabled':
      return alert.status === 'DISABLED';
    case 'triggered':
      return alert.status === 'TRIGGERED';
    case 'bale':
      return alert.platform === 'bale';
    case 'telegram':
      return alert.platform === 'telegram';
    default:
      return true;
  }
}

function incidentQuery(filter: AdminIncidentFilterToken) {
  switch (filter) {
    case 'reviewed':
      return { status: 'REVIEWED' as const };
    case 'resolved':
      return { status: 'RESOLVED' as const };
    case 'retryable':
      return { retryable: true };
    case 'retryable-open':
      return { status: 'OPEN' as const, retryable: true };
    case 'all':
      return {};
    default:
      return { status: 'OPEN' as const };
  }
}

function leadQuery(filter: AdminLeadFilterToken, window: ReportWindow) {
  switch (filter) {
    case 'open':
      return { status: 'NEW' as LeadStatus };
    case 'converted':
      return { status: 'CONVERTED' as LeadStatus };
    case 'lost':
      return { status: 'LOST' as LeadStatus };
    case 'today':
      return { from: new Date(window.from), to: new Date(window.to) };
    default:
      return {};
  }
}

function metricValue(
  metrics: { key: string; value: number | null }[],
  key: string,
): number {
  return metrics.find((row) => row.key === key)?.value ?? 0;
}

function latestFailures(
  sorted: {
    platform: string;
    destination: string;
    status: string;
    lastError: string | null;
    lastAttemptAt: string | null;
    createdAt: string;
  }[],
): { destination: string; error: string; at: string | null }[] {
  const seen = new Set<string>();
  const failures: { destination: string; error: string; at: string | null }[] =
    [];

  for (const delivery of sorted) {
    if (delivery.status !== 'FAILED' && delivery.status !== 'UNKNOWN') {
      continue;
    }

    const key = `${delivery.platform}:${delivery.destination}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    failures.push({
      destination: key,
      error: delivery.lastError ?? 'بدون پیام خطا',
      at: delivery.lastAttemptAt ?? delivery.createdAt,
    });
  }

  return failures.slice(0, 5);
}

function audienceFrom(
  action: Extract<AdminCallbackAction, { kind: 'admin-broadcast-audience' }>,
): BroadcastAudience | null {
  switch (action.audience) {
    case 'all':
      return { kind: 'ALL', platform: null, days: null };
    case 'bale':
      return { kind: 'PLATFORM', platform: 'bale', days: null };
    case 'telegram':
      return { kind: 'PLATFORM', platform: 'telegram', days: null };
    case 'active':
      return {
        kind: 'ACTIVE_LAST_DAYS',
        platform: null,
        days: action.days ?? 30,
      };
    case 'inactive':
      return {
        kind: 'INACTIVE_LAST_DAYS',
        platform: null,
        days: action.days ?? 30,
      };
    default:
      return null;
  }
}

/** The documented funnel stages, each mapped to the Phase 8 metric that owns it (§9). */
const FUNNEL_STAGES: { metricKey: string; labelFa: string }[] = [
  { metricKey: 'impressions', labelFa: 'نمایش (impression)' },
  { metricKey: 'clicksRaw', labelFa: 'کلیک خام' },
  { metricKey: 'uniqueClickers', labelFa: 'کلیک‌کنندهٔ یکتا (انسانی)' },
  { metricKey: 'newStarts', labelFa: 'شروع تازه (start)' },
  { metricKey: 'verifiedJoins', labelFa: 'عضویت تأییدشدهٔ کانال' },
  { metricKey: 'totalAlerts', labelFa: 'ساخت هشدار' },
  { metricKey: 'leads', labelFa: 'سرنخ' },
  { metricKey: 'customers', labelFa: 'مشتری' },
];

function capabilityFor(action: AdminCallbackAction): AdminCapability | null {
  switch (action.kind) {
    case 'admin-hub':
    case 'admin-dict':
      return 'manage';
    // The audit trail is a separate capability and stays with the owner (§12.2): an operator who can
    // open the panel cannot read — or infer — the actions of the other administrators.
    case 'admin-audit':
      return 'audit';
    case 'admin-stats':
    case 'admin-stats-custom':
      return 'stats';
    case 'admin-users':
    case 'admin-user':
    case 'admin-user-search':
      return 'users';
    case 'admin-channels':
    case 'admin-channel-history':
    case 'admin-publishing':
    case 'admin-test-message':
      return 'channels';
    case 'admin-alerts':
    case 'admin-alert':
    case 'admin-alert-state':
      return 'alerts';
    case 'admin-leads':
      return 'leads';
    case 'admin-campaigns':
    case 'admin-campaign-funnel':
      return 'campaigns';
    case 'admin-errors':
    case 'admin-error':
    case 'admin-error-act':
    case 'admin-error-retry':
      return 'errors';
    case 'admin-broadcast':
    case 'admin-broadcast-list':
    case 'admin-broadcast-audience':
    case 'admin-broadcast-text':
    case 'admin-broadcast-preview':
      return 'broadcast';
    // Preparing, starting, cancelling and retrying a broadcast need the owner role (§12.3).
    case 'admin-broadcast-save':
    case 'admin-broadcast-start':
    case 'admin-broadcast-cancel':
    case 'admin-broadcast-retry':
    case 'admin-broadcast-report':
      return 'broadcast.send';
    default:
      return null;
  }
}

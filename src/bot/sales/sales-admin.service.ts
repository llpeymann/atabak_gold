import { Injectable, Logger } from '@nestjs/common';

import { escapeHtml } from '../../common/html';
import { describeError } from '../../common/log-safety';
import { formatNumberFa, MoneyUnit } from '../../common/money';
import { AppConfigService } from '../../config/app-config.service';
import { Keyboard, Platform } from '../../platform/platform.types';
import { PlatformAdapter } from '../../platform/platform-adapter';
import { User } from '../../users/user.types';
import { tehranWallClockToIso } from '../content/content-admin.service';
import { SalesNotificationService } from '../../sales/sales-notification.service';
import { SalesService } from '../../sales/sales.service';
import { formatPhoneFa } from '../../sales/phone';
import {
  categoryLabelFa,
  formatAmountFa,
  leadTimestampFa,
  LOSS_REASON_LABELS_FA,
  platformLabelFa,
  STATUS_LABELS_FA,
} from '../../sales/sales-format';
import {
  isLossReason,
  isProductCategory,
  LeadRecord,
  LEAD_STATUSES,
  LeadStatus,
  LOSS_REASONS,
  SalesResult,
} from '../../sales/sales.types';
import { LeadQuery } from '../../sales/sales.service';
import { SalesCallbackAction } from '../ux/callback-data';
import {
  salesAdminAssignKeyboard,
  salesAdminConvertConfirmKeyboard,
  salesAdminHistoryKeyboard,
  salesAdminLeadKeyboard,
  salesAdminListKeyboard,
  salesAdminListOnlyKeyboard,
  salesAdminLossKeyboard,
} from './sales-keyboards';

/**
 * Phase 9 — the lead management surface, inside the existing bot (§10).
 *
 * Same shape as the Phase 5/8 admin surfaces: text commands plus buttons, a hard page size, and a
 * server-side authorization re-check on *every* command and *every* press. A non-admin never learns
 * that the surface exists: the router then shows them the ordinary menu.
 *
 * The surface reports exactly what is stored: a failed transition is shown as its reason, a missing
 * amount is shown as `مبلغ ثبت نشده` (never as `0`), and every mutation is persisted before the
 * operator is told that it worked.
 */

const PAGE_SIZE = 5;
const MAX_ADMIN_TARGETS = 8;
const SETUP_TTL_MS = 15 * 60_000;

export interface ParsedSalesCommand {
  action:
    | 'help'
    | 'list'
    | 'find'
    | 'filter'
    | 'show'
    | 'contact'
    | 'note'
    | 'assign'
    | 'status'
    | 'lost'
    | 'convert'
    | 'sale'
    | 'history'
    | 'stats'
    | 'retry'
    | 'invalid';
  reference?: string;
  query?: string;
  note?: string;
  status?: string;
  reason?: string;
  assignee?: string;
  amount?: string;
  currency?: string;
  page?: number;
  filters?: {
    status?: string;
    category?: string;
    campaignId?: string;
    from?: string;
    to?: string;
  };
  clearFilters?: boolean;
}

interface PendingInput {
  kind: 'note' | 'sale' | 'contact-note';
  reference: string;
  startedAt: number;
}

@Injectable()
export class SalesAdminService {
  private readonly logger = new Logger(SalesAdminService.name);
  /** Operator-side “next message is the input” state, in memory and per user. */
  private readonly pending = new Map<string, PendingInput>();
  /** Filters are per operator and in memory: losing them on restart only means “show everything”. */
  private readonly filters = new Map<string, ParsedSalesCommand['filters']>();

  constructor(
    private readonly config: AppConfigService,
    private readonly sales: SalesService,
    private readonly notifications: SalesNotificationService,
  ) {}

  /** `true` when the surface must explain that the engine itself is switched off. */
  get engineEnabled(): boolean {
    return this.config.salesEnabled && this.sales.enabled;
  }

  /** The surface needs the engine to be on *and* at least one configured administrator (§16). */
  get enabled(): boolean {
    return this.sales.enabled && this.sales.adminIds.length > 0;
  }

  isAdmin(platform: Platform, platformUserId: string): boolean {
    return this.sales.isSalesAdmin(platform, platformUserId);
  }

  owns(text: string): boolean {
    return text.trimStart().toLowerCase().startsWith('/sales');
  }

  /**
   * Drop a pending note/sale request. Called by the router when the operator sends a command, so a
   * pending question can never swallow a later, unrelated message as note text (§10.3).
   */
  clearPending(userId: string): void {
    this.pending.delete(userId);
  }

  /** `true` while the operator is expected to send the text of a note / sale (§10.3). */
  hasPendingInput(userId: string): boolean {
    const input = this.pending.get(userId);

    if (!input) {
      return false;
    }

    if (Date.now() - input.startedAt > SETUP_TTL_MS) {
      this.pending.delete(userId);
      return false;
    }

    return true;
  }

  // --- text commands ----------------------------------------------------------------------------

  /** Handle a `/sales …` command. Returns `false` when the sender is not an administrator. */
  async handleCommand(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      this.logger.warn(
        `Non-admin (${adapter.platform}) tried the sales surface.`,
      );
      return false;
    }

    this.pending.delete(user.id);

    if (!this.sales.enabled) {
      await this.send(
        adapter,
        user,
        `⚠️ موتور فروش فعال نیست.\n${this.sales.disabledReason ?? ''}`.trim(),
        salesAdminListOnlyKeyboard(),
      );
      return true;
    }

    const parsed = parseSalesCommand(text);

    switch (parsed.action) {
      case 'help':
        await this.send(
          adapter,
          user,
          this.helpText(),
          salesAdminListOnlyKeyboard(),
        );
        return true;
      case 'invalid':
        await this.send(
          adapter,
          user,
          this.helpText('⚠️ دستور نامعتبر است.'),
          salesAdminListOnlyKeyboard(),
        );
        return true;
      case 'list':
        await this.renderList(adapter, user, parsed.page ?? 1);
        return true;
      case 'find':
        await this.renderList(adapter, user, 1, parsed.query ?? null);
        return true;
      case 'filter': {
        if (parsed.clearFilters) {
          this.filters.delete(user.id);
        } else {
          this.filters.set(user.id, {
            ...this.filters.get(user.id),
            ...parsed.filters,
          });
        }

        await this.renderList(adapter, user, 1);
        return true;
      }
      case 'show':
        await this.renderLead(adapter, user, parsed.reference ?? '', null);
        return true;
      case 'history':
        await this.renderHistory(adapter, user, parsed.reference ?? '', null);
        return true;
      case 'stats':
        await this.renderStats(adapter, user);
        return true;
      case 'retry':
        await this.retryIntegrations(adapter, user);
        return true;
      case 'contact':
        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.logContact(
              reference,
              this.actor(adapter, user),
              parsed.note ?? null,
            ),
        );
        return true;
      case 'note':
        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.addNote(
              reference,
              this.actor(adapter, user),
              parsed.note ?? '',
            ),
        );
        return true;
      case 'assign':
        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.assign(
              reference,
              parsed.assignee === undefined || parsed.assignee === 'none'
                ? null
                : parsed.assignee,
              this.actor(adapter, user),
            ),
        );
        return true;
      case 'status': {
        const status = parsed.status;

        if (status === undefined || !isLeadStatus(status)) {
          await this.send(
            adapter,
            user,
            '⚠️ وضعیت مقصد معتبر نیست. مقادیر مجاز: NEW، CONTACTED، QUALIFIED.',
            salesAdminListOnlyKeyboard(),
          );
          return true;
        }

        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.changeStatus(
              reference,
              status,
              this.actor(adapter, user),
            ),
        );
        return true;
      }
      case 'lost': {
        const reason = parsed.reason;

        if (reason === undefined || !isLossReason(reason)) {
          await this.send(
            adapter,
            user,
            '⚠️ دلیل از دست رفتن معتبر نیست. دلیل‌های مجاز: ' +
              LOSS_REASONS.join('، '),
            salesAdminListOnlyKeyboard(),
          );
          return true;
        }

        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.markLost(
              reference,
              this.actor(adapter, user),
              reason,
              parsed.note ?? null,
            ),
        );
        return true;
      }
      case 'convert':
        await this.mutate(
          adapter,
          user,
          null,
          parsed.reference ?? '',
          (reference) =>
            this.sales.convertToCustomer(reference, this.actor(adapter, user)),
        );
        return true;
      case 'sale':
        await this.recordSaleFromCommand(adapter, user, parsed);
        return true;
      default:
        await this.send(
          adapter,
          user,
          this.helpText('⚠️ دستور نامعتبر است.'),
          salesAdminListOnlyKeyboard(),
        );
        return true;
    }
  }

  /** Consume the operator's follow-up message (a note text, or a sale amount). */
  async consumeInput(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    const input = this.pending.get(user.id);

    if (!input) {
      return false;
    }

    if (Date.now() - input.startedAt > SETUP_TTL_MS) {
      this.pending.delete(user.id);
      return false;
    }

    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      // The pending state never survives losing authorization.
      this.pending.delete(user.id);
      return false;
    }

    this.pending.delete(user.id);

    if (input.kind === 'note') {
      const result = await this.sales.addNote(
        input.reference,
        this.actor(adapter, user),
        text,
      );

      await this.sendResult(adapter, user, result);
      return true;
    }

    if (input.kind === 'contact-note') {
      const result = await this.sales.logContact(
        input.reference,
        this.actor(adapter, user),
        text,
      );

      await this.sendResult(adapter, user, result);
      return true;
    }

    const sale = parseSaleInput(text);

    if (!sale.ok) {
      await this.send(
        adapter,
        user,
        [
          `⚠️ ${sale.message}`,
          '',
          'برای ثبت فروش، مبلغ و واحد پول را بفرستید. مثال:',
          '<code>120000000 TOMAN</code> — یا برای ثبت بدون مبلغ: <code>-</code>',
        ].join('\n'),
        salesAdminListOnlyKeyboard(),
      );
      return true;
    }

    const result = await this.sales.recordSale(
      input.reference,
      this.actor(adapter, user),
      { amount: sale.amount, currency: sale.currency, note: null },
    );

    await this.sendResult(adapter, user, result);
    return true;
  }

  // --- buttons ----------------------------------------------------------------------------------

  /**
   * Handle one admin-side sales button. Authorization is re-checked here (not taken from the
   * payload), every transition is re-validated by the domain layer, and the lead is re-read from the
   * store before the answer — the screen never shows a state that is not persisted.
   */
  async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
    action: SalesCallbackAction,
  ): Promise<void> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      this.logger.warn(
        `Non-admin (${adapter.platform}) pressed a sales admin button.`,
      );
      await adapter.acknowledge(callbackId, 'دسترسی ندارید');
      return;
    }

    this.pending.delete(user.id);

    switch (action.kind) {
      case 'sales-list':
        await adapter.acknowledge(callbackId);
        await this.renderList(
          adapter,
          user,
          action.page,
          undefined,
          messageId ?? undefined,
        );
        return;
      case 'sales-lead-view':
        await adapter.acknowledge(callbackId);
        await this.renderLead(adapter, user, action.leadId, messageId ?? null);
        return;
      case 'sales-lead-history':
        await adapter.acknowledge(callbackId);
        await this.renderHistory(
          adapter,
          user,
          action.leadId,
          messageId ?? null,
        );
        return;
      case 'sales-lead-loss-menu': {
        const lead = this.sales.findLead(action.leadId);

        if (!lead) {
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          `❌ دلیل از دست رفتن درخواست <code>${escapeHtml(lead.reference)}</code> را انتخاب کنید:`,
          salesAdminLossKeyboard(lead.leadId),
          messageId,
        );
        return;
      }
      case 'sales-lead-status': {
        const result = await this.sales.changeStatus(
          action.leadId,
          action.status,
          this.actor(adapter, user),
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '✅ ثبت شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      case 'sales-lead-lost': {
        const result = await this.sales.markLost(
          action.leadId,
          this.actor(adapter, user),
          action.reason,
          null,
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '✅ ثبت شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      case 'sales-lead-convert': {
        const lead = this.sales.findLead(action.leadId);

        if (!lead) {
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          [
            '✅ <b>تبدیل به مشتری</b>',
            '',
            `درخواست <code>${escapeHtml(lead.reference)}</code> به‌عنوان <b>مشتری</b> ثبت می‌شود.`,
            'این کار یک رویداد تبدیل در فاز ۸ (کمپین) هم ایجاد می‌کند و در تاریخچهٔ درخواست می‌ماند.',
            '',
            'آیا مطمئن هستید؟',
          ].join('\n'),
          salesAdminConvertConfirmKeyboard(lead.leadId),
          messageId,
        );
        return;
      }
      case 'sales-lead-convert-confirm': {
        const result = await this.sales.convertToCustomer(
          action.leadId,
          this.actor(adapter, user),
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '✅ مشتری ثبت شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      case 'sales-lead-sale': {
        const lead = this.sales.findLead(action.leadId);

        if (!lead) {
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        this.pending.set(user.id, {
          kind: 'sale',
          reference: lead.leadId,
          startedAt: Date.now(),
        });
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          [
            `🛒 ثبت فروش برای <code>${escapeHtml(lead.reference)}</code>`,
            '',
            'مبلغ فروش و واحد پول را در یک پیام بفرستید:',
            '<code>120000000 TOMAN</code>',
            '',
            'اگر مبلغ دقیق را ندارید، فقط <code>-</code> بفرستید؛ مبلغ صفر ثبت نمی‌شود.',
          ].join('\n'),
          salesAdminListOnlyKeyboard(),
          messageId,
        );
        return;
      }
      case 'sales-lead-sale-note': {
        const result = await this.sales.recordSale(
          action.leadId,
          this.actor(adapter, user),
          { amount: null, currency: null, note: null },
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '✅ فروش ثبت شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      case 'sales-lead-contact': {
        const result = await this.sales.logContact(
          action.leadId,
          this.actor(adapter, user),
          null,
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '📞 ثبت شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      case 'sales-lead-note': {
        const lead = this.sales.findLead(action.leadId);

        if (!lead) {
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        this.pending.set(user.id, {
          kind: 'note',
          reference: lead.leadId,
          startedAt: Date.now(),
        });
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          `🗒 یادداشت خود را برای <code>${escapeHtml(lead.reference)}</code> در یک پیام بفرستید:`,
          salesAdminListOnlyKeyboard(),
          messageId,
        );
        return;
      }
      case 'sales-lead-assign': {
        const lead = this.sales.findLead(action.leadId);

        if (!lead) {
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        const targets = this.sales.adminIds.slice(0, MAX_ADMIN_TARGETS);

        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          `👤 واگذاری درخواست <code>${escapeHtml(lead.reference)}</code> به کدام کارشناس؟`,
          salesAdminAssignKeyboard(lead.leadId, targets),
          messageId,
        );
        return;
      }
      case 'sales-lead-assign-to': {
        const targets = this.sales.adminIds.slice(0, MAX_ADMIN_TARGETS);
        const assignee = targets[action.index];

        if (assignee === undefined) {
          await adapter.acknowledge(callbackId, 'گزینهٔ نامعتبر');
          await this.answerMissing(adapter, user, callbackId, messageId);
          return;
        }

        const result = await this.sales.assign(
          action.leadId,
          assignee,
          this.actor(adapter, user),
        );

        await adapter.acknowledge(
          callbackId,
          result.ok ? '✅ واگذار شد' : '❌ انجام نشد',
        );
        await this.sendResult(adapter, user, result, messageId ?? undefined);
        return;
      }
      default:
        await adapter.acknowledge(callbackId, 'این گزینه در دسترس نیست');
    }
  }

  // --- screens ----------------------------------------------------------------------------------

  private filterOf(userId: string): ParsedSalesCommand['filters'] {
    return this.filters.get(userId);
  }

  private async renderList(
    adapter: PlatformAdapter,
    user: User,
    page: number,
    query?: string | null,
    messageId?: number,
  ): Promise<void> {
    const filters = this.filterOf(user.id);
    const built = this.buildQuery(filters, query ?? null);
    const total = this.sales.countLeads(built.query);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const rows = this.sales.listLeads({
      ...built.query,
      limit: PAGE_SIZE,
      offset: (current - 1) * PAGE_SIZE,
    });
    const lines = ['🧾 <b>درخواست‌های استعلام</b>', ''];

    if (built.warnings.length > 0) {
      lines.push(...built.warnings.map((warning) => `⚠️ ${warning}`), '');
    }

    lines.push(
      `📊 مجموع: ${formatNumberFa(total)} درخواست` +
        (query ? ` · جست‌وجو: <code>${escapeHtml(query)}</code>` : ''),
      '',
    );

    if (rows.length === 0) {
      lines.push('درخواستی با این شرایط پیدا نشد.');
    }

    rows.forEach((lead, index) => {
      lines.push(
        `${formatNumberFa((current - 1) * PAGE_SIZE + index + 1)}. <code>${escapeHtml(lead.reference)}</code> · ${escapeHtml(STATUS_LABELS_FA[lead.status])}`,
      );
      lines.push(
        `   👤 ${escapeHtml(lead.customerName)} · ${escapeHtml(categoryLabelFa(lead.category))} · 📣 ${escapeHtml(lead.campaignName ?? 'نامشخص')}`,
      );
      lines.push(`   🕒 ${escapeHtml(leadTimestampFa(lead.createdAt))}`);
    });

    lines.push(
      '',
      `صفحه ${formatNumberFa(current)} از ${formatNumberFa(pages)}`,
    );
    lines.push(
      '',
      'برای جزئیات، دکمهٔ هر درخواست را بزنید. راهنما: /sales help',
    );

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      salesAdminListKeyboard(rows, current, pages),
      messageId,
    );
  }

  private async renderLead(
    adapter: PlatformAdapter,
    user: User,
    referenceOrId: string,
    messageId: number | null,
  ): Promise<void> {
    const lead = this.sales.findLead(referenceOrId);

    if (!lead) {
      await this.send(
        adapter,
        user,
        '⚠️ درخواستی با این شناسه یا کد پیگیری پیدا نشد.',
        salesAdminListOnlyKeyboard(),
        messageId ?? undefined,
      );
      return;
    }

    const outcome = this.sales.activeOutcome(lead.leadId);
    const lines = [
      `🧾 <b>درخواست ${escapeHtml(lead.reference)}</b>`,
      '',
      `📌 وضعیت: ${escapeHtml(STATUS_LABELS_FA[lead.status])}`,
      `👤 نام: ${escapeHtml(lead.customerName)}`,
      `📱 تماس: ${escapeHtml(formatPhoneFa(lead.phone))}`,
      `🏷 دسته: ${escapeHtml(categoryLabelFa(lead.category))}`,
      `📝 محصول: ${lead.productDescription ? escapeHtml(lead.productDescription) : 'توضیحی ثبت نشده'}`,
      `🗒 یادداشت: ${lead.notes ? escapeHtml(lead.notes) : 'ندارد'}`,
      `🌐 سکو: ${escapeHtml(platformLabelFa(lead.platform))}`,
      `📣 کمپین: ${escapeHtml(this.campaignLine(lead))}`,
      `👤 کارشناس: ${lead.assignedTo ? `<code>${escapeHtml(lead.assignedTo)}</code>` : 'واگذار نشده'}`,
      `📞 تلاش‌های تماس: ${formatNumberFa(lead.contactAttempts)}` +
        (lead.lastContactAt
          ? ` · آخرین: ${escapeHtml(leadTimestampFa(lead.lastContactAt))}`
          : ''),
      `🕒 ثبت: ${escapeHtml(leadTimestampFa(lead.createdAt))}`,
    ];

    if (lead.status === 'LOST') {
      lines.push(
        `❌ دلیل از دست رفتن: ${escapeHtml(
          lead.lossReason ? LOSS_REASON_LABELS_FA[lead.lossReason] : 'نامشخص',
        )}`,
      );
    }

    if (lead.customerConvertedAt) {
      lines.push(
        `✅ مشتری‌شده: ${escapeHtml(leadTimestampFa(lead.customerConvertedAt))}`,
      );
    }

    if (outcome) {
      lines.push(
        `🛒 فروش ثبت‌شده: ${escapeHtml(formatAmountFa(outcome))} · ${escapeHtml(leadTimestampFa(outcome.recordedAt))}`,
      );
    }

    lines.push('', `🔗 فاز ۸: ${escapeHtml(this.phase8Line(lead))}`);

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      salesAdminLeadKeyboard(lead),
      messageId ?? undefined,
    );
  }

  private async renderHistory(
    adapter: PlatformAdapter,
    user: User,
    referenceOrId: string,
    messageId: number | null,
  ): Promise<void> {
    const lead = this.sales.findLead(referenceOrId);

    if (!lead) {
      await this.send(
        adapter,
        user,
        '⚠️ درخواستی با این شناسه پیدا نشد.',
        salesAdminListOnlyKeyboard(),
        messageId ?? undefined,
      );
      return;
    }

    const activities = this.sales.listActivities(lead.leadId);
    const lines = [
      `🕘 <b>تاریخچهٔ درخواست ${escapeHtml(lead.reference)}</b>`,
      '',
    ];

    if (activities.length === 0) {
      lines.push('تاریخچه‌ای ثبت نشده است.');
    }

    for (const activity of activities.slice(-20)) {
      lines.push(
        `• ${escapeHtml(leadTimestampFa(activity.at))} — ${escapeHtml(activity.summary)} ` +
          `(<code>${escapeHtml(activity.actor)}</code>)`,
      );
    }

    if (activities.length > 20) {
      lines.push(
        '',
        `ℹ️ ${formatNumberFa(activities.length - 20)} رویداد قدیمی‌تر نمایش داده نشده است.`,
      );
    }

    const outcomes = this.sales.listOutcomes(lead.leadId);

    if (outcomes.length > 0) {
      lines.push('', '🛒 <b>نتیجه‌های فروش</b>');

      for (const outcome of outcomes) {
        lines.push(
          `• ${outcome.status === 'ACTIVE' ? 'فعال' : 'اصلاح‌شده'} — ${escapeHtml(formatAmountFa(outcome))} · ` +
            `${escapeHtml(leadTimestampFa(outcome.recordedAt))}` +
            (outcome.note ? ` · ${escapeHtml(outcome.note)}` : ''),
        );
      }
    }

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      salesAdminHistoryKeyboard(lead.leadId),
      messageId ?? undefined,
    );
  }

  private async renderStats(
    adapter: PlatformAdapter,
    user: User,
  ): Promise<void> {
    const counts = this.sales.countByStatus();
    const outcomes = this.sales.listAllOutcomes();
    const lines = [
      '📊 <b>گزارش موتور فروش</b>',
      '',
      `🆕 جدید: ${formatNumberFa(counts.NEW)}`,
      `📞 تماس گرفته‌شده: ${formatNumberFa(counts.CONTACTED)}`,
      `🔍 بررسی‌شده: ${formatNumberFa(counts.QUALIFIED)}`,
      `✅ مشتری‌شده: ${formatNumberFa(counts.CONVERTED)}`,
      `❌ از دست رفته: ${formatNumberFa(counts.LOST)}`,
      '',
      `🛒 فروش ثبت‌شده (ردیف فعال): ${formatNumberFa(outcomes.length)}`,
    ];

    // Amounts are never mixed: each currency is reported on its own line (§14.2).
    const totals = new Map<string, number>();

    for (const outcome of outcomes) {
      if (outcome.amount === null || outcome.currency === null) {
        continue;
      }

      totals.set(
        outcome.currency,
        (totals.get(outcome.currency) ?? 0) + outcome.amount,
      );
    }

    if (totals.size === 0) {
      lines.push('💵 مبلغ تأییدشده‌ای ثبت نشده است.');
    } else {
      for (const [currency, total] of totals) {
        lines.push(
          `💵 جمع ${escapeHtml(currency)}: ${escapeHtml(total.toLocaleString('en-US'))}`,
        );
      }
    }

    lines.push('', '📣 <b>سرنخ‌ها بر پایهٔ کمپین</b>');

    const byCampaign = this.sales.countsByCampaignLabel().slice(0, 5);

    if (byCampaign.length === 0) {
      lines.push('هنوز سرنخی ثبت نشده است.');
    }

    for (const bucket of byCampaign) {
      lines.push(
        `• ${escapeHtml(bucket.campaignName ?? bucket.campaignId ?? 'بدون انتساب')} — ${formatNumberFa(bucket.count)}`,
      );
    }

    const notifications = this.notifications
      .listNotifications()
      .reduce<Record<string, number>>((accumulator, record) => {
        accumulator[record.status] = (accumulator[record.status] ?? 0) + 1;
        return accumulator;
      }, {});

    lines.push(
      '',
      '📨 <b>وضعیت اطلاع‌رسانی</b>',
      `• در انتظار: ${formatNumberFa(notifications.PENDING ?? 0)} · ارسال‌شده: ${formatNumberFa(notifications.SENT ?? 0)} · ناموفق: ${formatNumberFa(notifications.UNDELIVERABLE ?? 0)}`,
      '',
      'ℹ️ سرنخ = درخواست ثبت‌شده · مشتری = تبدیل تأییدشدهٔ کارشناس · فروش = رکورد فروش ثبت‌شده.',
      'شناسه‌های یک پلتفرم با پلتفرم دیگر ادغام نمی‌شوند؛ اعداد هر سکو جدا شمرده می‌شوند.',
    );

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      salesAdminListOnlyKeyboard(),
    );
  }

  private async retryIntegrations(
    adapter: PlatformAdapter,
    user: User,
  ): Promise<void> {
    const repaired = await this.sales.repairPendingIntegrations();

    const pending = this.notifications
      .listNotifications()
      .filter((record) => record.status === 'PENDING');

    for (const record of pending) {
      this.notifications.dispatch(record);
    }

    await this.send(
      adapter,
      user,
      [
        '🔁 <b>تلاش دوباره</b>',
        '',
        `• پیوندهای فاز ۸ بازبینی‌شده: ${formatNumberFa(repaired.checked)}`,
        `• پیوندهای بازمانده که اکنون ثبت شدند: ${formatNumberFa(repaired.recorded)}`,
        `• همچنان ناموفق: ${formatNumberFa(repaired.failed)}`,
        `• اطلاع‌رسانی‌های در انتظار: ${formatNumberFa(pending.length)}`,
        '',
        'هیچ درخواستی حذف یا بازنویسی نشد؛ فقط وضعیت‌های ثبت‌نشده دوباره تلاش می‌شوند.',
      ].join('\n'),
      salesAdminListOnlyKeyboard(),
    );
  }

  // --- internals --------------------------------------------------------------------------------

  private async recordSaleFromCommand(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedSalesCommand,
  ): Promise<void> {
    const reference = parsed.reference ?? '';

    if (parsed.amount === undefined || parsed.amount === '-') {
      const result = await this.sales.recordSale(
        reference,
        this.actor(adapter, user),
        {
          amount: null,
          currency: null,
          note: parsed.note ?? null,
        },
      );

      await this.sendResult(adapter, user, result);
      return;
    }

    const sale = parseSaleInput(
      `${parsed.amount} ${parsed.currency ?? ''}`.trim(),
    );

    if (!sale.ok) {
      await this.send(
        adapter,
        user,
        `⚠️ ${sale.message}`,
        salesAdminListOnlyKeyboard(),
      );
      return;
    }

    const result = await this.sales.recordSale(
      reference,
      this.actor(adapter, user),
      {
        amount: sale.amount,
        currency: sale.currency,
        note: parsed.note ?? null,
      },
    );

    await this.sendResult(adapter, user, result);
  }

  /** Run one authorized mutation and report the *stored* result (never an optimistic message). */
  private async mutate(
    adapter: PlatformAdapter,
    user: User,
    messageId: number | null,
    reference: string,
    operation: (reference: string) => Promise<SalesResult<LeadRecord>>,
  ): Promise<void> {
    const result = await operation(reference);

    await this.sendResult(adapter, user, result, messageId ?? undefined);
  }

  private async sendResult<T extends { leadId: string }>(
    adapter: PlatformAdapter,
    user: User,
    result: SalesResult<T>,
    messageId?: number,
  ): Promise<void> {
    if (!result.ok) {
      // The reason comes from the domain layer and is shown as-is: a refused transition is not a
      // crash and must not look like one.
      await this.send(
        adapter,
        user,
        `⚠️ ${escapeHtml(result.message)}`,
        salesAdminListOnlyKeyboard(),
        messageId,
      );
      return;
    }

    await this.renderLead(
      adapter,
      user,
      result.value.leadId,
      messageId ?? null,
    );
  }

  private async answerMissing(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
  ): Promise<void> {
    await adapter.acknowledge(callbackId, 'پیدا نشد');
    await this.send(
      adapter,
      user,
      '⚠️ درخواست پیدا نشد (ممکن است حذف یا بازنشانی شده باشد).',
      salesAdminListOnlyKeyboard(),
      messageId,
    );
  }

  private campaignLine(lead: LeadRecord): string {
    if (!lead.campaignId) {
      return `نامشخص (${lead.attributionReason})`;
    }

    return `${lead.campaignName ?? lead.campaignId} (${lead.attributionModel ?? '-'})`;
  }

  /** Phase 8 state of the lead, reported as a fact instead of a promise (§12.2). */
  private phase8Line(lead: LeadRecord): string {
    const parts = [
      `سرنخ: ${lead.phase8.status}${lead.phase8.conversionId ? ` (${lead.phase8.conversionId})` : ''}`,
    ];

    if (lead.phase8Customer) {
      parts.push(
        `مشتری: ${lead.phase8Customer.status}${lead.phase8Customer.conversionId ? ` (${lead.phase8Customer.conversionId})` : ''}`,
      );
    }

    return parts.join(' · ');
  }

  private buildQuery(
    filters: ParsedSalesCommand['filters'],
    query: string | null,
  ): { query: LeadQuery; warnings: string[] } {
    const warnings: string[] = [];
    const status = filters?.status ? filters.status.toUpperCase() : undefined;
    const category = filters?.category
      ? filters.category.toUpperCase()
      : undefined;
    const from = filters?.from
      ? this.parseFilterDate(filters.from, false)
      : null;
    const to = filters?.to ? this.parseFilterDate(filters.to, true) : null;
    const validStatus = status !== undefined && isLeadStatus(status);
    const validCategory = category !== undefined && isProductCategory(category);

    if (filters?.status && !validStatus) {
      warnings.push(`وضعیت «${filters.status}» شناخته نشد و نادیده گرفته شد.`);
    }

    if (filters?.category && !validCategory) {
      warnings.push(
        `دستهٔ «${filters.category}» شناخته نشد و نادیده گرفته شد.`,
      );
    }

    if (filters?.campaignId && !/^cmp_\d{1,10}$/.test(filters.campaignId)) {
      warnings.push('شناسهٔ کمپین معتبر نبود و نادیده گرفته شد.');
    }

    return {
      query: {
        query,
        status: validStatus ? status : null,
        category: validCategory ? category : null,
        campaignId:
          filters?.campaignId && /^cmp_\d{1,10}$/.test(filters.campaignId)
            ? filters.campaignId
            : null,
        from: from ? new Date(from) : null,
        to: to ? new Date(to) : null,
        limit: PAGE_SIZE,
      },
      warnings,
    };
  }

  /** `YYYY-MM-DD` in **Tehran** wall-clock, converted with the existing helper (no host TZ, §14.1). */
  private parseFilterDate(value: string, endOfDay: boolean): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      return null;
    }

    return tehranWallClockToIso(
      `${value.trim()} ${endOfDay ? '23:59' : '00:00'}`,
    );
  }

  private actor(adapter: PlatformAdapter, user: User): string {
    return `${adapter.platform}:${user.platformUserId}`;
  }

  private helpText(prefix?: string): string {
    return [
      ...(prefix ? [prefix, ''] : []),
      '🧾 <b>مدیریت درخواست‌های فروش</b>',
      '',
      '<b>دستورها</b>',
      '/sales — فهرست آخرین درخواست‌ها',
      '/sales list [صفحه] — صفحه‌بندی',
      '/sales find &lt;کد|نام|بخشی از شماره&gt; — جست‌وجو',
      '/sales filter status:NEW cat:COIN campaign:cmp_1 from:2026-10-01 to:2026-10-16',
      '/sales filter clear — پاک کردن فیلترها',
      '/sales show &lt;کد&gt; — جزئیات درخواست',
      '/sales history &lt;کد&gt; — تاریخچهٔ کامل',
      '/sales contact &lt;کد&gt; [یادداشت] — ثبت تلاش تماس',
      '/sales note &lt;کد&gt; &lt;متن&gt; — افزودن یادداشت',
      '/sales assign &lt;کد&gt; &lt;کارشناس|none&gt; — واگذاری',
      '/sales status &lt;کد&gt; &lt;NEW|CONTACTED|QUALIFIED&gt; — تغییر وضعیت',
      '/sales lost &lt;کد&gt; &lt;REASON&gt; [یادداشت] — از دست رفتن با دلیل',
      '/sales convert &lt;کد&gt; — تبدیل به مشتری (ثبت رویداد فاز ۸)',
      '/sales sale &lt;کد&gt; &lt;مبلغ TOMAN|RIAL|-&gt; — ثبت واقعی فروش',
      '/sales stats — گزارش خلاصه',
      '/sales retry — تلاش دوباره برای پیوندهای ناموفق فاز ۸',
      '',
      'دلیل‌های از دست رفتن: ' +
        LOSS_REASONS.map(
          (reason) => `${reason}=${LOSS_REASON_LABELS_FA[reason]}`,
        ).join(' · '),
      '',
      'ℹ️ هر تغییر وضعیت/واگذاری/یادداشت با نام کارشناس و زمان ثبت می‌شود و تاریخچه پاک نمی‌شود.',
      'ℹ️ فروش فقط با ثبت دستی کارشناس ثبت می‌شود؛ فرم درخواست هرگز فروش شمرده نمی‌شود.',
    ].join('\n');
  }

  private async send(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    keyboard: Keyboard,
    editMessageId?: number,
  ): Promise<void> {
    try {
      await adapter.render({
        chatId: user.chatId ?? user.platformUserId,
        text,
        keyboard,
        ...(typeof editMessageId === 'number' ? { editMessageId } : {}),
      });
    } catch (error) {
      this.logger.error(
        `Could not render the sales admin surface: ${describeError(error)}`,
      );
    }
  }
}

function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

/** Parse one operator message into a sale amount + explicit currency (§11.2, §14.2). */
export function parseSaleInput(
  raw: string,
):
  | { ok: true; amount: number | null; currency: MoneyUnit | null }
  | { ok: false; message: string } {
  const tokens = raw
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .split(/\s+/u)
    .filter((token) => token !== '');

  if (tokens.length === 0) {
    return { ok: false, message: 'مبلغ را وارد کنید یا فقط «-» بفرستید.' };
  }

  if (tokens.length === 1 && tokens[0] === '-') {
    return { ok: true, amount: null, currency: null };
  }

  const [amountToken, currencyToken, ...extra] = tokens;

  if (extra.length > 0) {
    return {
      ok: false,
      message: 'قالب درست: مبلغ واحد — مثال: 120000000 TOMAN',
    };
  }

  const digits = amountToken.replace(/,/gu, '');
  const amount = Number(digits);

  if (!/^\d+$/u.test(digits) || !Number.isSafeInteger(amount) || amount <= 0) {
    return {
      ok: false,
      message:
        'مبلغ باید یک عدد صحیح و بزرگ‌تر از صفر باشد (یا برای ثبت بدون مبلغ «-»).',
    };
  }

  if (currencyToken === undefined) {
    return {
      ok: false,
      message:
        'واحد پول را مشخص کنید: TOMAN یا RIAL (واحد هرگز حدس زده نمی‌شود).',
    };
  }

  const currency = currencyToken.toUpperCase();

  if (currency !== 'TOMAN' && currency !== 'RIAL') {
    return { ok: false, message: 'واحد پول فقط TOMAN یا RIAL می‌تواند باشد.' };
  }

  return { ok: true, amount, currency };
}

/**
 * Parse `/sales …`. The parser is deliberately strict: an unknown token means “invalid” and the
 * operator gets the help text, instead of a silently ignored argument (§15.1).
 */
export function parseSalesCommand(text: string): ParsedSalesCommand {
  const tokens = text
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '');

  const [head, second, ...rest] = tokens;

  if (!head || !head.toLowerCase().startsWith('/sales')) {
    return { action: 'invalid' };
  }

  if (second === undefined) {
    return { action: 'list', page: 1 };
  }

  const sub = second.toLowerCase();

  if (sub === 'help') {
    return { action: 'help' };
  }

  if (sub === 'stats') {
    return { action: 'stats' };
  }

  if (sub === 'retry') {
    return { action: 'retry' };
  }

  if (sub === 'list') {
    const page = rest.length === 0 ? 1 : Number(rest[0]);

    return Number.isInteger(page) && page >= 1
      ? { action: 'list', page }
      : { action: 'invalid' };
  }

  if (sub === 'find') {
    const query = rest.join(' ').trim();

    return query === '' ? { action: 'invalid' } : { action: 'find', query };
  }

  if (sub === 'filter') {
    if (rest.length === 0) {
      return { action: 'invalid' };
    }

    if (rest.length === 1 && rest[0].toLowerCase() === 'clear') {
      return { action: 'filter', clearFilters: true };
    }

    const filters: ParsedSalesCommand['filters'] = {};
    let recognised = false;

    for (const token of rest) {
      const [key, ...valueParts] = token.split(':');
      const value = valueParts.join(':');

      if (value === '') {
        continue;
      }

      switch (key.toLowerCase()) {
        case 'status':
          filters.status = value;
          recognised = true;
          break;
        case 'cat':
        case 'category':
          filters.category = value;
          recognised = true;
          break;
        case 'campaign':
          filters.campaignId = value;
          recognised = true;
          break;
        case 'from':
          filters.from = value;
          recognised = true;
          break;
        case 'to':
          filters.to = value;
          recognised = true;
          break;
        default:
          break;
      }
    }

    return recognised ? { action: 'filter', filters } : { action: 'invalid' };
  }

  // Every remaining sub-command takes the request reference as its first argument (§10.1): the
  // reference is the only identifier an operator types, and it is re-resolved server-side.
  const [reference, ...args] = rest;

  if (reference === undefined) {
    return { action: 'invalid' };
  }

  switch (sub) {
    case 'show':
      return args.length === 0
        ? { action: 'show', reference }
        : { action: 'invalid' };
    case 'history':
      return args.length === 0
        ? { action: 'history', reference }
        : { action: 'invalid' };
    case 'convert':
      return args.length === 0
        ? { action: 'convert', reference }
        : { action: 'invalid' };
    case 'contact':
      return {
        action: 'contact',
        reference,
        note: args.length === 0 ? undefined : args.join(' '),
      };
    case 'note': {
      const note = args.join(' ').trim();

      return note === ''
        ? { action: 'invalid' }
        : { action: 'note', reference, note };
    }
    case 'assign':
      return args.length === 1
        ? { action: 'assign', reference, assignee: args[0] }
        : { action: 'invalid' };
    case 'status':
      return args.length === 1
        ? { action: 'status', reference, status: args[0].toUpperCase() }
        : { action: 'invalid' };
    case 'lost': {
      const [reason, ...noteParts] = args;

      if (reason === undefined) {
        return { action: 'invalid' };
      }

      return {
        action: 'lost',
        reference,
        reason: reason.toUpperCase(),
        note: noteParts.length > 0 ? noteParts.join(' ') : undefined,
      };
    }
    case 'sale': {
      const [amount, currency, ...noteParts] = args;

      if (amount === undefined) {
        return { action: 'invalid' };
      }

      const note = noteParts.length > 0 ? noteParts.join(' ') : undefined;

      if (amount === '-') {
        return { action: 'sale', reference, amount: '-', note };
      }

      return currency === undefined
        ? { action: 'invalid' }
        : { action: 'sale', reference, amount, currency, note };
    }
    default:
      return { action: 'invalid' };
  }
}

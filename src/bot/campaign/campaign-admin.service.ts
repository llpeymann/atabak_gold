import { Injectable, Logger } from '@nestjs/common';

import { escapeHtml } from '../../common/html';
import { describeError } from '../../common/log-safety';
import { formatNumberFa } from '../../common/money';
import { tehranDateFa, tehranTimeFa } from '../../common/tehran-time';
import { AppConfigService } from '../../config/app-config.service';
import { Platform } from '../../platform/platform.types';
import { PlatformAdapter } from '../../platform/platform-adapter';
import { Keyboard, KeyboardRow } from '../../platform/platform.types';
import { User } from '../../users/user.types';
import { CampaignConversionService } from '../../campaigns/campaign-conversion.service';
import {
  CampaignMetricsService,
  MetricValue,
  RatioMetric,
  ReportWindow,
} from '../../campaigns/campaign-metrics.service';
import { CampaignService } from '../../campaigns/campaign.service';
import {
  AttributionBucket,
  CampaignRecord,
  CampaignResult,
  CampaignStatus,
  ConversionRecord,
  ConversionType,
  FunnelStage,
  MetricKind,
} from '../../campaigns/campaign.types';
import { tehranWallClockToIso } from '../content/content-admin.service';
import {
  callbackDataForBack,
  callbackDataForCampaignLinks,
  callbackDataForCampaignList,
  callbackDataForCampaignStats,
  callbackDataForCampaignStatus,
  callbackDataForCampaignView,
  callbackDataForHome,
  CampaignCallbackAction,
} from '../ux/callback-data';

/**
 * Phase 8 — the campaign dashboard, inside the existing bot (§9.1).
 *
 * There is no web dashboard and no chart: the surface is paginated text and tables, exactly like the
 * Phase 5 content admin. Two rules are enforced *here* as well as in the domain layer, because this is
 * the last place before something is shown to a human:
 *
 *  * authorization is re-checked from the platform identity on every command and every button press —
 *    the callback payload never carries a role;
 *  * an unavailable metric is printed as its reason, never as `0`, and a ratio with a zero denominator
 *    is printed as `تعریفنشده`, never as `∞`/`NaN`.
 */

const PAGE_SIZE = 8;
const KIND_LABELS: Record<MetricKind, string> = {
  UNIQUE_USERS: 'کاربر یکتا',
  TOTAL_EVENTS: 'کل رویدادها',
  EXTERNAL_AGGREGATE: 'داده واردشده (تجمیعی)',
};
const STATUS_LABELS: Record<CampaignStatus, string> = {
  ACTIVE: 'فعال',
  PAUSED: 'متوقف',
  ENDED: 'پایان‌یافته',
};
const BUCKET_LABELS: Record<AttributionBucket, string> = {
  CAMPAIGN: 'منتسب به کمپین',
  NO_TOUCH: 'بدون تماس کمپینی (ارگانیک/مستقیم)',
  EXPIRED_WINDOW: 'خارج از پنجره انتساب',
  TOUCH_AFTER_CONVERSION: 'تماس بعد از زمان تبدیل',
  TRACKING_DISABLED: 'ردیابی غیرفعال',
};
const STAGE_LABELS: Record<FunnelStage, string> = {
  IMPRESSION: 'نمایش',
  CLICK: 'کلیک',
  START: 'شروع',
  CHANNEL_JOIN: 'عضویت کانال',
  ALERT_CREATED: 'ساخت هشدار',
  LEAD: 'سرنخ',
  CUSTOMER: 'مشتری',
};
const PRESET_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };

export interface ParsedCampaignCommand {
  action:
    | 'list'
    | 'help'
    | 'new'
    | 'show'
    | 'links'
    | 'stats'
    | 'report'
    | 'compare'
    | 'cost'
    | 'range'
    | 'pause'
    | 'activate'
    | 'end'
    | 'import'
    | 'lead'
    | 'customer'
    | 'correct'
    | 'invalid';
  id?: string;
  preset?: string;
  filters?: { source?: string; medium?: string; campaignId?: string };
  source?: string;
  destinationType?: 'BOT_START' | 'CHANNEL_INVITE';
  destination?: string;
  name?: string;
  amount?: string;
  currency?: string;
  provider?: string;
  metric?: string;
  value?: string;
  from?: string;
  to?: string;
  userReference?: string;
  time?: string;
  note?: string;
  replace?: boolean;
  page?: number;
}

@Injectable()
export class CampaignAdminService {
  private readonly logger = new Logger(CampaignAdminService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly campaigns: CampaignService,
    private readonly conversions: CampaignConversionService,
    private readonly metrics: CampaignMetricsService,
  ) {}

  /** The campaign surface reuses the existing admin allow-list (§14) and needs tracking enabled. */
  get enabled(): boolean {
    return this.config.channelAdminUserIds.length > 0;
  }

  isAdmin(platform: Platform, platformUserId: string): boolean {
    if (!this.enabled) {
      return false;
    }

    const entries = this.config.channelAdminUserIds;

    return (
      entries.includes(`${platform}:${platformUserId}`) ||
      entries.includes(platformUserId)
    );
  }

  owns(text: string): boolean {
    return text.trimStart().startsWith('/campaign');
  }

  /** Handle a `/campaign …` command. Returns `false` when the sender is not an admin. */
  async handleCommand(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      this.logger.warn(
        `Non-admin (${adapter.platform}) tried the campaign surface.`,
      );

      return false;
    }

    if (!this.campaigns.enabled) {
      await this.send(
        adapter,
        user,
        `⚠️ ردیابی کمپین فعال نیست.\n${this.campaigns.trackingDisabledReason ?? ''}`.trim(),
      );

      return true;
    }

    const parsed = parseCampaignCommand(text);

    switch (parsed.action) {
      case 'help':
      case 'invalid':
        await this.send(
          adapter,
          user,
          parsed.action === 'invalid'
            ? this.helpText('دستور نامعتبر است.')
            : this.helpText(),
        );
        return true;
      case 'list':
        await this.renderList(adapter, user, parsed.page ?? 1);
        return true;
      case 'new':
        await this.handleNew(adapter, user, parsed);
        return true;
      case 'show':
        await this.renderCampaign(adapter, user, parsed.id ?? '');
        return true;
      case 'links':
        await this.renderLinks(adapter, user, parsed.id ?? '');
        return true;
      case 'stats':
        await this.renderStats(
          adapter,
          user,
          parsed.id ?? '',
          parsed.preset ?? '30',
        );
        return true;
      case 'report':
        await this.renderReport(adapter, user, parsed);
        return true;
      case 'compare':
        await this.renderCompare(
          adapter,
          user,
          parsed.preset ?? '30',
          parsed.filters ?? {},
        );
        return true;
      case 'cost':
        await this.handleCost(adapter, user, parsed);
        return true;
      case 'range':
        await this.handleRange(adapter, user, parsed);
        return true;
      case 'pause':
      case 'activate':
      case 'end':
        await this.handleStatus(adapter, user, parsed);
        return true;
      case 'import':
        await this.handleImport(adapter, user, parsed);
        return true;
      case 'lead':
      case 'customer':
        await this.handleConversion(adapter, user, parsed);
        return true;
      default:
        await this.handleCorrection(adapter, user, parsed);
        return true;
    }
  }

  /** Handle an inline button of the campaign surface. */
  async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
    action: CampaignCallbackAction,
  ): Promise<void> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      await adapter.acknowledge(callbackId, 'این بخش در دسترس نیست.');
      this.logger.warn(
        `Non-admin (${adapter.platform}) pressed a campaign button.`,
      );
      return;
    }

    switch (action.kind) {
      case 'campaign-list':
        await adapter.acknowledge(callbackId);
        await this.renderList(adapter, user, action.page, messageId);
        return;
      case 'campaign-view':
        await adapter.acknowledge(callbackId);
        await this.renderCampaign(adapter, user, action.campaignId, messageId);
        return;
      case 'campaign-stats':
        await adapter.acknowledge(callbackId);
        await this.renderStats(
          adapter,
          user,
          action.campaignId,
          '30',
          messageId,
        );
        return;
      case 'campaign-links':
        await adapter.acknowledge(callbackId);
        await this.renderLinks(adapter, user, action.campaignId, messageId);
        return;
      default: {
        const status: CampaignStatus =
          action.kind === 'campaign-activate'
            ? 'ACTIVE'
            : action.kind === 'campaign-pause'
              ? 'PAUSED'
              : 'ENDED';
        const result = await this.campaigns.setStatus(
          action.campaignId,
          status,
          this.operator(user),
        );

        await adapter.acknowledge(
          callbackId,
          result.ok
            ? `وضعیت: ${STATUS_LABELS[status]}`
            : 'تغییر وضعیت انجام نشد.',
        );

        if (!result.ok) {
          await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
          return;
        }

        await this.renderCampaign(adapter, user, action.campaignId, messageId);
      }
    }
  }

  // --- screens -----------------------------------------------------------------

  private async renderList(
    adapter: PlatformAdapter,
    user: User,
    page: number,
    messageId?: number,
  ): Promise<void> {
    const all = this.campaigns.findCampaigns({});
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const slice = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
    const lines = ['📊 <b>کمپین‌ها</b>', ''];
    const persistenceWarning = this.campaigns.persistenceWarning;

    if (persistenceWarning) {
      lines.push(`⚠️ ${escapeHtml(persistenceWarning)}`, '');
    }

    if (all.length === 0) {
      lines.push('هنوز کمپینی ساخته نشده است.');
      lines.push('');
      lines.push(this.helpText());
      await this.send(
        adapter,
        user,
        lines.join('\n'),
        listKeyboard(1, pages),
        messageId,
      );
      return;
    }

    for (const campaign of slice) {
      lines.push(
        `▫️ <code>${escapeHtml(campaign.campaignId)}</code> — ${escapeHtml(campaign.name)}`,
      );
      lines.push(
        `   ${escapeHtml(STATUS_LABELS[campaign.status])} · منبع: <code>${escapeHtml(campaign.source)}</code>` +
          (campaign.medium
            ? ` · میانه: <code>${escapeHtml(campaign.medium)}</code>`
            : '') +
          ` · ${escapeHtml(campaign.destinationType === 'BOT_START' ? `ربات/${campaign.destination}` : `کانال/${campaign.destination}`)}`,
      );
    }

    lines.push('');
    lines.push(`صفحه ${formatNumberFa(current)} از ${formatNumberFa(pages)}`);

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      listKeyboard(current, pages),
      messageId,
    );
  }

  private async renderCampaign(
    adapter: PlatformAdapter,
    user: User,
    campaignId: string,
    messageId?: number,
  ): Promise<void> {
    const campaign = this.campaigns.findCampaign(campaignId);

    if (!campaign) {
      await this.send(
        adapter,
        user,
        '❌ این کمپین پیدا نشد.',
        listKeyboard(1, 1),
        messageId,
      );
      return;
    }

    const lines = [
      `📊 <b>${escapeHtml(campaign.name)}</b>`,
      '',
      `شناسه: <code>${escapeHtml(campaign.campaignId)}</code>`,
      `وضعیت: <b>${escapeHtml(STATUS_LABELS[campaign.status])}</b>`,
      `منبع/میانه: <code>${escapeHtml(campaign.source)}</code> / <code>${escapeHtml(campaign.medium ?? '-')}</code>`,
      `مقصد: ${escapeHtml(campaign.destinationType === 'BOT_START' ? `ربات (${campaign.destination})` : `کانال (${campaign.destination})`)}`,
      `ساخته‌شده: ${escapeHtml(this.dateFa(campaign.createdAt))}${
        campaign.createdBy
          ? ` توسط <code>${escapeHtml(campaign.createdBy)}</code>`
          : ''
      }`,
      `بازه: ${escapeHtml(campaign.startAt ? this.dateFa(campaign.startAt) : '—')} تا ${escapeHtml(campaign.endAt ? this.dateFa(campaign.endAt) : '—')}`,
      `هزینه ثبت‌شده: ${
        campaign.costAmount === null
          ? 'ثبت نشده'
          : `${formatNumberFa(campaign.costAmount)} ${escapeHtml(campaign.costCurrency ?? '')}`
      }`,
    ];

    if (campaign.note) {
      lines.push(`یادداشت: ${escapeHtml(campaign.note)}`);
    }

    lines.push('');
    lines.push(
      'کلیک‌ها فقط از لینک‌های ردیابی‌شده ثبت می‌شوند؛ آمار هر شاخص با برچسب نوع آن نمایش داده می‌شود.',
    );

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      campaignKeyboard(campaign),
      messageId,
    );
  }

  private async renderLinks(
    adapter: PlatformAdapter,
    user: User,
    campaignId: string,
    messageId?: number,
  ): Promise<void> {
    const campaign = this.campaigns.findCampaign(campaignId);

    if (!campaign) {
      await this.send(
        adapter,
        user,
        '❌ این کمپین پیدا نشد.',
        listKeyboard(1, 1),
        messageId,
      );
      return;
    }

    const links = this.campaigns.buildLinks(campaign);
    const lines = [
      `🔗 <b>لینک‌های کمپین</b> <code>${escapeHtml(campaign.campaignId)}</code>`,
      '',
    ];

    if (links.payload) {
      lines.push(`payload شروع: <code>${escapeHtml(links.payload)}</code>`);
      lines.push('');
    }

    for (const link of links.links) {
      lines.push(`▪️ <b>${escapeHtml(link.platform)}</b>`);
      lines.push(
        link.trackedUrl
          ? `   ردیابی‌شده: <code>${escapeHtml(link.trackedUrl)}</code>`
          : '   ردیابی‌شده: ساخته نشد',
      );
      lines.push(
        link.directUrl
          ? `   مستقیم (بدون ثبت کلیک): <code>${escapeHtml(link.directUrl)}</code>`
          : '   مستقیم: ساخته نشد',
      );
    }

    for (const note of links.notes) {
      lines.push('');
      lines.push(`ℹ️ ${escapeHtml(note)}`);
    }

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      campaignKeyboard(campaign),
      messageId,
    );
  }

  private async renderStats(
    adapter: PlatformAdapter,
    user: User,
    campaignId: string,
    preset: string,
    messageId?: number,
  ): Promise<void> {
    const window = this.windowFor(preset);
    const report = this.metrics.campaignReport(campaignId, window);

    if (!report) {
      await this.send(
        adapter,
        user,
        '❌ این کمپین پیدا نشد.',
        listKeyboard(1, 1),
        messageId,
      );
      return;
    }

    const lines = [
      `📈 <b>آمار کمپین</b> ${escapeHtml(report.campaign.name)}`,
      `بازه: ${escapeHtml(window.label)} (شروع: ${escapeHtml(this.dateFa(window.from.toISOString()))} — پایان: ${escapeHtml(this.dateFa(window.to.toISOString()))})`,
      '',
      '<b>مراحل قیف</b>',
    ];

    for (const metric of report.metrics) {
      lines.push(this.metricLine(metric));
    }

    lines.push('', '<b>نرخ تبدیل</b>');

    for (const ratio of report.ratios) {
      lines.push(this.ratioLine(ratio));
    }

    lines.push('', '<b>هزینه (ثبت‌شده)</b>');
    lines.push(
      report.costs.recorded.amount === null
        ? `— ${escapeHtml(report.costs.recorded.unavailableReason ?? 'ثبت نشده')}`
        : `— مجموع: ${formatNumberFa(report.costs.recorded.amount)} ${escapeHtml(report.costs.recorded.currency ?? '')}`,
    );

    for (const ratio of [
      report.costs.perStart,
      report.costs.perLead,
      report.costs.perCustomer,
    ]) {
      lines.push(
        ratio.amount === null
          ? `— ${escapeHtml(ratio.labelFa)}: ${escapeHtml(ratio.unavailableReason ?? 'قابل محاسبه نیست')}`
          : `— ${escapeHtml(ratio.labelFa)}: ${formatNumberFa(ratio.amount)} ${escapeHtml(ratio.currency ?? '')}`,
      );
    }

    if (report.unattributed.length > 0) {
      lines.push('', '<b>تبدیل‌های بدون انتساب در این بازه</b>');

      for (const row of report.unattributed) {
        lines.push(
          `— ${escapeHtml(BUCKET_LABELS[row.bucket])}: ${formatNumberFa(row.count)}`,
        );
      }
    }

    if (
      report.imports.included +
        report.imports.excludedPartial +
        report.imports.excludedMetric >
      0
    ) {
      lines.push('', '<b>داده‌های واردشده</b>');
      lines.push(
        `— واردشده و کامل داخل بازه: ${formatNumberFa(report.imports.included)}` +
          (report.imports.providers.length > 0
            ? ` (منابع: ${escapeHtml(report.imports.providers.join(', '))})`
            : ''),
      );

      if (report.imports.excludedPartial > 0) {
        lines.push(
          `— خارج از بازه (نمایش داده نشد، بدون سرشکنی): ${formatNumberFa(report.imports.excludedPartial)}`,
        );
      }

      if (report.imports.excludedMetric > 0) {
        lines.push(
          `— با شاخص پشتیبانی‌نشده: ${formatNumberFa(report.imports.excludedMetric)}`,
        );
      }
    }

    if (report.rejections.length > 0) {
      lines.push('', '<b>درخواست‌های ردشده (شمارنده، نه رویداد)</b>');

      for (const row of report.rejections) {
        lines.push(`— ${escapeHtml(row.reason)}: ${formatNumberFa(row.count)}`);
      }
    }

    for (const note of report.notes) {
      lines.push('', `ℹ️ ${escapeHtml(note)}`);
    }

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      campaignKeyboard(report.campaign),
      messageId,
    );
  }

  private async renderReport(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const window = this.windowFor(parsed.preset ?? '30');
    const filters = parsed.filters ?? {};
    const report = this.metrics.aggregateReport(window, filters);
    const lines = [
      '📊 <b>گزارش کمپین‌ها</b>',
      `بازه: ${escapeHtml(window.label)}`,
    ];

    if (filters.source || filters.medium || filters.campaignId) {
      lines.push(
        `فیلترها: ${escapeHtml(
          [
            filters.source ? `source=${filters.source}` : null,
            filters.medium ? `medium=${filters.medium}` : null,
            filters.campaignId ? `campaign=${filters.campaignId}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · '),
        )}`,
      );
    }

    lines.push('', '<b>جمع کل</b>');

    for (const metric of report.totals) {
      lines.push(this.metricLine(metric));
    }

    lines.push('', '<b>رتبه‌بندی کمپین‌ها</b>');

    for (const ranking of report.rankings) {
      if (ranking.rows.length === 0) {
        continue;
      }

      lines.push(
        `— ${escapeHtml(ranking.labelFa)} (${escapeHtml(KIND_LABELS[ranking.kind])}):`,
      );

      for (const row of ranking.rows.slice(0, 5)) {
        lines.push(
          `   ${formatNumberFa(row.value)} — ${escapeHtml(row.name)} <code>${escapeHtml(row.campaignId)}</code> (${escapeHtml(row.source)})`,
        );
      }
    }

    if (report.sourcesByModel.length > 0) {
      lines.push('', '<b>بهترین منابع بر اساس مدل انتساب</b>');

      for (const row of report.sourcesByModel) {
        lines.push(
          `— ${escapeHtml(row.model === 'FIRST_TOUCH' ? 'اولین تماس' : 'آخرین تماس')} · <code>${escapeHtml(row.source)}</code>: ` +
            `سرنخ ${formatNumberFa(row.leads)} · مشتری ${formatNumberFa(row.customers)}`,
        );
      }
    }

    const sources = this.campaigns.knownFacets();

    if (sources.sources.length > 0) {
      lines.push('', '<b>منابع موجود</b>');
      lines.push(`— ${escapeHtml(sources.sources.join(', '))}`);

      if (sources.mediums.length > 0) {
        lines.push(`— میانه‌ها: ${escapeHtml(sources.mediums.join(', '))}`);
      }
    }

    for (const note of report.notes) {
      lines.push('', `ℹ️ ${escapeHtml(note)}`);
    }

    await this.send(adapter, user, lines.join('\n'), listKeyboard(1, 1));
  }

  private async renderCompare(
    adapter: PlatformAdapter,
    user: User,
    preset: string,
    filters: { source?: string; medium?: string; campaignId?: string },
  ): Promise<void> {
    const { current, previous } = this.windowsFor(preset);
    const comparison = this.metrics.compareWindows(current, previous, filters);
    const lines = [
      '📊 <b>مقایسه بازه</b>',
      `بازه جاری: ${escapeHtml(current.label)}`,
      `بازه مقایسه: ${escapeHtml(previous.label)}`,
      '',
    ];

    for (const delta of comparison.deltas) {
      const currentText =
        delta.current === null
          ? 'در دسترس نیست'
          : formatNumberFa(delta.current);
      const previousText =
        delta.previous === null
          ? 'در دسترس نیست'
          : formatNumberFa(delta.previous);

      lines.push(`▪️ ${escapeHtml(delta.labelFa)}`);
      lines.push(
        `   جاری ${currentText} · مقایسه ${previousText} · تغییر ${
          delta.percent === null
            ? 'تعریف‌نشده'
            : `${formatNumberFa(delta.percent)}٪`
        }`,
      );
    }

    lines.push(
      '',
      'ℹ️ تغییر درصدی فقط با مخرج بزرگ‌تر از صفر نمایش داده می‌شود.',
    );

    await this.send(adapter, user, lines.join('\n'), listKeyboard(1, 1));
  }

  // --- command handlers ---------------------------------------------------------

  private async handleNew(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const result = await this.campaigns.createCampaign({
      name: parsed.name ?? '',
      source: parsed.source ?? '',
      destinationType: parsed.destinationType ?? 'BOT_START',
      destination: parsed.destination ?? '',
      createdBy: this.operator(user),
    });

    if (!result.ok) {
      await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
      return;
    }

    await this.renderCampaign(adapter, user, result.value.campaignId);
  }

  private async handleCost(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const campaignId = parsed.id ?? '';
    const clearing = parsed.amount === '-' || parsed.amount === undefined;

    if (
      !clearing &&
      (!parsed.currency || !/^[A-Za-z]{3}$/.test(parsed.currency))
    ) {
      await this.send(
        adapter,
        user,
        '❌ واحد پول لازم است (سه حرف لاتین، مثال: EUR). برای پاک کردن: <code>/campaign cost &lt;id&gt; -</code>',
      );
      return;
    }

    const result = await this.campaigns.setCost(
      campaignId,
      clearing ? null : Number(parsed.amount),
      clearing ? null : (parsed.currency as string).toUpperCase(),
      this.operator(user),
    );

    await this.reportResult(adapter, user, result, campaignId);
  }

  private async handleRange(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const startAt = dayBoundary(parsed.from ?? '-', 'start');
    const endAt = dayBoundary(parsed.to ?? '-', 'end');

    if (!startAt.ok || !endAt.ok) {
      await this.send(
        adapter,
        user,
        '❌ تاریخ باید <code>YYYY-MM-DD</code> (به وقت تهران) یا <code>-</code> باشد.',
      );
      return;
    }

    const result = await this.campaigns.setDateRange(
      parsed.id ?? '',
      startAt.value,
      endAt.value,
      this.operator(user),
    );

    await this.reportResult(adapter, user, result, parsed.id ?? '');
  }

  private async handleStatus(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const status: CampaignStatus =
      parsed.action === 'activate'
        ? 'ACTIVE'
        : parsed.action === 'pause'
          ? 'PAUSED'
          : 'ENDED';
    const result = await this.campaigns.setStatus(
      parsed.id ?? '',
      status,
      this.operator(user),
    );

    await this.reportResult(adapter, user, result, parsed.id ?? '');
  }

  private async handleImport(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const metric = (parsed.metric ?? '').toUpperCase() as FunnelStage;
    const startAt = dayBoundary(parsed.from ?? '-', 'start');
    const endAt = dayBoundary(parsed.to ?? '-', 'end');

    if (
      !startAt.ok ||
      !endAt.ok ||
      startAt.value === null ||
      endAt.value === null
    ) {
      await this.send(
        adapter,
        user,
        '❌ بازه باید <code>YYYY-MM-DD</code> (به وقت تهران) باشد.',
      );
      return;
    }

    const result = await this.conversions.importAggregate({
      campaignId: parsed.id ?? '',
      provider: parsed.provider ?? '',
      metric,
      value: Number(parsed.value),
      periodStart: startAt.value,
      periodEnd: endAt.value,
      operator: this.operator(user),
      replaceExisting: parsed.replace === true,
      note: parsed.note ?? null,
    });

    if (!result.ok) {
      await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
      return;
    }

    await this.send(
      adapter,
      user,
      [
        '✅ داده تجمیعی ثبت شد.',
        `<code>${escapeHtml(result.value.importId)}</code> — ${escapeHtml(STAGE_LABELS[result.value.metric])} = ${formatNumberFa(result.value.value)}`,
        `منبع: <code>${escapeHtml(result.value.provider)}</code>`,
        `بازه: ${escapeHtml(this.dateFa(result.value.periodStart))} — ${escapeHtml(this.dateFa(result.value.periodEnd))}`,
        '',
        'این عدد یک «تجمیعی واردشده» است و هرگز به رویداد کاربری تبدیل نمی‌شود.',
      ].join('\n'),
    );
  }

  private async handleConversion(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const type: ConversionType = parsed.action === 'lead' ? 'LEAD' : 'CUSTOMER';
    const occurredAt = parseAdminTime(parsed.time ?? '');

    if (occurredAt === null) {
      await this.send(
        adapter,
        user,
        '❌ زمان تبدیل باید <code>YYYY-MM-DD HH:MM</code> (به وقت تهران) یا <code>now</code> باشد.',
      );
      return;
    }

    const result = await this.conversions.registerConversion({
      type,
      userReference: parsed.userReference ?? '',
      occurredAt,
      operator: this.operator(user),
      note: parsed.note ?? null,
    });

    if (!result.ok) {
      await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
      return;
    }

    await this.send(
      adapter,
      user,
      [
        `✅ ${type === 'LEAD' ? 'سرنخ' : 'مشتری'} ثبت شد.`,
        `<code>${escapeHtml(result.value.conversionId)}</code>`,
        `انتساب: ${
          result.value.campaignId
            ? `<code>${escapeHtml(result.value.campaignId)}</code> (${escapeHtml(result.value.attributionModel ?? '')})`
            : escapeHtml(BUCKET_LABELS[result.value.attributionBucket])
        }`,
        `دلیل: ${escapeHtml(result.value.attributionReason)}`,
      ].join('\n'),
    );
  }

  private async handleCorrection(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedCampaignCommand,
  ): Promise<void> {
    const occurredAt = parsed.time ? parseAdminTime(parsed.time) : undefined;

    if (parsed.time && occurredAt === null) {
      await this.send(
        adapter,
        user,
        '❌ زمان باید <code>YYYY-MM-DD HH:MM</code> (به وقت تهران) یا <code>now</code> باشد.',
      );
      return;
    }

    const result = await this.conversions.correctConversion({
      conversionId: parsed.id ?? '',
      ...(occurredAt ? { occurredAt } : {}),
      operator: this.operator(user),
      note: parsed.note ?? null,
    });

    if (!result.ok) {
      await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
      return;
    }

    await this.send(
      adapter,
      user,
      `✅ اصلاح ثبت شد. رکورد جدید: <code>${escapeHtml(result.value.conversionId)}</code>`,
    );
  }

  private async reportResult(
    adapter: PlatformAdapter,
    user: User,
    result: CampaignResult<CampaignRecord>,
    campaignId: string,
  ): Promise<void> {
    if (!result.ok) {
      await this.send(adapter, user, `❌ ${escapeHtml(result.message)}`);
      return;
    }

    await this.renderCampaign(adapter, user, campaignId);
  }

  // --- rendering helpers --------------------------------------------------------

  private metricLine(metric: MetricValue): string {
    const value =
      metric.value === null
        ? `در دسترس نیست (${escapeHtml(metric.unavailableReason ?? 'دلیل ثبت نشده')})`
        : formatNumberFa(metric.value);

    return `▪️ ${escapeHtml(metric.labelFa)} — ${value} · <i>${escapeHtml(KIND_LABELS[metric.kind])}</i>`;
  }

  private ratioLine(ratio: RatioMetric): string {
    const percent =
      ratio.percent === null
        ? `تعریف‌نشده (${escapeHtml(ratio.unavailableReason ?? 'مخرج صفر')})`
        : `${formatNumberFa(ratio.percent)}٪`;

    return `▪️ ${escapeHtml(ratio.labelFa)} — ${percent} · ${formatNumberFa(ratio.numerator)} از ${formatNumberFa(ratio.denominator)}`;
  }

  private dateFa(iso: string): string {
    const date = new Date(iso);

    return `${tehranDateFa(date)} ${tehranTimeFa(date)}`;
  }

  private operator(user: User): string {
    return `${user.platform}:${user.platformUserId}`;
  }

  /** `[from, to)` in Tehran terms; `all` starts at the oldest campaign. */
  private windowFor(preset: string): ReportWindow {
    const now = new Date();
    const days = PRESET_DAYS[preset];

    if (preset === 'all') {
      const campaigns = this.campaigns.listCampaigns();
      const oldest = campaigns
        .map((campaign) => Date.parse(campaign.createdAt))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)[0];
      const from = oldest === undefined ? new Date(0) : new Date(oldest);

      return { from, to: now, label: 'از ابتدا تا اکنون' };
    }

    const span = (days ?? 30) * 24 * 60 * 60 * 1000;

    return {
      from: new Date(now.getTime() - span),
      to: now,
      label: `${formatNumberFa(days ?? 30)} روز اخیر`,
    };
  }

  /** Current and previous window of the same length, for the comparison screen. */
  private windowsFor(preset: string): {
    current: ReportWindow;
    previous: ReportWindow;
  } {
    const days = PRESET_DAYS[preset] ?? 30;
    const now = new Date();
    const span = days * 24 * 60 * 60 * 1000;

    return {
      current: {
        from: new Date(now.getTime() - span),
        to: now,
        label: `${formatNumberFa(days)} روز اخیر`,
      },
      previous: {
        from: new Date(now.getTime() - 2 * span),
        to: new Date(now.getTime() - span),
        label: `${formatNumberFa(days)} روز پیش از آن`,
      },
    };
  }

  private helpText(prefix?: string): string {
    return [
      prefix ? `⚠️ ${prefix}` : '📊 <b>ردیابی کمپین و انتساب</b>',
      '',
      '<code>/campaign</code> — فهرست کمپین‌ها',
      '<code>/campaign list [صفحه]</code>',
      '<code>/campaign new &lt;source&gt; &lt;BOT_START|CHANNEL_INVITE&gt; &lt;destination&gt; &lt;نام&gt;</code>',
      '<code>/campaign show &lt;cmp_id&gt;</code>',
      '<code>/campaign links &lt;cmp_id&gt;</code>',
      '<code>/campaign stats &lt;cmp_id&gt; [7|30|90|all]</code>',
      '<code>/campaign report [7|30|90|all] [source=&lt;s&gt;] [medium=&lt;m&gt;]</code>',
      '<code>/campaign compare [7|30|90]</code>',
      '<code>/campaign cost &lt;cmp_id&gt; &lt;مبلغ&gt; &lt;CUR&gt;|-</code>',
      '<code>/campaign range &lt;cmp_id&gt; &lt;YYYY-MM-DD|-&gt; &lt;YYYY-MM-DD|-&gt;</code>',
      '<code>/campaign pause|activate|end &lt;cmp_id&gt;</code>',
      '<code>/campaign import &lt;cmp_id&gt; &lt;provider&gt; &lt;IMPRESSION|CLICK&gt; &lt;value&gt; &lt;YYYY-MM-DD&gt; &lt;YYYY-MM-DD&gt; [--replace]</code>',
      '<code>/campaign lead &lt;platform:id|usr_x&gt; &lt;YYYY-MM-DD HH:MM|now&gt; [یادداشت]</code>',
      '<code>/campaign customer &lt;…&gt;</code>',
      '<code>/campaign correct &lt;cnv_id&gt; [YYYY-MM-DD HH:MM|now] [یادداشت]</code>',
      '',
      'قواعد: هر عدد با نوع شمارش خودش (کاربر یکتا / کل رویدادها / داده واردشده) نمایش داده می‌شود؛',
      'مخرج صفر هرگز به عدد یا بی‌نهایت تبدیل نمی‌شود؛ عضویت کانال فقط با تأیید خود پلتفرم ثبت می‌شود.',
    ].join('\n');
  }

  private async send(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    keyboard: Keyboard = backKeyboard(),
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
        `Could not render the campaign surface: ${describeError(error)}`,
      );
    }
  }
}

// --- keyboard builders --------------------------------------------------------

export function backKeyboard(): Keyboard {
  return [
    [
      { text: '🏠 خانه', callbackData: callbackDataForHome() },
      { text: '🔙 بازگشت', callbackData: callbackDataForBack() },
    ],
  ];
}

export function listKeyboard(page: number, pages: number): Keyboard {
  const navigation: KeyboardRow[] = [];

  if (pages > 1) {
    navigation.push([
      {
        text: '⬅️',
        callbackData: callbackDataForCampaignList(Math.max(1, page - 1)),
      },
      { text: `${page}/${pages}`, callbackData: callbackDataForBack() },
      {
        text: '➡️',
        callbackData: callbackDataForCampaignList(Math.min(pages, page + 1)),
      },
    ]);
  }

  return [...navigation, ...backKeyboard()];
}

export function campaignKeyboard(campaign: CampaignRecord): Keyboard {
  const statusButtons: KeyboardRow[] = [];

  if (campaign.status === 'ACTIVE') {
    statusButtons.push([
      {
        text: '⏸ توقف',
        callbackData: callbackDataForCampaignStatus(
          campaign.campaignId,
          'pause',
        ),
      },
    ]);
  }

  if (campaign.status === 'PAUSED') {
    statusButtons.push([
      {
        text: '▶️ فعال‌سازی',
        callbackData: callbackDataForCampaignStatus(campaign.campaignId, 'act'),
      },
    ]);
  }

  if (campaign.status !== 'ENDED') {
    statusButtons.push([
      {
        text: '⛔ پایان',
        callbackData: callbackDataForCampaignStatus(campaign.campaignId, 'end'),
      },
    ]);
  }

  return [
    ...statusButtons,
    [
      {
        text: '📈 آمار',
        callbackData: callbackDataForCampaignStats(campaign.campaignId),
      },
      {
        text: '🔗 لینک‌ها',
        callbackData: callbackDataForCampaignLinks(campaign.campaignId),
      },
    ],
    [
      {
        text: '📋 جزئیات',
        callbackData: callbackDataForCampaignView(campaign.campaignId),
      },
      { text: '📊 فهرست', callbackData: callbackDataForCampaignList(1) },
      { text: '🏠 خانه', callbackData: callbackDataForHome() },
    ],
  ];
}

// --- parsing ------------------------------------------------------------------

/**
 * Parse `/campaign …`.
 *
 * The syntax stays strictly token-based (no free text except the campaign name and an optional note),
 * so a malformed line can never be interpreted as a privileged change.
 */
export function parseCampaignCommand(text: string): ParsedCampaignCommand {
  const head = (text.replace(/\r\n/g, '\n').split('\n')[0] ?? '').trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  const [, sub, ...rest] = tokens;

  if (sub === undefined || sub === '') {
    return { action: 'list', page: 1 };
  }

  switch (sub) {
    case 'help':
      return { action: 'help' };
    case 'list': {
      const [page, ...extra] = rest;
      const parsed = page === undefined ? 1 : Number(page);

      return extra.length === 0 && Number.isInteger(parsed) && parsed >= 1
        ? { action: 'list', page: parsed }
        : { action: 'invalid' };
    }
    case 'new': {
      const [source, destinationType, destination, ...nameParts] = rest;
      const name = nameParts.join(' ').trim();

      if (
        !source ||
        (destinationType !== 'BOT_START' &&
          destinationType !== 'CHANNEL_INVITE') ||
        !destination ||
        name === ''
      ) {
        return { action: 'invalid' };
      }

      return { action: 'new', source, destinationType, destination, name };
    }
    case 'show':
    case 'links':
    case 'pause':
    case 'activate':
    case 'end': {
      const [id, ...extra] = rest;

      return extra.length === 0 && id !== undefined
        ? { action: sub, id }
        : { action: 'invalid' };
    }
    case 'stats': {
      const [id, preset, ...extra] = rest;

      return extra.length === 0 && id !== undefined
        ? { action: 'stats', id, preset: preset ?? '30' }
        : { action: 'invalid' };
    }
    case 'report':
    case 'compare': {
      const preset =
        rest.find((token) => /^(7|30|90|all)$/.test(token)) ?? '30';
      const filters = parseFilters(rest.filter((token) => token.includes('=')));

      return { action: sub, preset, filters };
    }
    case 'cost': {
      const [id, amount, currency, ...extra] = rest;

      return extra.length === 0 && id !== undefined && amount !== undefined
        ? { action: 'cost', id, amount, currency }
        : { action: 'invalid' };
    }
    case 'range': {
      const [id, from, to, ...extra] = rest;

      return extra.length === 0 &&
        id !== undefined &&
        from !== undefined &&
        to !== undefined
        ? { action: 'range', id, from, to }
        : { action: 'invalid' };
    }
    case 'import': {
      const [id, provider, metric, value, from, to, ...tail] = rest;
      const replace = tail.includes('--replace');

      return id !== undefined &&
        provider !== undefined &&
        metric !== undefined &&
        value !== undefined &&
        from !== undefined &&
        to !== undefined
        ? { action: 'import', id, provider, metric, value, from, to, replace }
        : { action: 'invalid' };
    }
    case 'lead':
    case 'customer': {
      const [userReference, time, ...noteParts] = rest;

      return userReference !== undefined && time !== undefined
        ? {
            action: sub,
            userReference,
            time,
            note: noteParts.join(' ').trim() || undefined,
          }
        : { action: 'invalid' };
    }
    case 'correct': {
      const [id, maybeTime, ...noteParts] = rest;
      const time =
        maybeTime && /^(\d{4}-\d{2}-\d{2}|now)/.test(maybeTime)
          ? maybeTime
          : undefined;
      const trailing = time
        ? noteParts
        : [maybeTime, ...noteParts].filter((part) => typeof part === 'string');
      const note = trailing.join(' ').trim();

      return id !== undefined
        ? { action: 'correct', id, time, note: note || undefined }
        : { action: 'invalid' };
    }
    default:
      return { action: 'invalid' };
  }
}

function parseFilters(tokens: string[]): {
  source?: string;
  medium?: string;
  campaignId?: string;
} {
  const filters: { source?: string; medium?: string; campaignId?: string } = {};

  for (const token of tokens) {
    const [key, value] = token.split('=');

    if (!value) {
      continue;
    }

    if (key === 'source') {
      filters.source = value.toLowerCase();
    } else if (key === 'medium') {
      filters.medium = value.toLowerCase();
    } else if (key === 'campaign') {
      filters.campaignId = value;
    }
  }

  return filters;
}

/**
 * `YYYY-MM-DD` (Tehran) → the start/end of that day; `-` clears the bound.
 *
 * The result is tagged instead of sentinel-valued, so “clear the bound” and “the operator typed
 * something invalid” can never be confused (and no string is ever used as an error code).
 */
type DayBoundary =
  { ok: true; value: string | null } | { ok: false; reason: string };

function dayBoundary(value: string, edge: 'start' | 'end'): DayBoundary {
  if (value === '-') {
    return { ok: true, value: null };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, reason: 'تاریخ باید YYYY-MM-DD باشد.' };
  }

  const iso = tehranWallClockToIso(
    `${value} ${edge === 'start' ? '00:00' : '23:59'}`,
  );

  return iso === null
    ? { ok: false, reason: 'تاریخ معتبر نیست.' }
    : { ok: true, value: iso };
}

/** `now` or `YYYY-MM-DD HH:MM` (Tehran) → ISO, or `null` when the input is not a time at all. */
function parseAdminTime(value: string): string | null {
  if (value.trim().toLowerCase() === 'now') {
    return new Date().toISOString();
  }

  return tehranWallClockToIso(value);
}

/** A conversion row summary, used by tests and by the (optional) lead list screen. */
export function describeConversion(conversion: ConversionRecord): string {
  return [
    conversion.conversionId,
    conversion.type,
    conversion.platformUserId ?? '-',
    conversion.campaignId ?? '-',
    conversion.attributionBucket,
  ].join(' | ');
}

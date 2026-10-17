/**
 * Phase 10 — the dashboard and its metric dictionary (§4, §14).
 *
 * Every number below is read from the store of the phase that owns it. Nothing is estimated, and a
 * metric that cannot be measured returns `value: null` with a reason instead of a zero that would
 * look like a measurement (§2.3, §14 “Missing data”).
 *
 * The dictionary — source, unit and semantics of every KPI — lives next to the code that produces it
 * (`METRIC_DICTIONARY`) and is repeated in the phase documentation, so the screen and the document
 * cannot drift apart.
 *
 * Counting scopes this dashboard uses (and prints on screen where it matters):
 *
 *  * **Users** = platform identities stored by Phase 2 (one row per `platform:platformUserId`). The
 *    project has no verified cross-platform linking, so this is *not* “unique human customers”
 *    (§5.2, §14).
 *  * **New users** = identities created inside the window (Phase 2 `createdAt`).
 *  * **Active users** = distinct identities with at least one *user-initiated* action inside the
 *    window (Phase 10 activity days, written only from the inbound user path).
 *  * **Channel joins** = *verified* membership transitions recorded by Phase 8; when verification is
 *    unavailable the metric says so instead of counting link clicks (§14).
 *  * **Delivery errors** = attempts vs terminal failures vs unknown, reported separately (§14).
 */

import { Injectable } from '@nestjs/common';

import { formatNumberFa } from '../common/money';
import { AppConfigService } from '../config/app-config.service';
import { AlertStore } from '../alerts/alert.store';
import { AlertNotificationService } from '../alerts/alert-notification.service';
import { PublicationStore } from '../channel/publication.store';
import { CampaignStore } from '../campaigns/campaign.store';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';
import { SalesService } from '../sales/sales.service';
import { SalesNotificationService } from '../sales/sales-notification.service';
import { MarketStateService } from '../market/market-state.service';
import { UserStore } from '../users/user.store';
import { AdminActivityService } from './admin-activity.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { AdminErrorService } from './admin-error.service';
import {
  MetricSection,
  MetricValue,
  ReportPeriodPreset,
  ReportWindow,
} from './admin.types';
import {
  PERIOD_LABELS_FA,
  resolveWindow,
  shiftDayKey,
  withinWindow,
} from './admin-period';

export interface MetricDefinition {
  key: string;
  labelFa: string;
  source: string;
  semantics: string;
}

/** The documented metric dictionary (§14/§19.5). Rendered by `/admin` → 📊 آمار → «تعریفها». */
export const METRIC_DICTIONARY: readonly MetricDefinition[] = [
  {
    key: 'usersTotal',
    labelFa: 'کل کاربران',
    source: 'فاز ۲ — سند کاربران',
    semantics:
      'شناسه‌های پلتفرمی ثبت‌شده (هر ردیف = یک هویت روی یک پلتفرم). ادغام هویت بین بله و تلگرام وجود ندارد.',
  },
  {
    key: 'usersNew',
    labelFa: 'کاربران تازه',
    source: 'فاز ۲ — زمان ثبت هویت',
    semantics:
      'هویت‌هایی که نخستین ثبت آن‌ها داخل بازه بوده است (تلاش ناموفق ثبت شمرده نمی‌شود).',
  },
  {
    key: 'usersActive',
    labelFa: 'کاربران فعال',
    source: 'فاز ۱۰ — روزهای فعالیت (تنها از کنش واقعی کاربر)',
    semantics:
      'هویت‌های متمایز با حداقل یک کنش کاربر در بازه. پیام ربات، کار زمان‌بندی‌شده و اعلان خودکار فعال‌سازی نمی‌شود.',
  },
  {
    key: 'channelJoins',
    labelFa: 'عضویت تأییدشدهٔ کانال',
    source: 'فاز ۸ — رویداد عضویت کانال (فقط تأییدشده)',
    semantics:
      'انتقال تأییدشدهٔ «عضو نبود → عضو شد» با پاسخ واقعی پلتفرم. کلیک، بازکردن لینک و /start هرگز عضویت نیست.',
  },
  {
    key: 'alertsActive',
    labelFa: 'هشدارهای فعال',
    source: 'فاز ۳ — سند هشدارها',
    semantics:
      'هشدارهای دارای وضعیت ACTIVE یا DISABLED (ظرفیت مصرف‌شده). وضعیت‌ها جدا شمرده می‌شوند.',
  },
  {
    key: 'alertsTriggered',
    labelFa: 'هشدارهای فعال‌شده',
    source: 'فاز ۳ — وضعیت TRIGGERED',
    semantics: 'هشدارهایی که شرط آن‌ها برآورده و رویداد آن‌ها رزرو شده است.',
  },
  {
    key: 'referrals',
    labelFa: 'دعوت‌های موفق',
    source: 'فاز ۷ — ردیف‌های دعوت',
    semantics:
      'هر ردیف = یک کاربر دعوت‌شدهٔ ثبت‌شده. کلیک روی لینک دعوت دعوت موفق نیست.',
  },
  {
    key: 'leadsTotal',
    labelFa: 'سرنخ‌های ثبت‌شده',
    source: 'فاز ۹ — سند فروش',
    semantics:
      'درخواست‌های ذخیره‌شده (فقط پس از تأیید نهایی مشتری). فرم نیمه‌کاره سرنخ نیست.',
  },
  {
    key: 'leadsNew',
    labelFa: 'سرنخ‌های تازه',
    source: 'فاز ۹ — زمان ثبت درخواست',
    semantics: 'درخواست‌هایی که داخل بازه ثبت شده‌اند.',
  },
  {
    key: 'customersConverted',
    labelFa: 'تبدیل‌شده به مشتری',
    source: 'فاز ۹ — کنش صریح کارشناس',
    semantics:
      'تبدیل‌هایی که کارشناس مجاز ثبت کرده است؛ هرگز از پیام یا تماس استنباط نمی‌شود.',
  },
  {
    key: 'salesRecorded',
    labelFa: 'فروش ثبت‌شده',
    source: 'فاز ۹ — ردیف‌های نتیجهٔ فروش (ACTIVE)',
    semantics:
      'ثبت دستی کارشناس. مبلغ اختیاری است و واحد آن هرگز حدس زده نمی‌شود.',
  },
  {
    key: 'apiErrors',
    labelFa: 'خطاهای ثبت‌شدهٔ سرویس‌ها',
    source: 'فاز ۱۰ — رکورد رویدادهای عملیاتی',
    semantics:
      'مجموع «تعداد رخداد» رویدادهای فعال در بازه (یک رکورد تکراری = یک ردیف با شمارش واقعی رخدادها).',
  },
  {
    key: 'deliveryErrors',
    labelFa: 'خطاهای تحویل',
    source: 'فاز ۳/۵/۹ — سوابق تحویل و اعلان',
    semantics:
      'تلاش‌ها، شکست‌های قطعی و نتیجه‌های نامعلوم جدا شمرده می‌شوند؛ «accepted» به‌معنای «خوانده‌شده» نیست.',
  },
];

@Injectable()
export class AdminMetricsService {
  constructor(
    private readonly config: AppConfigService,
    private readonly users: UserStore,
    private readonly activity: AdminActivityService,
    private readonly alerts: AlertStore,
    private readonly alertNotifications: AlertNotificationService,
    private readonly publication: PublicationStore,
    private readonly campaigns: CampaignStore,
    private readonly tracking: CampaignTrackingService,
    private readonly sales: SalesService,
    private readonly salesNotifications: SalesNotificationService,
    private readonly marketState: MarketStateService,
    private readonly errors: AdminErrorService,
    /** Phase 11 — operational health rows are *read* from the monitoring engine, never recomputed. */
    private readonly monitoring: MonitoringService,
  ) {}

  /** Resolve a preset / custom range with the documented `[from, to)` contract (§4.2). */
  window(
    preset: ReportPeriodPreset,
    now: Date = new Date(),
    custom: { fromDayKey?: string | null; toDayKey?: string | null } = {},
  ): { ok: true; window: ReportWindow } | { ok: false; message: string } {
    return resolveWindow(preset, now, {
      maxDays: this.config.adminReportMaxDays,
      fromDayKey: custom.fromDayKey,
      toDayKey: custom.toDayKey,
    });
  }

  /** The full dashboard, grouped exactly like the spec asks (§4.1). */
  dashboard(window: ReportWindow): MetricSection[] {
    return [
      this.audienceSection(window),
      this.engagementSection(window),
      this.commercialSection(window),
      this.reliabilitySection(window),
    ];
  }

  // --- sections ------------------------------------------------------------------

  private audienceSection(window: ReportWindow): MetricSection {
    const users = this.users.listUsers();
    const newUsers = users.filter((user) =>
      withinWindow(window, user.createdAt),
    );
    const active = this.activity.countActiveIn(window);
    const tracked = this.activity.trackedIdentities;
    const notes: string[] = [];

    if (tracked < users.length) {
      notes.push(
        'کاربران فعال فقط از زمان فعال‌شدن ثبت فعالیت فاز ۱۰ به بعد دیده می‌شوند؛ ردیف‌های قدیمی‌تر تا اولین کنش تازه در این شمارش نیستند.',
      );
    }

    return {
      key: 'audience',
      titleFa: 'مخاطبان',
      metrics: [
        metric(
          'usersTotal',
          'کل کاربران',
          'UNIQUE_USERS',
          users.length,
          null,
          'فاز ۲ — سند کاربران (به‌ازای هر هویت پلتفرمی)',
        ),
        metric(
          'usersNew',
          'کاربران تازه',
          'UNIQUE_USERS',
          newUsers.length,
          null,
          'فاز ۲ — createdAt داخل بازه',
        ),
        metric(
          'usersActive',
          'کاربران فعال',
          'UNIQUE_USERS',
          active,
          null,
          'فاز ۱۰ — روزهای فعالیت ثبت‌شده از کنش کاربر',
        ),
      ],
      notes,
    };
  }

  private engagementSection(window: ReportWindow): MetricSection {
    const alerts = this.alerts.listAlerts();
    const deliveries = this.alerts.listDeliveries();
    const activeAlerts = alerts.filter(
      (alert) => alert.status === 'ACTIVE' || alert.status === 'DISABLED',
    );
    const triggered = alerts.filter((alert) => alert.status === 'TRIGGERED');
    const deliveriesInWindow = deliveries.filter((delivery) =>
      withinWindow(window, delivery.lastAttemptAt ?? delivery.triggeredAt),
    );
    const referrals = this.users
      .listReferrals()
      .filter((referral) => withinWindow(window, referral.createdAt));
    // Phase 7 keeps the reward ledger *per identity*; there is no global reward list, so the count
    // is a bounded fold over the stored identities (in-memory map reads, §16 “batch, not per-row
    // network calls” — no external call is involved).
    const rewards = this.users
      .listUsers()
      .flatMap((user) => this.users.listRewards(user.id))
      .filter((reward) => reward.status === 'GRANTED');

    const trackingDisabled = !this.tracking.enabled;
    const verifiedJoins = trackingDisabled
      ? null
      : this.campaigns
          .listEvents()
          .filter(
            (event) =>
              event.type === 'CHANNEL_JOIN' &&
              withinWindow(window, event.occurredAt),
          ).length;

    const notes: string[] = [];

    if (trackingDisabled) {
      notes.push(
        'ردیابی کمپین خاموش است؛ عضویت تأییدشدهٔ کانال در این بازه اندازه‌گیری نمی‌شود (صفر واقعی نیست).',
      );
    } else if (this.config.campaignChannelJoinVerification === 'disabled') {
      notes.push(
        'تأیید عضویت کانال در تنظیمات خاموش است؛ عدد عضویت فقط از رویدادهای تأییدشدهٔ ثبت‌شده می‌آید و ممکن است صفر بماند.',
      );
    }

    return {
      key: 'engagement',
      titleFa: 'مشارکت و کانال',
      metrics: [
        metric(
          'channelJoins',
          'عضویت تأییدشدهٔ کانال',
          'TOTAL_EVENTS',
          verifiedJoins,
          trackingDisabled
            ? 'ردیابی کمپین خاموش است، پس رویداد عضویت هم ثبت نمی‌شود.'
            : null,
          'فاز ۸ — رویداد CHANNEL_JOIN (تنها تأییدشده)',
        ),
        metric(
          'alertsActive',
          'هشدارهای فعال/غیرفعال',
          'TOTAL_EVENTS',
          activeAlerts.length,
          null,
          'فاز ۳ — وضعیت ACTIVE/DISABLED',
        ),
        metric(
          'alertsTriggered',
          'هشدارهای فعال‌شده',
          'TOTAL_EVENTS',
          triggered.length,
          null,
          'فاز ۳ — وضعیت TRIGGERED',
        ),
        metric(
          'alertDeliveries',
          'اعلان هشدار در بازه',
          'TOTAL_EVENTS',
          deliveriesInWindow.length,
          null,
          `فاز ۳ — سوابق تحویل (ارسال‌شده: ${formatNumberFa(
            deliveriesInWindow.filter((delivery) => delivery.status === 'SENT')
              .length,
          )} · ناموفق: ${formatNumberFa(
            deliveriesInWindow.filter(
              (delivery) => delivery.status === 'FAILED',
            ).length,
          )} · در انتظار: ${formatNumberFa(
            deliveriesInWindow.filter(
              (delivery) => delivery.status === 'PENDING',
            ).length,
          )})`,
        ),
        metric(
          'referrals',
          'دعوت‌های موفق',
          'TOTAL_EVENTS',
          referrals.length,
          null,
          'فاز ۷ — ردیف دعوت (کاربر دعوت‌شدهٔ ثبت‌شده)',
        ),
        metric(
          'rewardGrants',
          'پاداش‌های اعمال‌شده',
          'TOTAL_EVENTS',
          rewards.length,
          null,
          'فاز ۷ — دفتر پاداش با وضعیت GRANTED',
        ),
      ],
      notes,
    };
  }

  private commercialSection(window: ReportWindow): MetricSection {
    const leads = this.sales.listLeads({ limit: 100, offset: 0 });
    const newLeads = this.sales
      .listLeads({ limit: 100, offset: 0 })
      .filter((lead) => withinWindow(window, lead.createdAt));
    const convertedInWindow = this.sales
      .listLeads({ limit: 100, offset: 0 })
      .filter((lead) => withinWindow(window, lead.customerConvertedAt));
    const outcomeRows = this.sales.listAllOutcomes();
    const salesInWindow = outcomeRows.filter(
      (outcome) =>
        outcome.outcomeType === 'SALE' &&
        outcome.status === 'ACTIVE' &&
        withinWindow(window, outcome.recordedAt),
    );
    const counts = this.sales.countByStatus();
    const totalLeads = this.sales.countLeads({});
    // Bounded read: the newest 100 rows are enough for the *new/converted in window* breakdown, and
    // the totals come from the service counters (§16 “never fetch all rows per render”).
    const boundedLeads = leads.length === 100 && totalLeads > 100;

    return {
      key: 'commercial',
      titleFa: 'سرنخ و فروش',
      metrics: [
        metric(
          'leadsTotal',
          'سرنخ‌های ثبت‌شده',
          'TOTAL_EVENTS',
          totalLeads,
          null,
          'فاز ۹ — درخواست‌های ذخیره‌شده',
        ),
        metric(
          'leadsNew',
          'سرنخ‌های تازه',
          'TOTAL_EVENTS',
          newLeads.length,
          boundedLeads
            ? 'برای عملکرد بهتر، شمارش «تازه» روی ۱۰۰ درخواست آخر محاسبه می‌شود؛ کل از شمارندهٔ کامل می‌آید.'
            : null,
          'فاز ۹ — createdAt داخل بازه',
        ),
        metric(
          'leadsOpen',
          'سرنخ‌های باز',
          'TOTAL_EVENTS',
          counts.NEW + counts.CONTACTED + counts.QUALIFIED,
          null,
          'فاز ۹ — وضعیت‌های NEW/CONTACTED/QUALIFIED',
        ),
        metric(
          'customersConverted',
          'تبدیل‌شده به مشتری',
          'TOTAL_EVENTS',
          counts.CONVERTED,
          null,
          `فاز ۹ — وضعیت CONVERTED (در بازه: ${formatNumberFa(
            convertedInWindow.length,
          )})`,
        ),
        metric(
          'salesRecorded',
          'فروش ثبت‌شده',
          'TOTAL_EVENTS',
          outcomeRows.filter(
            (outcome) =>
              outcome.outcomeType === 'SALE' && outcome.status === 'ACTIVE',
          ).length,
          null,
          `فاز ۹ — ردیف نتیجهٔ فروش ACTIVE (در بازه: ${formatNumberFa(salesInWindow.length)})`,
        ),
        metric(
          'leadsLost',
          'سرنخ‌های از‌دست‌رفته',
          'TOTAL_EVENTS',
          counts.LOST,
          null,
          'فاز ۹ — وضعیت LOST با دلیل مستند',
        ),
      ],
      notes: [],
    };
  }

  private reliabilitySection(window: ReportWindow): MetricSection {
    const jobs = this.publication.listJobs();
    const deliveries = jobs.flatMap((job) =>
      this.publication.listDeliveries(job.id),
    );
    const deliveriesInWindow = deliveries.filter((delivery) =>
      withinWindow(window, delivery.lastAttemptAt ?? delivery.createdAt),
    );
    const salesNotifications = this.salesNotifications.listNotifications();
    const salesNotificationsInWindow = salesNotifications.filter((record) =>
      withinWindow(window, record.updatedAt ?? record.createdAt),
    );
    const alertDeliveries = this.alerts
      .listDeliveries()
      .filter((delivery) =>
        withinWindow(window, delivery.lastAttemptAt ?? delivery.triggeredAt),
      );

    const failed = deliveriesInWindow.filter(
      (delivery) => delivery.status === 'FAILED',
    ).length;
    const unknown = deliveriesInWindow.filter(
      (delivery) => delivery.status === 'UNKNOWN',
    ).length;
    const pending = deliveriesInWindow.filter(
      (delivery) =>
        delivery.status === 'PENDING' || delivery.status === 'SENDING',
    ).length;
    const sent = deliveriesInWindow.filter(
      (delivery) => delivery.status === 'SENT',
    ).length;
    const salesFailed = salesNotificationsInWindow.filter(
      (record) =>
        record.status === 'FAILED' || record.status === 'UNDELIVERABLE',
    ).length;
    const alertFailed = alertDeliveries.filter(
      (delivery) => delivery.status === 'FAILED',
    ).length;
    const pendingJobs = jobs.filter(
      (job) => job.status === 'PENDING' || job.status === 'PUBLISHING',
    ).length;
    const pendingNotifications =
      this.alertNotifications.pendingCount +
      this.salesNotifications.pendingCount;

    const occurrences = this.errors.occurrencesIn(window.from, window.to);
    const breakdown = this.errors.occurrenceBreakdown(window.from, window.to);
    const openIncidents = this.errors.openCount();

    return {
      key: 'reliability',
      titleFa: 'پایداری و تحویل',
      metrics: [
        metric(
          'apiErrors',
          'خطاهای ثبت‌شدهٔ سرویس‌ها',
          'TOTAL_EVENTS',
          occurrences,
          null,
          'فاز ۱۰ — رکورد رویدادهای عملیاتی (مجموع رخدادها در بازه)',
        ),
        metric(
          'openIncidents',
          'رویدادهای باز (کل سامانه)',
          'TOTAL_EVENTS',
          openIncidents,
          null,
          'فاز ۱۰ — وضعیت OPEN بدون توجه به بازه',
        ),
        metric(
          'channelDeliveriesSent',
          'ارسال تأییدشدهٔ کانال (بازه)',
          'TOTAL_EVENTS',
          sent,
          null,
          'فاز ۵ — سوابق تحویل با وضعیت SENT',
        ),
        metric(
          'channelDeliveriesFailed',
          'خطای تحویل کانال (بازه)',
          'TOTAL_EVENTS',
          failed,
          null,
          'فاز ۵ — وضعیت FAILED (تلاش‌های تازه در همین بازه)',
        ),
        metric(
          'channelDeliveriesUnknown',
          'نتیجهٔ نامعلوم کانال (بازه)',
          'TOTAL_EVENTS',
          unknown,
          null,
          'فاز ۵ — پلتفرم پاسخ نداد؛ نه موفق و نه ناموفق شمرده می‌شود',
        ),
        metric(
          'deliveryPending',
          'عملیات در انتظار/در حال ارسال',
          'TOTAL_EVENTS',
          pending,
          null,
          'فاز ۵ — وضعیت PENDING/SENDING در بازه',
        ),
        metric(
          'deliveryErrors',
          'خطای تحویل (اعلان‌ها)',
          'TOTAL_EVENTS',
          salesFailed + alertFailed,
          null,
          `فاز ۳/۹ — اعلان هشدار ناموفق: ${formatNumberFa(
            alertFailed,
          )} · اعلان سرنخ ناموفق/ناموفق-قطعی: ${formatNumberFa(salesFailed)}`,
        ),
        metric(
          'pendingJobs',
          'کارهای انتشار در انتظار',
          'TOTAL_EVENTS',
          pendingJobs,
          null,
          'فاز ۵ — وضعیت PENDING/PUBLISHING (بدون توجه به بازه)',
        ),
        metric(
          'pendingNotifications',
          'اعلان‌های در انتظار ارسال',
          'TOTAL_EVENTS',
          pendingNotifications,
          null,
          'فاز ۳/۹ — صف اعلان (بدون توجه به بازه)',
        ),
      ],
      notes: [
        breakdown.length > 0
          ? `بیشترین رخدادها: ${breakdown
              .slice(0, 3)
              .map(
                (row) => `${row.source} (${formatNumberFa(row.occurrences)})`,
              )
              .join(' · ')}`
          : 'در این بازه رویداد عملیاتی ثبت نشده است.',
        '«پذیرش پلتفرم» با «تحویل تأییدشده» یکی نیست؛ عدد بالا فقط نتیجهٔ واقعی ثبت‌شده را می‌شمارد.',
      ],
    };
  }

  // --- system health (§4.4) -------------------------------------------------------

  /**
   * Health facts, each read from a real signal. A signal that does not exist is reported as
   * **unknown** — never as healthy (§4.4).
   */
  systemHealth(
    now: Date = new Date(),
  ): { labelFa: string; valueFa: string; ok: boolean | null }[] {
    const rows: { labelFa: string; valueFa: string; ok: boolean | null }[] = [];

    // Market data freshness is a Phase 1 fact (validated state + its own freshness rule).
    const market = this.marketFreshness(now);

    if (market) {
      const ageMinutes = Math.max(
        0,
        Math.round((now.getTime() - market.lastUpdate.getTime()) / 60_000),
      );
      const stale = ageMinutes > this.config.staleAfterMs / 60_000;

      rows.push({
        labelFa: 'آخرین قیمت معتبر',
        valueFa: `${formatNumberFa(ageMinutes)} دقیقه پیش${
          stale ? ' (کهنه)' : market.freshness === 'UNKNOWN' ? ' (نامشخص)' : ''
        }`,
        ok: !stale && market.freshness !== 'UNKNOWN',
      });
    } else {
      rows.push({
        labelFa: 'آخرین قیمت معتبر',
        valueFa: 'نامشخص (هیچ وضعیت معتبری ذخیره نشده)',
        ok: null,
      });
    }

    const jobs = this.publication.listJobs();
    const lastJob = [...jobs].sort((left, right) =>
      (right.completedAt ?? right.createdAt).localeCompare(
        left.completedAt ?? left.createdAt,
      ),
    )[0];

    if (lastJob) {
      const deliveries = this.publication.listDeliveries(lastJob.id);
      const sent = deliveries.filter(
        (delivery) => delivery.status === 'SENT',
      ).length;
      const failedDeliveries = deliveries.filter(
        (delivery) => delivery.status === 'FAILED',
      ).length;

      rows.push({
        labelFa: 'آخرین انتشار کانال',
        valueFa: `${lastJob.status} · ${formatNumberFa(sent)} موفق / ${formatNumberFa(
          failedDeliveries,
        )} ناموفق`,
        ok: lastJob.status === 'PUBLISHED',
      });
    } else {
      rows.push({
        labelFa: 'آخرین انتشار کانال',
        valueFa: 'هنوز انتشاری ثبت نشده است',
        ok: null,
      });
    }

    rows.push({
      labelFa: 'اعلان‌های در انتظار',
      valueFa: formatNumberFa(
        this.alertNotifications.pendingCount +
          this.salesNotifications.pendingCount,
      ),
      ok: true,
    });

    rows.push({
      labelFa: 'رویدادهای باز',
      valueFa: formatNumberFa(this.errors.openCount()),
      ok: this.errors.openCount() === 0,
    });

    rows.push({
      labelFa: 'بازهٔ رخدادهای عملیاتی',
      valueFa:
        `${formatNumberFa(this.errors.totalIncidents)} رویداد ذخیره‌شده · ` +
        `${formatNumberFa(this.errors.prunedCounters.incidents)} رکورد پاک‌شده با سیاست نگه‌داشت`,
      ok: true,
    });

    rows.push({
      labelFa: 'وضعیت ذخیره‌سازی',
      valueFa:
        this.users.path === null
          ? '«بدون فایل» (حالت حافظه‌ای) — داده‌ای روی دیسک نمی‌ماند'
          : 'فایل‌های سند فعال',
      ok: this.users.path === null ? false : true,
    });

    // --- Phase 11: monitoring evidence (jobs, outbox, destination) -----------------
    const snapshot = this.monitoring.snapshotSync(now);

    rows.push({
      labelFa: 'پایش عملیاتی',
      valueFa: snapshot.enabled
        ? `فعال · ${formatNumberFa(snapshot.openIncidents)} رخداد باز (${formatNumberFa(
            snapshot.criticalIncidents,
          )} بحرانی)`
        : 'خاموش (MONITORING_ENABLED=false)',
      ok: snapshot.enabled ? snapshot.criticalIncidents === 0 : null,
    });

    rows.push({
      labelFa: 'اطلاع‌رسانی پایش',
      valueFa: snapshot.notificationDestination.configured
        ? `مقصد تنظیم شده · ${formatNumberFa(snapshot.notifications.pending)} در انتظار · ` +
          `${formatNumberFa(snapshot.notifications.retryPending)} تلاش دوباره · ` +
          `${formatNumberFa(snapshot.notifications.failed)} ناموفق · ` +
          `${formatNumberFa(snapshot.notifications.unknown)} نامعلوم`
        : `بدون مقصد — ${snapshot.notificationDestination.reason ?? 'تنظیم نشده'}`,
      ok: snapshot.notificationDestination.configured
        ? snapshot.notifications.failed === 0 &&
          snapshot.notifications.unknown === 0
        : null,
    });

    if (snapshot.jobs.length > 0) {
      const failed = snapshot.jobs.filter(
        (job) => job.status === 'FAILED',
      ).length;
      const missed = snapshot.jobs.filter(
        (job) => job.status === 'MISSED',
      ).length;

      rows.push({
        labelFa: 'کارهای زمان‌بندی‌شده',
        valueFa:
          `${formatNumberFa(snapshot.jobs.length)} کار ثبت‌شده · ` +
          `${formatNumberFa(failed)} ناموفق · ${formatNumberFa(missed)} اجرانشده`,
        ok: failed === 0 && missed === 0,
      });
    }

    return rows;
  }

  /**
   * Freshness of the market data, read from Phase 1's own state service: the *most recent* accepted
   * update across the configured symbols. `null` when no symbol ever committed a price — which is
   * reported as unknown, not as healthy (§4.4).
   */
  private marketFreshness(
    now: Date,
  ): { lastUpdate: Date; freshness: string } | null {
    let latest: Date | null = null;
    let freshness = 'UNKNOWN';

    for (const definition of this.config.symbolRegistry) {
      const state = this.marketState.getState(definition, now);

      if (!state) {
        continue;
      }

      const at = new Date(state.lastSuccessfulUpdate);

      if (Number.isFinite(at.getTime()) && (latest === null || at > latest)) {
        latest = at;
        freshness = state.freshness;
      }
    }

    return latest === null ? null : { lastUpdate: latest, freshness };
  }

  /** Labels of the presets, for the filter buttons. */
  get periodLabels(): Record<ReportPeriodPreset, string> {
    return PERIOD_LABELS_FA;
  }

  /** “Yesterday” comparison window, used only where a real previous period exists (§4.2). */
  previousWindow(window: ReportWindow): ReportWindow | null {
    if (window.preset === 'all') {
      return null;
    }

    const spanDays =
      Math.round(
        (Date.parse(window.to) - Date.parse(window.from)) / (24 * 60 * 60_000),
      ) || 1;
    const fromDayKey = shiftDayKey(window.fromDayKey, -spanDays);

    return {
      preset: window.preset,
      from: new Date(
        Date.parse(window.from) - spanDays * 24 * 60 * 60_000,
      ).toISOString(),
      to: window.from,
      labelFa: `بازهٔ پیش از ${window.labelFa}`,
      fromDayKey,
      toDayKey: shiftDayKey(window.toDayKey, -spanDays),
    };
  }
}

function metric(
  key: string,
  labelFa: string,
  kind: MetricValue['kind'],
  value: number | null,
  unavailableReason: string | null,
  source: string,
): MetricValue {
  return {
    key,
    labelFa,
    kind,
    value,
    unavailableReason,
    source,
    detail: [],
  };
}

/**
 * Phase 10 — Persian rendering of the administrative screens.
 *
 * Pure functions only: they receive data that was already read from the authoritative stores and turn
 * it into text. No screen reaches a store, a platform or a clock on its own, which is what makes the
 * output testable and keeps the “never fabricate” rule enforceable in one place (§2.3, §14).
 *
 * Three presentation rules are applied everywhere:
 *
 *  * a metric that cannot be measured prints **«نامشخص» plus the reason**, never `0`;
 *  * every metric prints its **source**, so a number can always be traced to the phase that owns it;
 *  * personal data is masked by default (`maskChatId`), and only operations that genuinely need a
 *    value reveal it (§5.2).
 */

import { formatMoney } from '../common/money';
import { formatPhoneFa } from '../sales/phone';
import { escapeHtml } from '../common/html';
import {
  AuditRecord,
  BroadcastJob,
  BroadcastRecipient,
  IncidentRecord,
  IncidentSeverity,
  IncidentStatus,
  MetricSection,
  MetricValue,
  ReportWindow,
} from './admin.types';
import { PERIOD_LABELS_FA } from './admin-period';
import { METRIC_DICTIONARY } from './admin-metrics.service';

const STATUS_TITLES: Record<IncidentStatus, string> = {
  OPEN: 'باز',
  REVIEWED: 'بررسی‌شده',
  RESOLVED: 'رفع‌شده',
};

const SEVERITY_TITLES: Record<IncidentSeverity, string> = {
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  CRITICAL: 'بحرانی',
};

const BROADCAST_STATUS_TITLES: Record<BroadcastJob['status'], string> = {
  PREPARED: 'آماده (ارسال نشده)',
  RUNNING: 'در حال ارسال',
  COMPLETED: 'پایان‌یافته',
  CANCELLED: 'لغو‌شده',
  FAILED: 'ناموفق',
};

// --- generic helpers ------------------------------------------------------------

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }

  return new Intl.NumberFormat('fa-IR').format(value);
}

/** Mask a chat id / platform id: enough to recognize a record, never enough to contact somebody. */
export function maskId(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const trimmed = String(value);

  if (trimmed.length <= 4) {
    return '∗'.repeat(trimmed.length);
  }

  return `${trimmed.slice(0, 2)}${'∗'.repeat(Math.max(2, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

export function maskChatId(chatId: string | null | undefined): string {
  return maskId(chatId);
}

export function formatTimestampFa(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }

  const date = new Date(iso);

  if (!Number.isFinite(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatRelativeFa(
  iso: string | null | undefined,
  now = new Date(),
): string {
  if (!iso) {
    return '—';
  }

  const at = Date.parse(iso);

  if (!Number.isFinite(at)) {
    return '—';
  }

  const minutes = Math.round((now.getTime() - at) / 60_000);

  if (minutes < 1) {
    return 'همین حالا';
  }

  if (minutes < 60) {
    return `${num(minutes)} دقیقه پیش`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${num(hours)} ساعت پیش`;
  }

  return `${num(Math.round(hours / 24))} روز پیش`;
}

/** `value` or an explicit «نامشخص» with its reason — the single rule behind every metric line. */
export function metricLine(metric: MetricValue): string {
  const value =
    metric.value === null
      ? `⚠️ نامشخص — ${escapeHtml(metric.unavailableReason ?? 'داده کافی نیست')}`
      : num(metric.value);

  return (
    `• <b>${escapeHtml(metric.labelFa)}</b>: ${value}\n` +
    `   <i>منبع: ${escapeHtml(metric.source)}</i>`
  );
}

// --- 1. hub + health (§3, §4.4) --------------------------------------------------

export function formatAdminHubScreen(input: {
  owners: string[];
  admins: string[];
  broadcastEnabled: boolean;
  activeBroadcasts: number;
  openIncidents: number;
  lastAuditAt: string | null;
}): string {
  return (
    '⚙️ <b>پنل مدیریت اتابک</b>\n\n' +
    'این پنل فقط خواندنی نیست: هر عملیات از سرویس همان فاز (قیمت، هشدار، انتشار، کمپین، سرنخ) ' +
    'انجام می‌شود و در رخدادنگار ثبت می‌شود.\n\n' +
    `👑 مالکان: ${input.owners.length > 0 ? escapeHtml(input.owners.join('، ')) : '—'}\n` +
    `🛡 مدیران: ${input.admins.length > 0 ? escapeHtml(input.admins.join('، ')) : '—'}\n` +
    `📨 ارسال گروهی: ${input.broadcastEnabled ? 'فعال' : 'خاموش (ADMIN_BROADCAST_ENABLED=false)'}\n` +
    `🚨 رویدادهای باز: ${num(input.openIncidents)}\n` +
    `📤 ارسال گروهی در جریان: ${num(input.activeBroadcasts)}\n` +
    `🧾 آخرین اقدام مدیریتی: ${formatRelativeFa(input.lastAuditAt)}\n\n` +
    'هر ورودی زیر یک صفحهٔ واقعی دارد؛ اگر داده‌ای وجود نداشته باشد همان نوشته می‌شود.'
  );
}

export function formatHealthScreen(
  rows: { labelFa: string; valueFa: string; ok: boolean | null }[],
  window: ReportWindow,
): string {
  const lines = rows.map((row) => {
    const mark = row.ok === null ? '⚠️' : row.ok ? '✅' : '❌';

    return `${mark} <b>${escapeHtml(row.labelFa)}</b>: ${escapeHtml(row.valueFa)}`;
  });

  return (
    '🩺 <b>سلامت سامانه</b>\n\n' +
    `${lines.join('\n')}\n\n` +
    `🗓 بازهٔ گزارش: ${escapeHtml(window.labelFa)} (${escapeHtml(window.fromDayKey)} تا ` +
    `${escapeHtml(window.toDayKey)})\n` +
    '<i>«نامشخص» یعنی سیگنالی برای سنجش وجود ندارد؛ هرگز به‌معنای سالم بودن نیست.</i>'
  );
}

export function formatMetricDictionaryScreen(): string {
  const lines = METRIC_DICTIONARY.map(
    (entry) =>
      `• <b>${escapeHtml(entry.labelFa)}</b> (<code>${escapeHtml(entry.key)}</code>)\n` +
      `   منبع: ${escapeHtml(entry.source)}\n` +
      `   معنی: ${escapeHtml(entry.semantics)}`,
  );

  return (
    '📚 <b>تعریف شاخص‌ها</b>\n\n' +
    `${lines.join('\n\n')}\n\n` +
    '<i>هر عدد روی صفحه‌ها به همین تعریف‌ها گره خورده است؛ شاخص بدون منبع وجود ندارد.</i>'
  );
}

// --- 2. dashboard (§4) -----------------------------------------------------------

export function formatDashboardSection(
  section: MetricSection,
  window: ReportWindow,
  index: number,
  total: number,
  allTimeWindow: ReportWindow,
): string {
  const periodNote =
    window.preset === 'all'
      ? '<i>بازه: از ابتدا (همهٔ داده‌های ثبت‌شده)</i>'
      : `<i>بازه: ${escapeHtml(window.labelFa)} — ${escapeHtml(
          window.fromDayKey,
        )} تا ${escapeHtml(window.toDayKey)} (روز پایان شامل می‌شود)</i>`;

  const fromNote =
    window.preset === 'all'
      ? ''
      : `<i>برای مقایسه، «از ابتدا» یعنی از ${escapeHtml(allTimeWindow.fromDayKey)}.</i>\n`;

  const notes = section.notes.length
    ? `\n${section.notes.map((note) => `ℹ️ ${escapeHtml(note)}`).join('\n')}`
    : '';

  return (
    `📊 <b>${escapeHtml(section.titleFa)}</b> (${num(index + 1)}/${num(total)})\n\n` +
    `${periodNote}\n${fromNote}\n` +
    `${section.metrics.map(metricLine).join('\n\n')}${notes}`
  );
}

// --- 3. users (§5) ---------------------------------------------------------------

export function formatAdminUsersListScreen(input: {
  rows: {
    userId: string;
    platform: string;
    createdAt: string;
    lastInteractionAt: string | null;
    isNew: boolean;
    alerts: number;
    referrals: number;
    leads: number;
  }[];
  page: number;
  pageCount: number;
  total: number;
  filterLabel: string;
  query: string | null;
  now?: Date;
}): string {
  if (input.rows.length === 0) {
    return (
      '👥 <b>کاربران</b>\n\n' +
      `فیلتر: ${escapeHtml(input.filterLabel)}\n` +
      (input.query ? `جست‌وجو: «${escapeHtml(input.query)}»\n` : '') +
      '\nهیچ کاربری با این شرط پیدا نشد.'
    );
  }

  const lines = input.rows.map(
    (row) =>
      `• <code>${escapeHtml(row.userId)}</code> · ${escapeHtml(row.platform)} ` +
      `${row.isNew ? '🆕' : ''}\n` +
      `   عضویت: ${formatTimestampFa(row.createdAt)} · آخرین فعالیت: ${formatRelativeFa(
        row.lastInteractionAt,
        input.now,
      )}\n` +
      `   هشدار: ${num(row.alerts)} · دعوت: ${num(row.referrals)} · سرنخ: ${num(row.leads)}`,
  );

  return (
    '👥 <b>کاربران</b>\n\n' +
    `فیلتر: ${escapeHtml(input.filterLabel)}` +
    (input.query ? ` · جست‌وجو: «${escapeHtml(input.query)}»` : '') +
    '\n' +
    `مجموع: ${num(input.total)} · صفحه ${num(input.page)} از ${num(input.pageCount)}\n\n` +
    lines.join('\n\n') +
    '\n\n<i>هر ردیف یک هویت پلتفرمی است؛ هویت‌های بله و تلگرام هرگز ادغام نمی‌شوند.</i>'
  );
}

export function formatAdminUserDetailScreen(input: {
  userId: string;
  platform: string;
  platformUserId: string;
  chatId: string | null;
  createdAt: string;
  lastInteractionAt: string | null;
  referralCode: string | null;
  activityDays: string[];
  alerts: { total: number; active: number; triggered: number };
  referrals: { successful: number; grantedRewards: number };
  leads: { total: number; open: number };
  notificationDestinations: number;
}): string {
  return (
    `👤 <b>کاربر</b> <code>${escapeHtml(input.userId)}</code>\n\n` +
    `🛰 پلتفرم: ${escapeHtml(input.platform)}\n` +
    `🆔 شناسهٔ پلتفرمی: ${escapeHtml(maskId(input.platformUserId))}\n` +
    `💬 گفت‌وگوی قابل‌ارسال: ${input.chatId ? escapeHtml(maskChatId(input.chatId)) : 'ثبت نشده'}\n` +
    `🗓 نخستین ثبت: ${formatTimestampFa(input.createdAt)}\n` +
    `⏱ آخرین فعالیت: ${formatRelativeFa(input.lastInteractionAt)}\n` +
    `📆 روزهای فعالیت ثبت‌شده: ${num(input.activityDays.length)}\n` +
    `🎟 کد دعوت: ${input.referralCode ? `<code>${escapeHtml(input.referralCode)}</code>` : '—'}\n\n` +
    `🔔 هشدارها: ${num(input.alerts.total)} (فعال: ${num(input.alerts.active)} · فعال‌شده: ` +
    `${num(input.alerts.triggered)})\n` +
    `👥 دعوت‌ها: ${num(input.referrals.successful)} (پاداش اعمال‌شده: ` +
    `${num(input.referrals.grantedRewards)})\n` +
    `🛒 سرنخ‌ها: ${num(input.leads.total)} (باز: ${num(input.leads.open)})\n\n` +
    '<i>شناسه‌ها ماسک شده‌اند؛ این صفحه هیچ شمارهٔ تماس یا دادهٔ شخصی ذخیره‌شده‌ای را نمایش ' +
    'نمی‌دهد. عملیات روی کاربر فقط از مسیر قوانین موجود (هشدارها و سرنخ‌ها) انجام می‌شود و ' +
    'حذف یک‌کلیکی وجود ندارد.</i>'
  );
}

// --- 4. channels (§6) ------------------------------------------------------------

export function formatChannelsScreen(input: {
  publishingEnabled: boolean;
  configuredPlatforms: string[];
  destinations: { platform: string; destination: string; key: string }[];
  window: ReportWindow;
  deliveries: {
    sent: number;
    failed: number;
    unknown: number;
    attempts: number;
  };
  lastDelivery: {
    platform: string;
    status: string;
    externalMessageId: string | null;
    at: string | null;
    error: string | null;
  } | null;
  retryState: { pending: number; publishing: number; failed: number };
  recentFailures: { destination: string; error: string; at: string | null }[];
  windowDeliveries: number;
}): string {
  const destinations = input.destinations.length
    ? input.destinations
        .map(
          (destination, index) =>
            `${num(index + 1)}. ${escapeHtml(destination.platform)} → ` +
            `<code>${escapeHtml(maskId(destination.destination))}</code> ` +
            `(کلید مسیر: ${escapeHtml(destination.key)})`,
        )
        .join('\n')
    : 'هیچ مقصدی تنظیم نشده است.';

  const last = input.lastDelivery;

  const failures = input.recentFailures.length
    ? input.recentFailures
        .map(
          (failure) =>
            `• ${escapeHtml(failure.destination)} — ${escapeHtml(failure.error)} ` +
            `(${formatRelativeFa(failure.at)})`,
        )
        .join('\n')
    : 'خطای تازه‌ای ثبت نشده است.';

  return (
    '📢 <b>کانال‌ها و انتشار</b>\n\n' +
    `وضعیت انتشار: ${input.publishingEnabled ? '✅ فعال' : '⛔️ غیرفعال'}\n` +
    `پلتفرم‌های پیکربندی‌شده: ${input.configuredPlatforms.length ? escapeHtml(input.configuredPlatforms.join('، ')) : '—'}\n\n` +
    `🎯 مقصدها:\n${destinations}\n\n` +
    `📤 تحویل در ${escapeHtml(input.window.labelFa)}: ` +
    `${num(input.windowDeliveries)} رکورد · تلاش: ${num(input.deliveries.attempts)} · ` +
    `تأییدشده: ${num(input.deliveries.sent)} · ناموفق: ${num(input.deliveries.failed)} · ` +
    `نامعلوم: ${num(input.deliveries.unknown)}\n` +
    (last
      ? `🕐 آخرین تحویل: ${escapeHtml(last.platform)} · ${escapeHtml(last.status)} · ` +
        `${formatRelativeFa(last.at)}\n` +
        `   شناسهٔ پیام: ${last.externalMessageId ? `<code>${escapeHtml(maskId(last.externalMessageId))}</code>` : 'ثبت نشده'}\n` +
        (last.error ? `   خطا: ${escapeHtml(last.error)}\n` : '')
      : '🕐 هنوز تحویلی ثبت نشده است.\n') +
    `\n♻️ وضعیت تلاش دوباره: در انتظار ${num(input.retryState.pending)} · در حال ارسال ` +
    `${num(input.retryState.publishing)} · ناموفق ${num(input.retryState.failed)}\n\n` +
    `⚠️ آخرین خطاها:\n${failures}\n\n` +
    '<i>«تأییدشده» یعنی پلتفرم پذیرفت (شناسهٔ پیام ثبت شده)؛ «نامعلوم» یعنی پاسخ نرسید و ' +
    'هیچ‌گاه دوباره ارسال نمی‌شود. هیچ توکن یا رمزی در این صفحه نمایش داده نمی‌شود.</i>'
  );
}

// --- 5. alerts (§7) --------------------------------------------------------------

export function formatAdminAlertsList(input: {
  rows: {
    alertId: string;
    userRef: string;
    platform: string;
    status: string;
    summary: string;
    createdAt: string;
  }[];
  page: number;
  pageCount: number;
  total: number;
  filterLabel: string;
  window: ReportWindow;
  windowCreated: number;
  deliveries: { sent: number; pending: number; failed: number };
}): string {
  const lines = input.rows.length
    ? input.rows
        .map(
          (row) =>
            `• <code>${escapeHtml(row.alertId)}</code> · ${escapeHtml(row.status)} · ` +
            `${escapeHtml(row.platform)}\n` +
            `   ${escapeHtml(row.summary)}\n` +
            `   کاربر: <code>${escapeHtml(row.userRef)}</code> · ایجاد: ` +
            `${formatTimestampFa(row.createdAt)}`,
        )
        .join('\n\n')
    : 'هیچ هشداری با این شرط وجود ندارد.';

  return (
    '🔔 <b>هشدارها (فاز ۳)</b>\n\n' +
    `فیلتر: ${escapeHtml(input.filterLabel)} · مجموع: ${num(input.total)} · صفحه ${num(
      input.page,
    )} از ${num(input.pageCount)}\n` +
    `ایجادشده در ${escapeHtml(input.window.labelFa)}: ${num(input.windowCreated)} · ` +
    `اعلان‌ها: تأییدشده ${num(input.deliveries.sent)} · در انتظار ${num(
      input.deliveries.pending,
    )} · ناموفق ${num(input.deliveries.failed)}\n\n` +
    `${lines}\n\n` +
    '<i>این صفحه فقط نمایش و «فعال/غیرفعال کردن» است؛ ساخت و ویرایش هشدار همچنان در فاز ۳ و ' +
    'از سمت خود کاربر انجام می‌شود. ظرفیت هشدار و اسلات‌های پاداش فاز ۷ دست‌نخورده می‌مانند.</i>'
  );
}

export function formatAdminAlertDetail(input: {
  alertId: string;
  ownerRef: string;
  platform: string;
  status: string;
  createdLabel: string;
  conditionLabel: string;
  effectiveCapacity: number;
  usedCapacity: number;
  deliveries: { total: number; sent: number; pending: number; failed: number };
  lastDelivery: {
    status: string;
    at: string | null;
    error: string | null;
  } | null;
}): string {
  return (
    `🔔 <b>هشدار</b> <code>${escapeHtml(input.alertId)}</code>\n\n` +
    `مالک: <code>${escapeHtml(input.ownerRef)}</code> · پلتفرم: ${escapeHtml(input.platform)}\n` +
    `وضعیت: ${escapeHtml(input.status)} · ایجاد: ${formatTimestampFa(input.createdLabel)}\n` +
    `شرط: ${escapeHtml(input.conditionLabel)}\n\n` +
    `ظرفیت مؤثر: ${num(input.effectiveCapacity)} · مصرف‌شده: ${num(input.usedCapacity)}\n` +
    `اعلان‌ها: مجموع ${num(input.deliveries.total)} · تأییدشده ${num(
      input.deliveries.sent,
    )} · در انتظار ${num(input.deliveries.pending)} · ناموفق ${num(
      input.deliveries.failed,
    )}\n` +
    (input.lastDelivery
      ? `آخرین تلاش: ${escapeHtml(input.lastDelivery.status)} — ${formatRelativeFa(
          input.lastDelivery.at,
        )}${input.lastDelivery.error ? ` (${escapeHtml(input.lastDelivery.error)})` : ''}\n`
      : 'هنوز اعلانی برای این هشدار ثبت نشده است.\n') +
    '\n<i>هر عملیات از سرویس هشدار فاز ۳ انجام می‌شود؛ مالکیت و ظرفیت همیشه سرور-ساید بررسی می‌شود.</i>'
  );
}

// --- 6. leads (§8) ---------------------------------------------------------------

export function formatAdminLeadsList(input: {
  rows: {
    leadId: string;
    reference: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    identityRef: string | null;
  }[];
  page: number;
  pageCount: number;
  total: number;
  counts: {
    NEW: number;
    CONTACTED: number;
    QUALIFIED: number;
    CONVERTED: number;
    LOST: number;
  };
  filterLabel: string;
}): string {
  const lines = input.rows.length
    ? input.rows
        .map(
          (row) =>
            `• <code>${escapeHtml(row.reference)}</code> · ${escapeHtml(row.status)}\n` +
            `   کاربر: ${row.identityRef ? `<code>${escapeHtml(row.identityRef)}</code>` : '—'}` +
            ` · ثبت: ${formatTimestampFa(row.createdAt)}` +
            ` · آخرین تغییر: ${formatRelativeFa(row.updatedAt)}`,
        )
        .join('\n\n')
    : 'سرنخی با این شرط وجود ندارد.';

  return (
    '🛒 <b>سرنخ‌های فروش (فاز ۹)</b>\n\n' +
    `فیلتر: ${escapeHtml(input.filterLabel)} · مجموع: ${num(input.total)} · صفحه ${num(
      input.page,
    )} از ${num(input.pageCount)}\n` +
    `وضعیت‌ها: جدید ${num(input.counts.NEW)} · تماس‌گرفته ${num(
      input.counts.CONTACTED,
    )} · واجد شرط ${num(input.counts.QUALIFIED)} · مشتری ${num(
      input.counts.CONVERTED,
    )} · از‌دست‌رفته ${num(input.counts.LOST)}\n\n` +
    `${lines}\n\n` +
    '<i>این صفحه فقط نمایش و ارجاع است: همهٔ عملیات سرنخ (تغییر وضعیت، تماس، تبدیل، ثبت فروش) ' +
    'از همان صفحهٔ فاز ۹ انجام می‌شود تا تاریخچه و رخدادنگار یکپارچه بماند.</i>'
  );
}

// --- 7. campaigns (§9) -----------------------------------------------------------

export function formatAdminCampaignsList(input: {
  rows: {
    campaignId: string;
    name: string;
    status: string;
    active: boolean;
    createdAt: string;
    destination: string;
  }[];
  page: number;
  pageCount: number;
  total: number;
  trackingEnabled: boolean;
  window: ReportWindow;
  aggregate: {
    campaigns: number;
    clicks: number;
    starts: number;
    verifiedJoins: number;
  };
}): string {
  const lines = input.rows.length
    ? input.rows
        .map(
          (row) =>
            `• <b>${escapeHtml(row.name)}</b> (<code>${escapeHtml(row.campaignId)}</code>)\n` +
            `   وضعیت: ${escapeHtml(row.status)}${row.active ? ' · فعال' : ''} · مسیر: ` +
            `${escapeHtml(row.destination)} · ایجاد: ${formatTimestampFa(row.createdAt)}`,
        )
        .join('\n\n')
    : 'هیچ کمپینی ثبت نشده است.';

  return (
    '📈 <b>کمپین‌ها (فاز ۸)</b>\n\n' +
    `ردیابی: ${input.trackingEnabled ? '✅ فعال' : '⛔️ خاموش'} · مجموع: ${num(
      input.total,
    )} · صفحه ${num(input.page)} از ${num(input.pageCount)}\n` +
    `در ${escapeHtml(input.window.labelFa)}: کمپین ${num(input.aggregate.campaigns)} · ` +
    `کلیک ${num(input.aggregate.clicks)} · شروع ${num(input.aggregate.starts)} · ` +
    `عضویت تأییدشده ${num(input.aggregate.verifiedJoins)}\n\n` +
    `${lines}\n\n` +
    '<i>همهٔ اعداد از گزارش رسمی فاز ۸ خوانده می‌شوند. «عضویت تأییدشده» فقط از پاسخ واقعی ' +
    'پلتفرم می‌آید و در پلتفرمی که پاسخ نمی‌دهد «نامشخص» می‌ماند. هزینه‌ها با واحد پول متفاوت ' +
    'هرگز جمع نمی‌شوند.</i>'
  );
}

export function formatCampaignFunnelScreen(input: {
  campaignId: string;
  name: string;
  window: ReportWindow;
  stages: {
    key: string;
    labelFa: string;
    value: number | null;
    unavailableReason: string | null;
  }[];
  notes: string[];
}): string {
  const lines = input.stages.map((stage) => {
    const value =
      stage.value === null
        ? `⚠️ نامشخص${stage.unavailableReason ? ` — ${escapeHtml(stage.unavailableReason)}` : ''}`
        : num(stage.value);

    return `• ${escapeHtml(stage.labelFa)}: ${value}`;
  });

  return (
    `🚀 <b>قیف کمپین</b> ${escapeHtml(input.name)} (<code>${escapeHtml(
      input.campaignId,
    )}</code>)\n\n` +
    `<i>بازه: ${escapeHtml(input.window.labelFa)}</i>\n` +
    `${lines.join('\n')}\n\n` +
    (input.notes.length
      ? `${input.notes.map((note) => `ℹ️ ${escapeHtml(note)}`).join('\n')}\n\n`
      : '') +
    '<i>هر مرحله فقط با منبع معتبر خودش شمرده می‌شود: نمایش، کلیک (خام و یکتای انسانی)، شروع، ' +
    'عضویت تأییدشده، ساخت هشدار، سرنخ و مشتری. مرحله‌ای که منبعش موجود نیست «نامشخص» است و ' +
    'به‌جای آن صفر یا درصد ساختگی نمایش داده نمی‌شود.</i>'
  );
}

// --- 8. error center (§10) -------------------------------------------------------

export function formatIncidentsScreen(input: {
  rows: IncidentRecord[];
  page: number;
  pageCount: number;
  total: number;
  filterLabel: string;
  openBySeverity: { severity: IncidentSeverity; count: number }[];
  sources: { source: string; incidents: number; occurrences: number }[];
  pruned: { incidents: number; incidentOccurrences: number };
}): string {
  const lines = input.rows.length
    ? input.rows
        .map(
          (incident) =>
            `• <code>${escapeHtml(incident.incidentId)}</code> · ` +
            `${escapeHtml(STATUS_TITLES[incident.status])} · ` +
            `شدت ${escapeHtml(SEVERITY_TITLES[incident.severity])}\n` +
            `   ${escapeHtml(incident.summary)}\n` +
            `   منبع: ${escapeHtml(incident.source)}/${escapeHtml(incident.category)} · ` +
            `رخداد: ${num(incident.occurrences)} · آخرین: ${formatRelativeFa(incident.lastSeenAt)}` +
            (incident.retryable ? ' · ♻️ قابل تلاش دوباره' : ''),
        )
        .join('\n\n')
    : 'رویدادی با این شرط وجود ندارد.';

  const severity = input.openBySeverity.length
    ? input.openBySeverity
        .map((row) => `${SEVERITY_TITLES[row.severity]}: ${num(row.count)}`)
        .join(' · ')
    : '—';

  const sources = input.sources.length
    ? input.sources
        .slice(0, 5)
        .map((row) => `${row.source} (${num(row.occurrences)})`)
        .join(' · ')
    : '—';

  return (
    '🚨 <b>مرکز خطا و رویدادها</b>\n\n' +
    `فیلتر: ${escapeHtml(input.filterLabel)} · مجموع: ${num(input.total)} · صفحه ${num(
      input.page,
    )} از ${num(input.pageCount)}\n` +
    `رویدادهای باز بر اساس شدت: ${escapeHtml(severity)}\n` +
    `بیشترین رخداد: ${escapeHtml(sources)}\n` +
    (input.pruned.incidents > 0
      ? `🧹 پاک‌شده با سیاست نگه‌داشت: ${num(input.pruned.incidents)} رویداد (` +
        `${num(input.pruned.incidentOccurrences)} رخداد)\n`
      : '') +
    `\n${lines}\n\n` +
    '<i>«بررسی‌شده» یعنی یک اپراتور آن را دیده است؛ «رفع‌شده» یعنی اپراتور باور دارد تمام شده. ' +
    'هیچ‌کدام به‌تنهایی ادعای درست‌شدن علت اصلی نیست. تلاش دوباره فقط برای عملیات ایمن و ' +
    'تکرارپذیر (و هرگز به‌صورت «تلاش دوباره برای همه») وجود دارد.</i>'
  );
}

export function formatIncidentDetail(input: {
  incident: IncidentRecord;
  relatedAudit: AuditRecord[];
  retryHint: string;
}): string {
  const incident = input.incident;
  const audit = input.relatedAudit.length
    ? input.relatedAudit
        .slice(0, 5)
        .map(
          (row) =>
            `   • ${escapeHtml(row.action)} توسط ${escapeHtml(row.actor)} — ` +
            `${formatRelativeFa(row.at)} (${escapeHtml(row.result)})`,
        )
        .join('\n')
    : '   رخداد مدیریتی ثبت نشده است.';

  return (
    `🚨 <b>رویداد</b> <code>${escapeHtml(incident.incidentId)}</code>\n\n` +
    `وضعیت: ${escapeHtml(STATUS_TITLES[incident.status])} · شدت: ` +
    `${escapeHtml(SEVERITY_TITLES[incident.severity])}\n` +
    `منبع: ${escapeHtml(incident.source)} / ${escapeHtml(incident.category)}\n` +
    `خلاصهٔ ایمن: ${escapeHtml(incident.summary)}\n` +
    `ارجاع: ${incident.reference ? `<code>${escapeHtml(incident.reference)}</code>` : '—'}\n` +
    `رخدادها: ${num(incident.occurrences)} · نخستین: ${formatTimestampFa(
      incident.firstSeenAt,
    )} · آخرین: ${formatTimestampFa(incident.lastSeenAt)}\n` +
    `قابل تلاش دوباره: ${incident.retryable ? 'بله' : 'خیر'}\n` +
    (incident.lastRetryAt
      ? `آخرین تلاش دوباره: ${formatRelativeFa(incident.lastRetryAt)} — ` +
        `${escapeHtml(incident.lastRetryResult ?? 'بی‌نتیجه')}\n`
      : '') +
    (incident.reviewedBy
      ? `بررسی توسط ${escapeHtml(incident.reviewedBy)} — ${formatRelativeFa(incident.reviewedAt)}\n`
      : '') +
    (incident.resolvedBy
      ? `رفع توسط ${escapeHtml(incident.resolvedBy)} — ${formatRelativeFa(incident.resolvedAt)}\n` +
        (incident.resolutionNote
          ? `یادداشت: ${escapeHtml(incident.resolutionNote)}\n`
          : '')
      : '') +
    `\n♻️ ${escapeHtml(input.retryHint)}\n\n` +
    `🧾 رخدادنگار مرتبط:\n${audit}`
  );
}

// --- 9. broadcast (§11) ----------------------------------------------------------

export function formatBroadcastHubScreen(input: {
  enabled: boolean;
  jobs: BroadcastJob[];
  activeCount: number;
  maxRecipients: number;
  batchSize: number;
  maxAttempts: number;
}): string {
  const jobs = input.jobs.length
    ? input.jobs
        .map(
          (job) =>
            `• <code>${escapeHtml(job.reference)}</code> · ` +
            `${escapeHtml(BROADCAST_STATUS_TITLES[job.status])}\n` +
            `   مخاطبان: ${escapeHtml(job.audienceLabel)}\n` +
            `   ایجاد: ${formatTimestampFa(job.createdAt)} · گیرندگان: ` +
            `${num(job.totalRecipients)}`,
        )
        .join('\n\n')
    : 'هنوز ارسال گروهی‌ای ثبت نشده است.';

  return (
    '📨 <b>ارسال گروهی</b>\n\n' +
    `وضعیت قابلیت: ${input.enabled ? '✅ فعال' : '⛔️ خاموش (ADMIN_BROADCAST_ENABLED=false)'}\n` +
    `سقف گیرندگان: ${num(input.maxRecipients)} · اندازهٔ دستهٔ هر تیک: ${num(
      input.batchSize,
    )} · تلاش هر گیرنده: ${num(input.maxAttempts)}\n` +
    `ارسال‌های در جریان: ${num(input.activeCount)}\n\n` +
    `${jobs}\n\n` +
    '<i>متن ساده (بدون قالب‌بندی) ارسال می‌شود و فقط پس از تأیید صریح شروع می‌شود. لغو، ' +
    'گیرندگان ارسال‌نشده را متوقف می‌کند و پیام‌های ارسال‌شده قابل بازگشت نیستند. آدرس‌ها و ' +
    'شناسه‌ها هرگز در گزارش‌ها نمایش داده نمی‌شوند.</i>'
  );
}

export function formatBroadcastAudienceScreen(input: {
  audienceLabel: string;
  estimate: number;
  excluded: { reason: string; count: number }[];
  limit: number;
  limitExceeded: boolean;
  consentNote: string;
}): string {
  const excluded = input.excluded.length
    ? input.excluded
        .map((row) => `${escapeHtml(row.reason)}: ${num(row.count)}`)
        .join(' · ')
    : 'هیچ هویتی کنار گذاشته نشد.';

  return (
    '📨 <b>مخاطبان ارسال گروهی</b>\n\n' +
    `انتخاب: ${escapeHtml(input.audienceLabel)}\n` +
    `📊 برآورد گیرندگان با همان قاعدهٔ ارسال: ${num(input.estimate)} نفر\n` +
    `🚫 کنارگذاشته‌شده‌ها: ${excluded}\n` +
    (input.limitExceeded
      ? `⚠️ این تعداد از سقف مجاز (${num(input.limit)}) بیشتر است و ارسال آغاز نمی‌شود.\n`
      : '') +
    `\nℹ️ ${escapeHtml(input.consentNote)}\n\n` +
    'پس از انتخاب مخاطبان، متن پیام را بفرستید تا پیش‌نمایش را ببینید.'
  );
}

export function formatBroadcastPreviewScreen(input: {
  textPreview: string;
  audienceLabel: string;
  estimate: number;
  maxLength: number;
}): string {
  return (
    '📨 <b>پیش‌نمایش ارسال گروهی</b>\n\n' +
    `مخاطبان: ${escapeHtml(input.audienceLabel)} · گیرندگان: ${num(input.estimate)}\n` +
    `طول متن: ${num(input.textPreview.length)} از ${num(input.maxLength)} نویسه\n\n` +
    '━━━━━━━━━━\n' +
    `${escapeHtml(input.textPreview)}\n` +
    '━━━━━━━━━━\n\n' +
    '<i>تا وقتی تأیید نکنید هیچ پیامی ارسال نمی‌شود. با تثبیت، کار به‌صورت پایدار ذخیره ' +
    'می‌شود و بعد از تأیید، ارسال با نرخ محدود شروع می‌گردد.</i>'
  );
}

export function formatBroadcastConfirmScreen(job: BroadcastJob): string {
  return (
    '📨 <b>تأیید نهایی ارسال گروهی</b>\n\n' +
    `مرجع: <code>${escapeHtml(job.reference)}</code>\n` +
    `مخاطبان: ${escapeHtml(job.audienceLabel)}\n` +
    `گیرندگان: ${num(job.totalRecipients)}\n` +
    `وضعیت: ${escapeHtml(BROADCAST_STATUS_TITLES[job.status])}\n\n` +
    'با تأیید، ارسال آغاز می‌شود. تا این لحظه هیچ پیامی ارسال نشده است.'
  );
}

export function formatBroadcastReportScreen(input: {
  job: BroadcastJob;
  totals: Record<BroadcastRecipient['status'], number>;
  attempts: number;
  notes: string[];
}): string {
  const job = input.job;

  return (
    `📨 <b>گزارش ارسال گروهی</b> <code>${escapeHtml(job.reference)}</code>\n\n` +
    `وضعیت: ${escapeHtml(BROADCAST_STATUS_TITLES[job.status])}\n` +
    `مخاطبان: ${escapeHtml(job.audienceLabel)}\n` +
    `گیرندگان: ${num(job.totalRecipients)} · تلاش‌ها: ${num(input.attempts)}\n\n` +
    `✅ پذیرفته‌شده توسط پلتفرم: ${num(input.totals.SENT)}\n` +
    `❌ ناموفق (قطعی): ${num(input.totals.FAILED)}\n` +
    `➖ کنارگذاشته‌شده: ${num(input.totals.SKIPPED)}\n` +
    `❔ نامعلوم: ${num(input.totals.UNKNOWN)}\n` +
    `⏳ در انتظار: ${num(input.totals.PENDING)}\n\n` +
    (job.lastError ? `آخرین خطا: ${escapeHtml(job.lastError)}\n\n` : '') +
    `${input.notes.map((note) => `ℹ️ ${escapeHtml(note)}`).join('\n')}\n\n` +
    `<i>مرجع کار: <code>${escapeHtml(job.broadcastId)}</code> — این شناسه در رخدادنگار هم ثبت شده است.</i>`
  );
}

export function formatBroadcastCancelledScreen(
  job: BroadcastJob,
  skipped: number,
): string {
  return (
    `📨 <b>لغو ارسال گروهی</b> <code>${escapeHtml(job.reference)}</code>\n\n` +
    `گیرندگان متوقف‌شده: ${num(skipped)}\n\n` +
    '<i>لغو فقط جلوی گیرندگان ارسال‌نشده را می‌گیرد. پیام‌هایی که پلتفرم قبلاً پذیرفته است ' +
    'قابل فراخوانی نیستند — و این گزارش هم ادعای بازگشت آن‌ها را نمی‌کند.</i>'
  );
}

// --- 10. audit log (§13) ---------------------------------------------------------

export function formatAuditScreen(input: {
  rows: AuditRecord[];
  page: number;
  pageCount: number;
  total: number;
  capNote: string;
}): string {
  const lines = input.rows.length
    ? input.rows
        .map(
          (row) =>
            `• <code>${escapeHtml(row.auditId)}</code> · ${escapeHtml(row.action)} · ` +
            `${escapeHtml(row.result)}\n` +
            `   کنشگر: ${escapeHtml(row.actor)} (${escapeHtml(row.role)}) · ` +
            `هدف: ${escapeHtml(row.targetType)}${
              row.targetRef
                ? ` / <code>${escapeHtml(row.targetRef)}</code>`
                : ''
            }\n` +
            `   ${formatTimestampFa(row.at)}` +
            (row.fromState || row.toState
              ? ` · ${escapeHtml(row.fromState ?? '—')} → ${escapeHtml(row.toState ?? '—')}`
              : '') +
            (row.reason ? `\n   دلیل: ${escapeHtml(row.reason)}` : ''),
        )
        .join('\n\n')
    : 'هنوز رخداد مدیریتی‌ای ثبت نشده است.';

  return (
    '🧾 <b>رخدادنگار مدیریتی</b>\n\n' +
    `مجموع: ${num(input.total)} · صفحه ${num(input.page)} از ${num(input.pageCount)}\n` +
    `${escapeHtml(input.capNote)}\n\n` +
    `${lines}\n\n` +
    '<i>رخدادها فقط افزودنی‌اند: هیچ صفحه‌ای آن‌ها را ویرایش یا حذف نمی‌کند. تلاش‌های ' +
    'ناموفق و رد‌شده هم با نتیجهٔ خودشان ثبت می‌شوند.</i>'
  );
}

// --- shared bits ----------------------------------------------------------------

export function periodPresetLabel(
  preset: keyof typeof PERIOD_LABELS_FA,
): string {
  return PERIOD_LABELS_FA[preset];
}

export function formatPageLabel(
  page: number,
  pageCount: number,
  total: number,
): string {
  return `صفحه ${num(page)} از ${num(pageCount)} — مجموع ${num(total)}`;
}

/**
 * Money rendering for the admin screens.
 *
 * Amounts are stored in RIAL (the project's canonical unit) and the display unit comes from the
 * documented configuration — never inferred from the currency a record happens to carry, so two
 * records are never silently mixed (§14 “cost/currency never mixed or invented”).
 */
export function formatMoneyFa(amount: number | null): string {
  if (amount === null) {
    return 'نامشخص';
  }

  return `${formatMoney(amount, 'RIAL')} (${formatMoney(amount, 'TOMAN')})`;
}

export function formatContactFa(phone: string | null): string {
  return phone ? formatPhoneFa(phone) : 'ثبت نشده';
}

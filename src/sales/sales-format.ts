/**
 * Phase 9 — centralized Persian wording for the Sales Engine (§13, §2.4).
 *
 * Every customer-facing and operator-facing string that depends on a stored value lives here, so a
 * label can never drift between the customer flow, the admin screens and the notifications. The
 * engine itself only ever carries stable identifiers (`NEW`, `MANUFACTURED_GOLD`, `bale`, …).
 */

import { escapeHtml } from '../common/html';
import { tehranDateFa, tehranTimeFa } from '../common/tehran-time';
import { formatPhoneFa } from './phone';
import {
  categoryDefinition,
  LeadRecord,
  LeadStatus,
  LossReason,
  NotificationKind,
  ProductCategory,
  SalesOutcomeRecord,
} from './sales.types';

/** Platform display names (the only place they are spelled for humans). */
export const PLATFORM_LABELS_FA: Record<'bale' | 'telegram', string> = {
  bale: 'بله',
  telegram: 'تلگرام',
};

/** Lead status labels (§10.2). */
export const STATUS_LABELS_FA: Record<LeadStatus, string> = {
  NEW: '🆕 جدید',
  CONTACTED: '📞 تماس گرفته‌شده',
  QUALIFIED: '🔍 بررسی‌شده',
  CONVERTED: '✅ مشتری‌شده',
  LOST: '❌ از‌دست‌رفته',
};

/** Loss reasons (§10.1) — a fixed vocabulary, translated once. */
export const LOSS_REASON_LABELS_FA: Record<LossReason, string> = {
  NO_RESPONSE: 'پاسخی نداد',
  PRICE: 'قیمت مناسب نبود',
  NOT_INTERESTED: 'علاقه‌ای نداشت',
  BOUGHT_ELSEWHERE: 'از جای دیگر خرید کرد',
  INVALID_CONTACT: 'شماره تماس نامعتبر',
  OUT_OF_STOCK: 'موجود نبود',
  OTHER: 'دلیل دیگر',
};

/** Notification kinds, for the admin-visible delivery state. */
export const NOTIFICATION_KIND_LABELS_FA: Record<NotificationKind, string> = {
  ADMIN: 'کارشناس',
  CUSTOMER: 'مشتری',
};

/** Outcome labels for a recorded sale row. */
export const OUTCOME_LABELS_FA: Record<'SALE' | 'CANCELLED', string> = {
  SALE: '🛒 فروش ثبت‌شده',
  CANCELLED: '🚫 لغو‌شده',
};

/** Unknown-value marker used everywhere a stored value may legitimately be missing (§9.1). */
export const UNKNOWN_FA = 'نامشخص';

export function platformLabelFa(platform: string): string {
  return platform === 'bale' || platform === 'telegram'
    ? PLATFORM_LABELS_FA[platform]
    : platform;
}

export function categoryLabelFa(category: ProductCategory): string {
  return categoryDefinition(category).labelFa;
}

/** Tehran-localized stamp. The sandbox/host timezone is never involved (§14.1). */
export function leadTimestampFa(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return UNKNOWN_FA;
  }

  return `${tehranDateFa(date)} — ${tehranTimeFa(date)}`;
}

/** Campaign line: an explicit `نامشخص` instead of an invented campaign (§12.1). */
export function campaignLabelFa(lead: LeadRecord): string {
  if (!lead.campaignId) {
    return UNKNOWN_FA;
  }

  return lead.campaignName ? lead.campaignName : lead.campaignId;
}

/**
 * Admin notification for a new lead (§9.1).
 *
 * The user-provided fields are escaped (`escapeHtml`) and the message is bounded, because this text
 * is delivered into an admin chat on a platform whose formatting we do not control. No internal id
 * is shared, only the customer-safe reference.
 */
export function formatAdminLeadNotification(lead: LeadRecord): string {
  return [
    '🛒 درخواست استعلام جدید',
    '',
    `🆔 کد پیگیری: ${lead.reference}`,
    `👤 نام: ${escapeHtml(lead.customerName)}`,
    `📱 تماس: ${formatPhoneFa(lead.phone)}`,
    `🏷 دسته: ${categoryLabelFa(lead.category)}`,
    `📝 محصول: ${
      lead.productDescription
        ? escapeHtml(lead.productDescription)
        : 'توضیحی ثبت نشده'
    }`,
    `🗒 یادداشت مشتری: ${lead.notes ? escapeHtml(lead.notes) : 'ندارد'}`,
    `📣 کمپین: ${escapeHtml(campaignLabelFa(lead))}`,
    `🌐 سکو: ${platformLabelFa(lead.platform)}`,
    `📌 وضعیت: ${STATUS_LABELS_FA[lead.status]}`,
    `🕒 زمان: ${leadTimestampFa(lead.createdAt)}`,
    '',
    'جزئیات و پیگیری درخواست‌ها: /sales',
  ].join('\n');
}

/** The confirmation the customer is entitled to *after* the lead is persisted (§8.1). */
export function formatCustomerConfirmation(lead: LeadRecord): string {
  return [
    '✅ درخواست استعلام شما ثبت شد.',
    '',
    `🆔 کد پیگیری: ${lead.reference}`,
    `🏷 دسته‌بندی: ${categoryLabelFa(lead.category)}`,
    '📞 کارشناسان طلای اتابک در اولین فرصت کاری با شما تماس خواهند گرفت.',
    '',
    'شماره تماس شما فقط برای همین درخواست استفاده می‌شود و در اختیار شخص دیگری قرار نمی‌گیرد.',
    'برای پیگیری درخواست، این کد را ذخیره کنید.',
  ].join('\n');
}

/** One-line list row used by the admin list screen. */
export function formatLeadRow(lead: LeadRecord, index: number): string {
  return (
    `${index}. ${STATUS_LABELS_FA[lead.status]} | ${lead.reference}\n` +
    `   👤 ${escapeHtml(lead.customerName)} · ${categoryLabelFa(lead.category)} · ` +
    `${leadTimestampFa(lead.createdAt)}`
  );
}

/** Sale amount line: a missing amount is reported as missing, never as zero (§14.2). */
export function formatAmountFa(outcome: SalesOutcomeRecord): string {
  if (outcome.amount === null) {
    return 'مبلغ ثبت نشده';
  }

  const currency = outcome.currency ? ` ${outcome.currency}` : '';

  return `${outcome.amount.toLocaleString('en-US')}${currency}`;
}

import { formatNumberFa, formatPercentFa, MoneyUnit } from '../../common/money';
import { escapeHtml } from '../../common/html';
import { tehranTimeFa } from '../../common/tehran-time';
import { formatPriceValue } from '../../market/price-format';
import { PriceDirection, PriceUnit } from '../../market/market.types';
import {
  FavoritesManageView,
  PriceListView,
  PriceSectionView,
  PriceView,
} from './ux-view.types';

/**
 * Presentation formatter (Phase 2 §21, §45).
 *
 * Every user-facing string is produced here — handlers never concatenate a number, a unit, a
 * percentage or a timestamp themselves. The functions are pure, which keeps each screen
 * deterministic and directly testable.
 *
 * Unit handling: values are rendered through `formatPriceValue`, i.e. the canonical Phase 1
 * value with its explicit unit. The UX layer never converts or rounds a price on its own (§20).
 */

const ARROW_UP = '🟢';
const ARROW_DOWN = '🔴';
const ARROW_FLAT = '⚪';
const ARROW_UNKNOWN = '◽';

/** Change indicator: `🟢 +۰٫۴۲%` — `null` when there is no baseline to compare with. */
export function formatChangeIndicator(
  direction: PriceDirection,
  percentageChange: number | null,
): string | null {
  const percent = formatPercentFa(percentageChange);

  if (percent === null) {
    return null;
  }

  switch (direction) {
    case 'UP':
      return `${ARROW_UP} ${percent}`;
    case 'DOWN':
      return `${ARROW_DOWN} ${percent}`;
    case 'UNCHANGED':
      return `${ARROW_FLAT} ${percent}`;
    default:
      return `${ARROW_UNKNOWN} ${percent}`;
  }
}

/** Persian time (Tehran timezone) of an ISO timestamp; `null` when unusable. */
export function formatTehranTime(iso: string | null): string | null {
  if (!iso) {
    return null;
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? null : tehranTimeFa(date);
}

export function formatLastUpdateLabel(iso: string | null): string | null {
  const time = formatTehranTime(iso);

  return time === null ? null : `🕐 آخرین بروزرسانی: ${time}`;
}

/** Stale state is never presented as a live price (§22). */
export function formatStaleNotice(): string {
  return '⚠️ آخرین قیمت معتبر — در حال حاضر قیمت جدیدی دریافت نشده است.';
}

export function formatPriceValueText(
  amount: number,
  unit: PriceUnit,
  displayUnit: MoneyUnit,
): string {
  return formatPriceValue(amount, unit, displayUnit);
}

/** One price entry: label, value in its explicit unit, and change when known. */
export function formatPriceLine(
  view: PriceView,
  displayUnit: MoneyUnit,
): string[] {
  const change = formatChangeIndicator(view.direction, view.percentageChange);
  const lines = [
    `<b>${escapeHtml(view.label)}</b>`,
    formatPriceValueText(view.price, view.unit, displayUnit),
  ];

  if (change) {
    lines.push(change);
  }

  return lines;
}

export function formatPriceListSection(
  section: PriceSectionView,
  displayUnit: MoneyUnit,
): string[] {
  return [
    `<b>${escapeHtml(section.title)}</b>`,
    '',
    ...formatPriceListSectionItems(section, displayUnit),
  ];
}

/** The items of a section without its header (used when the screen title is the header). */
export function formatPriceListSectionItems(
  section: PriceSectionView,
  displayUnit: MoneyUnit,
): string[] {
  const lines: string[] = [];

  for (const item of section.items) {
    lines.push(...formatPriceLine(item, displayUnit), '');
  }

  return lines;
}

/**
 * A price screen with a title (used by `💰 قیمت لحظهای`, `🟡 طلا` and `🪙 سکه`).
 * Instruments without valid data are listed as explicitly unavailable — never fabricated.
 */
export function formatPriceScreen(
  title: string,
  view: PriceListView,
  displayUnit: MoneyUnit,
  options: {
    emptyText: string;
    /**
     * Section screens (طلا / سکه) already name their section in the title, so repeating the
     * section header would show the same words twice. Multi-section screens keep the headers.
     */
    includeSectionTitles?: boolean;
  },
): string {
  const lines = [`<b>${escapeHtml(title)}</b>`, ''];

  if (view.sections.length === 0) {
    lines.push(options.emptyText);
    return lines.join('\n');
  }

  if (view.hasStale) {
    lines.push(formatStaleNotice(), '');
  }

  for (const section of view.sections) {
    lines.push(
      ...(options.includeSectionTitles === false
        ? formatPriceListSectionItems(section, displayUnit)
        : formatPriceListSection(section, displayUnit)),
    );
  }

  if (view.missing.length > 0) {
    lines.push(
      `ℹ️ بدون اطلاعات معتبر: ${escapeHtml(view.missing.join('، '))}`,
      '',
    );
  }

  const lastUpdate = formatLastUpdateLabel(view.lastUpdate);
  if (lastUpdate) {
    lines.push(lastUpdate);
  }

  return tidy(lines);
}

/** Favorites list (`⭐ علاقهمندیهای من`). */
export function formatFavoritesScreen(
  view: PriceListView,
  displayUnit: MoneyUnit,
  limit: number,
): string {
  const lines = ['⭐ <b>علاقهمندیهای من</b>', ''];

  if (view.sections.length === 0) {
    lines.push(
      'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
      '',
      'از «⚙️ مدیریت علاقهمندیها» نمادهای موردنظرتان را انتخاب کنید.',
    );
    return lines.join('\n');
  }

  if (view.hasStale) {
    lines.push(formatStaleNotice(), '');
  }

  for (const section of view.sections) {
    lines.push(...formatPriceListSection(section, displayUnit));
  }

  const lastUpdate = formatLastUpdateLabel(view.lastUpdate);
  if (lastUpdate) {
    lines.push(lastUpdate);
  }

  const selected = view.sections.reduce(
    (total, section) => total + section.items.length,
    0,
  );
  lines.push(
    '',
    `📌 ${formatNumberFa(selected)} از ${formatNumberFa(limit)} مورد انتخاب شده است.`,
  );

  return tidy(lines);
}

/** Favorites management (`⚙️ مدیریت علاقهمندیها`) — selection happens through buttons (§28). */
export function formatFavoritesManageScreen(view: FavoritesManageView): string {
  const lines = [
    '⚙️ <b>مدیریت علاقهمندیها</b>',
    '',
    'برای افزودن یا حذف، روی هر نماد بزنید.',
    '',
  ];

  if (view.limitReached) {
    lines.push(
      `⚠️ به سقف مجاز (${formatNumberFa(view.limit)} مورد) رسیدهاید.`,
      'برای افزودن مورد جدید، ابتدا یکی را حذف کنید.',
      '',
    );
  }

  lines.push(
    `✅ انتخابشده: ${formatNumberFa(view.selectedCount)} از ${formatNumberFa(view.limit)}`,
  );

  return lines.join('\n');
}

/** Channel CTA — the handle and the URL come from the central configuration (§35). */
export function formatChannelScreen(channelHandle: string): string {
  return (
    '📢 <b>کانال اتابک</b>\n\n' +
    'برای دیدن گزارشهای روزانه بازار و اطلاع از آخرین قیمتها،\n' +
    'عضو کانال رسمی ما شوید:\n\n' +
    escapeHtml(channelHandle)
  );
}

export function formatMenuScreen(): string {
  return (
    '📋 <b>منوی اصلی</b>\n\n' +
    'یکی از گزینههای زیر را انتخاب کنید:\n\n' +
    '💰 قیمت لحظهای · 🟡 طلا · 🪙 سکه\n' +
    '📊 بازار · ⭐ علاقهمندیها · 🔔 هشدار'
  );
}

export function formatWelcomeScreen(): string {
  return (
    'سلام 👋\n\n' +
    'به بات <b>طلای اتابک</b> خوش آمدید.\n\n' +
    'قیمت لحظهای بازار را مشاهده کنید، گزارش بازار را ببینید\n' +
    'و قیمتهای موردعلاقهتان را دنبال کنید.\n\n' +
    'یکی از گزینههای زیر را انتخاب کنید:'
  );
}

/** Safe answer for an outdated or unknown button (§40). */
export function formatExpiredCallback(): string {
  return 'این گزینه دیگر معتبر نیست.\n\nاز منوی اصلی ادامه دهید:';
}

/** Explicit reason when a favorite action is refused (never a silent discard, §31). */
export function formatFavoriteLimitReached(limit: number): string {
  return `⭐ تعداد علاقهمندیهای شما به سقف مجاز (${formatNumberFa(limit)} مورد) رسیده است.`;
}

/** Empty state of a section without any valid data (§25). */
export function formatEmptySection(sectionTitle: string): string {
  return (
    `در حال حاضر اطلاعات معتبری برای «${escapeHtml(sectionTitle)}» در دسترس نیست.\n\n` +
    'به محض دریافت قیمت معتبر، همین بخش بهروزرسانی میشود.'
  );
}

/** Collapse the blank lines introduced by section rendering. */
export function tidy(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

import {
  formatNumberFa,
  formatPercentSignFa,
  MoneyUnit,
} from '../../common/money';
import { escapeHtml } from '../../common/html';
import {
  MarketIntelligenceSnapshot,
  MarketSummary,
  MarketSymbolSnapshot,
} from '../../intelligence/market-intelligence.types';
import {
  formatPriceValueText,
  formatStaleNotice,
  formatTehranTime,
  formatLastUpdateLabel,
  tidy,
} from './ux-format';

/**
 * Phase 4 — market intelligence presentation.
 *
 * These functions only *format*: every number, direction, timestamp and availability flag was
 * already derived by `MarketIntelligenceService` from validated Phase 1 state. Nothing is
 * calculated, validated, fetched or mutated here (§32). A value that does not exist is rendered as
 * `—` or as an explicit unavailable line — never as a fabricated number (§62).
 */

const ARROW_UP = '🟢';
const ARROW_DOWN = '🔴';
const ARROW_FLAT = '⚪';
const UNKNOWN_VALUE = '—';

/** Hub of the market section (`📊 بازار`) — the Phase 4 entry point (§29). */
export function formatMarketHub(): string {
  return tidy([
    '📊 <b>بازار</b>',
    '',
    'گزارش‌ها تنها از داده‌های معتبر بازار ساخته می‌شوند.',
    '',
    '📊 گزارش امروز — شروع، قیمت فعلی، سقف و کف روز',
    '📈 حرکت بازار — تغییر نسبت به آخرین قیمت معتبر',
    '🕐 آخرین بروزرسانی — زمان آخرین قیمت معتبر هر نماد',
    '',
    'ℹ️ «بروزرسانی» فقط همین داده‌های معتبر را دوباره نمایش می‌دهد و قیمت تازه‌ای نمی‌گیرد.',
  ]);
}

/** Unavailable state: the screen exists but there is nothing validated to show (§19). */
export const MARKET_UNAVAILABLE_TEXT =
  '⚠️ در حال حاضر اطلاعات معتبر بازار در دسترس نیست.';

const AVAILABILITY_NOTE: Record<
  MarketSymbolSnapshot['availability'],
  string | null
> = {
  AVAILABLE: null,
  // A stale price is shown as the last valid price and marked as such; it is never presented as a
  // current price (§18).
  STALE: '⚠️ قیمت جدیدی برای این نماد دریافت نشده است.',
  UNAVAILABLE: '⚠️ فعلاً اطلاعات معتبری در دسترس نیست.',
};

/** `🟢 +۱۳۰٬۰۰۰ ریال | +۰٫۷۶٪` — `—` when the day has no usable open price (§7, §37). */
function formatDailyChange(
  symbol: MarketSymbolSnapshot,
  displayUnit: MoneyUnit,
): string {
  const percent = formatPercentSignFa(symbol.dailyChangePercent);

  if (
    symbol.dailyChange === null ||
    symbol.dailyChangePercent === null ||
    percent === null
  ) {
    return UNKNOWN_VALUE;
  }

  const arrow =
    symbol.dailyDirection === 'UP'
      ? ARROW_UP
      : symbol.dailyDirection === 'DOWN'
        ? ARROW_DOWN
        : ARROW_FLAT;

  return `${arrow} ${formatSignedPriceValueText(
    symbol.dailyChange,
    symbol.unit,
    displayUnit,
  )} | ${percent}`;
}

/** A single symbol block of the daily report (compact or detailed). */
function formatReportSymbol(
  symbol: MarketSymbolSnapshot,
  displayUnit: MoneyUnit,
  detailed: boolean,
): string[] {
  const lines = [`<b>${escapeHtml(symbol.label)}</b>`];

  if (symbol.availability === 'UNAVAILABLE' || symbol.currentPrice === null) {
    lines.push(AVAILABILITY_NOTE.UNAVAILABLE as string);
    return lines;
  }

  if (detailed) {
    if (symbol.open !== null) {
      lines.push(
        `شروع روز: ${formatPriceValueText(symbol.open, symbol.unit, displayUnit)}`,
      );
    }
    lines.push(
      `اکنون: ${formatPriceValueText(symbol.currentPrice, symbol.unit, displayUnit)}`,
    );
    if (symbol.high !== null) {
      lines.push(
        `بیشترین: ${formatPriceValueText(symbol.high, symbol.unit, displayUnit)}`,
      );
    }
    if (symbol.low !== null) {
      lines.push(
        `کمترین: ${formatPriceValueText(symbol.low, symbol.unit, displayUnit)}`,
      );
    }
    lines.push(`تغییر روزانه: ${formatDailyChange(symbol, displayUnit)}`);
  } else {
    lines.push(
      `اکنون: ${formatPriceValueText(symbol.currentPrice, symbol.unit, displayUnit)}`,
    );
    lines.push(`تغییر روزانه: ${formatDailyChange(symbol, displayUnit)}`);
  }

  const time = formatTehranTime(symbol.lastUpdatedAt);
  if (time) {
    lines.push(`🕐 ${time}`);
  }

  const note = AVAILABILITY_NOTE[symbol.availability];
  if (note) {
    lines.push(note);
  }

  return lines;
}

/** Daily report — `📊 گزارش امروز` (compact) and `📋 گزارش کامل` (detailed) (§6, §30, §31, §52). */
export function formatDailyReportScreen(
  view: MarketIntelligenceSnapshot,
  displayUnit: MoneyUnit,
  options: { detailed?: boolean } = {},
): string {
  const detailed = options.detailed === true;
  const title = detailed
    ? '📋 <b>گزارش کامل امروز</b>'
    : '📊 <b>گزارش امروز</b>';
  const lines = [title, ''];

  if (!view.hasData) {
    lines.push(MARKET_UNAVAILABLE_TEXT, '', 'لطفاً کمی بعد دوباره تلاش کنید.');
    return tidy(lines);
  }

  if (view.hasStale) {
    lines.push(formatStaleNotice(), '');
  }

  for (const symbol of view.symbols) {
    lines.push(...formatReportSymbol(symbol, displayUnit, detailed), '');
  }

  lines.push(formatMarketSummaryLine(view.summary), '');

  const lastUpdate = formatLastUpdateLabel(view.lastUpdate);
  if (lastUpdate) {
    lines.push(lastUpdate);
  }

  return tidy(lines);
}

/** Movement screen (`📈 حرکت بازار`): current versus the previous *valid* price (§23–§27). */
export function formatMovementScreen(
  view: MarketIntelligenceSnapshot,
  displayUnit: MoneyUnit,
): string {
  const lines = ['📈 <b>حرکت بازار</b>', ''];

  if (!view.hasData) {
    lines.push(MARKET_UNAVAILABLE_TEXT, '', 'لطفاً کمی بعد دوباره تلاش کنید.');
    return tidy(lines);
  }

  if (view.hasStale) {
    lines.push(formatStaleNotice(), '');
  }

  for (const symbol of view.symbols) {
    if (symbol.availability === 'UNAVAILABLE' || symbol.currentPrice === null) {
      continue;
    }

    lines.push(`<b>${escapeHtml(symbol.label)}</b>`);

    if (
      symbol.movementDirection === 'UNKNOWN' ||
      symbol.movementPercent === null ||
      symbol.previousPrice === null
    ) {
      lines.push('— قیمت معتبر قبلی در دسترس نیست.');
    } else if (symbol.movementDirection === 'UNCHANGED') {
      lines.push('بدون تغییر نسبت به آخرین بروزرسانی');
    } else {
      const arrow = symbol.movementDirection === 'UP' ? ARROW_UP : ARROW_DOWN;
      const percent =
        formatPercentSignFa(symbol.movementPercent) ?? UNKNOWN_VALUE;
      const absolute =
        symbol.movement === null
          ? UNKNOWN_VALUE
          : formatSignedPriceValueText(
              symbol.movement,
              symbol.unit,
              displayUnit,
            );
      lines.push(`${arrow} ${absolute} | ${percent} نسبت به آخرین بروزرسانی`);
      lines.push(
        `قیمت قبلی: ${formatPriceValueText(
          symbol.previousPrice,
          symbol.unit,
          displayUnit,
        )}`,
      );
    }

    lines.push(
      `قیمت فعلی: ${formatPriceValueText(
        symbol.currentPrice,
        symbol.unit,
        displayUnit,
      )}`,
    );

    const time = formatTehranTime(symbol.lastUpdatedAt);
    if (time) {
      lines.push(`🕐 ${time}`);
    }

    lines.push('');
  }

  const missing = view.symbols.filter(
    (symbol) => symbol.availability === 'UNAVAILABLE',
  );
  if (missing.length > 0) {
    lines.push(
      `ℹ️ بدون اطلاعات معتبر: ${missing
        .map((symbol) => escapeHtml(symbol.label))
        .join('، ')}`,
      '',
    );
  }

  const lastUpdate = formatLastUpdateLabel(view.lastUpdate);
  if (lastUpdate) {
    lines.push(lastUpdate);
  }

  return tidy(lines);
}

/** Last-update screen (`🕐 آخرین بروزرسانی`): the real accepted-price time per symbol (§12–§14). */
export function formatLastUpdateScreen(
  view: MarketIntelligenceSnapshot,
): string {
  const lines = ['🕐 <b>آخرین بروزرسانی</b>', ''];

  if (!view.hasData) {
    lines.push(MARKET_UNAVAILABLE_TEXT, '', 'لطفاً کمی بعد دوباره تلاش کنید.');
    return tidy(lines);
  }

  for (const symbol of view.symbols) {
    const time = formatTehranTime(symbol.lastUpdatedAt);

    if (symbol.availability === 'UNAVAILABLE' || time === null) {
      lines.push(`▪️ ${escapeHtml(symbol.label)} — بدون داده معتبر`);
      continue;
    }

    const badge = symbol.availability === 'STALE' ? '⚠️ کهنه' : '✅ تازه';
    lines.push(`▪️ ${escapeHtml(symbol.label)} — ${time} ${badge}`);
  }

  lines.push(
    '',
    '⏱ زمان‌ها لحظهٔ دریافت آخرین قیمت معتبر هر نماد است؛ «بروزرسانی» صفحه آن را تغییر نمی‌دهد.',
  );

  return tidy(lines);
}

/** Descriptive, arithmetic-only summary of the snapshot (§28). */
function formatMarketSummaryLine(summary: MarketSummary): string {
  return [
    `📈 افزایشی: ${formatNumberFa(summary.increasing)}`,
    `📉 کاهشی: ${formatNumberFa(summary.decreasing)}`,
    `⚪ بدون تغییر: ${formatNumberFa(summary.unchanged)}`,
    `◽ نامشخص: ${formatNumberFa(summary.unknown)}`,
  ].join(' · ');
}

/** Signed canonical amount (`+۱۳۰٬۰۰۰ ریال` / `−۱۳۰٬۰۰۰ ریال`) — `0` stays unsigned (§38). */
export function formatSignedPriceValueText(
  amount: number,
  unit: MarketSymbolSnapshot['unit'],
  displayUnit: MoneyUnit,
): string {
  const value = formatPriceValueText(Math.abs(amount), unit, displayUnit);
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';

  return `${sign}${value}`;
}

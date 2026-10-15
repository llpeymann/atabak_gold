import { buildBrandFooterLines, MESSAGE_DIVIDER } from '../common/branding';
import { escapeHtml } from '../common/html';
import { MoneyUnit } from '../common/money';
import { tehranTimeFa } from '../common/tehran-time';
import {
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
} from '../intelligence/market-intelligence.types';
import { PriceDirection } from '../market/market.types';
import {
  directionEmoji,
  formatChangePercent,
  formatPriceValue,
} from '../market/price-format';
import { ContentItem, MessageType } from './channel.types';
import { seriesTitleOf, specFor } from './message-registry';
import { MovementCandidate, RangeCandidate } from './channel-policy.service';

/**
 * Phase 5 formatters (§15, §20).
 *
 * Pure presentation: every number below arrives already computed by Phase 1 (validated prices,
 * daily statistics) or Phase 4 (descriptive snapshot). These functions never fetch, never validate,
 * never mutate and never invent a value — a missing number is rendered as an explicit
 * "not available" marker instead of a zero.
 *
 * Percentage formatting deliberately follows the established channel style (`formatChangePercent`,
 * i.e. the ASCII `%` used by the existing price update and poster), so the channel keeps one
 * consistent typography.
 */

const NOT_AVAILABLE = '—';

export interface DailyRangeFormatInput {
  snapshot: MarketIntelligenceSnapshot;
  /** `scheduled` = the 21:00 range report, `event` = a newly established extreme. */
  mode: 'scheduled' | 'event';
  /** Symbols that made a new extreme (event mode only). */
  candidates?: readonly RangeCandidate[];
  now: Date;
  displayUnit: MoneyUnit;
}

/** One symbol line: high/low with the current price, or an explicit partial-data note. */
function rangeLines(
  symbol: MarketSymbolSnapshot,
  displayUnit: MoneyUnit,
): string {
  const name = `<b>${escapeHtml(symbol.label)}</b>`;

  if (symbol.high === null || symbol.low === null) {
    return `${name}\n⚠️ بازه امروز در دسترس نیست (داده معتبر ناقص).`;
  }

  const high = escapeHtml(
    formatPriceValue(symbol.high, symbol.unit, displayUnit),
  );
  const low = escapeHtml(
    formatPriceValue(symbol.low, symbol.unit, displayUnit),
  );
  const current =
    symbol.currentPrice === null
      ? NOT_AVAILABLE
      : escapeHtml(
          formatPriceValue(symbol.currentPrice, symbol.unit, displayUnit),
        );
  const percent = formatChangePercent(symbol.dailyChangePercent);
  const changeLine =
    symbol.dailyChange === null
      ? 'تغییر روزانه: —'
      : `تغییر روزانه: ${directionEmoji(symbol.dailyDirection)} ${escapeHtml(
          formatPriceValue(
            Math.abs(symbol.dailyChange),
            symbol.unit,
            displayUnit,
          ),
        )}${percent === null ? '' : ` (${escapeHtml(percent)})`}`;

  return (
    `${name}\n` +
    `🔺 بیشترین: ${high}\n` +
    `🔻 کمترین: ${low}\n` +
    `💰 اکنون: ${current}\n` +
    `${changeLine}` +
    (symbol.availability === 'STALE' ? '\n⚠️ آخرین قیمت معتبر قدیمی است.' : '')
  );
}

/** `DAILY_RANGE` — daily high/low (§5.3). */
export function formatDailyRangeMessage(input: DailyRangeFormatInput): string {
  const { snapshot, mode, now, displayUnit } = input;

  const headline =
    mode === 'event'
      ? '📊 <b>ثبت سقف/کف جدید روز</b>'
      : '📊 <b>بازه روزانه بازار</b>';

  const lines: string[] = [
    headline,
    `📅 ${escapeHtml(tehranTimeFa(now))} به وقت تهران`,
    MESSAGE_DIVIDER,
  ];

  if (mode === 'event' && input.candidates && input.candidates.length > 0) {
    for (const candidate of input.candidates) {
      const arrow = candidate.kind === 'HIGH' ? '🔺' : '🔻';
      const label = candidate.kind === 'HIGH' ? 'سقف جدید' : 'کف جدید';

      lines.push(
        `${arrow} <b>${escapeHtml(candidate.label)}</b> — ${label}: ` +
          `${escapeHtml(formatPriceValue(candidate.value, unitOf(snapshot, candidate.symbol), displayUnit))}`,
      );
    }
    lines.push(MESSAGE_DIVIDER);
  }

  const withRange = snapshot.symbols.filter(
    (symbol) => symbol.high !== null && symbol.low !== null,
  );
  // Partial availability stays explicit (§18): a symbol that has data but no usable statistics is
  // named, and a symbol that has nothing at all is counted — never silently dropped.
  const withoutStatistics = snapshot.symbols.filter(
    (symbol) =>
      (symbol.high === null || symbol.low === null) &&
      symbol.availability !== 'UNAVAILABLE',
  );
  const withoutRange = snapshot.symbols.length - withRange.length;

  for (const symbol of withRange) {
    lines.push(rangeLines(symbol, displayUnit), '');
  }

  for (const symbol of withoutStatistics) {
    lines.push(
      `⚠️ <b>${escapeHtml(symbol.label)}</b> — بازه امروز در دسترس نیست (داده معتبر ناقص).`,
      '',
    );
  }

  if (withoutRange > withoutStatistics.length) {
    lines.push(
      `ℹ️ برای ${withoutRange - withoutStatistics.length} نماد داده معتبر امروز در دسترس نیست.`,
      '',
    );
  }

  return [...lines, ...buildBrandFooterLines()].join('\n');
}

function unitOf(
  snapshot: MarketIntelligenceSnapshot,
  symbol: string,
): MarketSymbolSnapshot['unit'] {
  return (
    snapshot.symbols.find((candidate) => candidate.symbol === symbol)?.unit ??
    'RIAL'
  );
}

/** `MARKET_MOVEMENT` — significant observed movements (§5.2, §17). */
export function formatMovementMessage(
  candidates: readonly MovementCandidate[],
  now: Date,
  displayUnit: MoneyUnit,
): string {
  const lines: string[] = [
    '📈 <b>حرکت مهم بازار</b>',
    `📅 ${escapeHtml(tehranTimeFa(now))} به وقت تهران`,
    MESSAGE_DIVIDER,
  ];

  for (const candidate of candidates) {
    const percent = formatChangePercent(candidate.movementPercent);
    const arrow = candidate.direction === 'UP' ? '🟢' : '🔴';
    const verb = candidate.direction === 'UP' ? 'افزایش' : 'کاهش';

    lines.push(
      `${arrow} <b>${escapeHtml(candidate.label)}</b>: ${verb} ` +
        `${escapeHtml(percent ?? NOT_AVAILABLE)} ` +
        `(آستانه ${escapeHtml(`${candidate.thresholdPercent}%`)})`,
      `   قیمت قبلی: ${escapeHtml(
        formatPriceValue(candidate.previousPrice, 'RIAL', displayUnit),
      )}`,
      `   قیمت فعلی: ${escapeHtml(
        formatPriceValue(candidate.currentPrice, 'RIAL', displayUnit),
      )}`,
      '',
    );
  }

  lines.push(
    'ℹ️ این پیام فقط یک مشاهده بازار است و پیش‌بینی یا توصیه معاملاتی نیست.',
    '',
  );

  return [...lines, ...buildBrandFooterLines()].join('\n');
}

/** `DAILY_REPORT` — descriptive daily summary from the Phase 4 snapshot (§5.4). */
export function formatDailyReportMessage(
  snapshot: MarketIntelligenceSnapshot,
  now: Date,
  displayUnit: MoneyUnit,
): string {
  const lines: string[] = [
    '🗓 <b>گزارش روزانه بازار</b>',
    `📅 ${escapeHtml(tehranTimeFa(now))} به وقت تهران`,
    MESSAGE_DIVIDER,
  ];

  if (snapshot.freshness === 'STALE') {
    lines.push(
      '⚠️ داده‌های این گزارش تازه نیستند (آخرین بروزرسانی معتبر قدیمی است).',
      '',
    );
  } else if (snapshot.freshness === 'PARTIAL') {
    lines.push('ℹ️ بخشی از نمادها داده معتبر امروز ندارند.', '');
  }

  const available = snapshot.symbols.filter(
    (symbol) => symbol.currentPrice !== null,
  );

  for (const symbol of available) {
    const current = escapeHtml(
      formatPriceValue(symbol.currentPrice ?? 0, symbol.unit, displayUnit),
    );
    const percent = formatChangePercent(symbol.dailyChangePercent);
    const open =
      symbol.open === null
        ? NOT_AVAILABLE
        : escapeHtml(formatPriceValue(symbol.open, symbol.unit, displayUnit));

    lines.push(
      `<b>${escapeHtml(symbol.label)}</b>`,
      `   شروع روز: ${open}`,
      `   اکنون: ${current}`,
      `   تغییر روزانه: ${directionEmoji(symbol.dailyDirection)} ${
        percent === null ? '—' : escapeHtml(percent)
      }`,
      '',
    );
  }

  const unavailable = snapshot.symbols.length - available.length;

  if (unavailable > 0) {
    lines.push(`ℹ️ ${unavailable} نماد بدون داده معتبر امروز.`, '');
  }

  lines.push(
    `📈 افزایشی: ${snapshot.summary.increasing} · 📉 کاهشی: ${snapshot.summary.decreasing} · ` +
      `⚪ بدون تغییر: ${snapshot.summary.unchanged} · ◽ نامشخص: ${snapshot.summary.unknown}`,
    '',
  );

  return [...lines, ...buildBrandFooterLines()].join('\n');
}

/**
 * Validated market block appended to `NIGHTLY_ANALYSIS` (§5.7).
 *
 * Only Phase 4 values: a symbol without data is listed as unavailable, never carried forward and
 * never invented.
 */
export function formatValidatedMarketBlock(
  snapshot: MarketIntelligenceSnapshot,
  displayUnit: MoneyUnit,
): string {
  const lines: string[] = [MESSAGE_DIVIDER, '📊 <b>داده‌های معتبر بازار</b>'];

  const available = snapshot.symbols.filter(
    (symbol) => symbol.currentPrice !== null,
  );

  if (available.length === 0) {
    return [...lines, '⚠️ در حال حاضر داده معتبر بازار در دسترس نیست.'].join(
      '\n',
    );
  }

  for (const symbol of available) {
    const current = escapeHtml(
      formatPriceValue(symbol.currentPrice ?? 0, symbol.unit, displayUnit),
    );
    const percent = formatChangePercent(symbol.dailyChangePercent);
    const high =
      symbol.high === null
        ? NOT_AVAILABLE
        : escapeHtml(formatPriceValue(symbol.high, symbol.unit, displayUnit));
    const low =
      symbol.low === null
        ? NOT_AVAILABLE
        : escapeHtml(formatPriceValue(symbol.low, symbol.unit, displayUnit));

    lines.push(
      `▫️ <b>${escapeHtml(symbol.label)}</b>: ${current}` +
        (percent === null ? '' : ` (${escapeHtml(percent)})`) +
        ` — بیشترین ${high} · کمترین ${low}`,
    );
  }

  if (snapshot.freshness === 'STALE' || snapshot.freshness === 'PARTIAL') {
    lines.push(
      '⚠️ بخشی از این داده‌ها قدیمی یا ناقص است؛ به‌عنوان «لحظه‌ای» تلقی نشود.',
    );
  }

  if (snapshot.lastUpdate !== null) {
    lines.push(
      `🕐 آخرین بروزرسانی معتبر: ${escapeHtml(
        tehranTimeFa(new Date(snapshot.lastUpdate)),
      )} به وقت تهران`,
    );
  }

  return lines.join('\n');
}

/**
 * Editorial body shared by the three pillars (§5.5–§5.7, §20): the official series title is
 * printed from the registry, the body is the human-written text, and the brand footer stays
 * identical to every other published message.
 */
export function formatEditorialMessage(
  content: ContentItem,
  options: { marketBlock?: string | null } = {},
): string {
  const title = seriesTitleOf(content.messageType);
  const lines: string[] = [];

  if (title !== null) {
    lines.push(`🏆 <b>${escapeHtml(title)}</b>`);
  }

  if (content.title.trim() !== '') {
    lines.push(`📝 <b>${escapeHtml(content.title.trim())}</b>`);
  }

  lines.push(MESSAGE_DIVIDER, escapeHtml(content.body.trim()));

  if (options.marketBlock) {
    lines.push('', options.marketBlock);
  }

  lines.push('', ...buildBrandFooterLines());

  return lines.join('\n');
}

/** `BRANDED` — brand content (`طلای اتابک`): editorial body with the brand frame (§5.6). */
export function formatBrandedMessage(content: ContentItem): string {
  return formatEditorialMessage(content, { marketBlock: null });
}

/** `NIGHTLY_ANALYSIS` — pillar C: editorial body + the validated market block (§5.7). */
export function formatNightlyAnalysisMessage(
  content: ContentItem,
  snapshot: MarketIntelligenceSnapshot,
  displayUnit: MoneyUnit,
): string {
  return formatEditorialMessage(content, {
    marketBlock: content.includeMarketData
      ? formatValidatedMarketBlock(snapshot, displayUnit)
      : null,
  });
}

/** Marker used by tests/logs to prove which formatter produced a payload (§27.1). */
export function formatterNameFor(type: MessageType): string {
  return `${specFor(type).kind.toLowerCase()}-${type.toLowerCase()}`;
}

/** Human description of a direction for logs (never shown as advice). */
export function describeDirection(direction: PriceDirection): string {
  switch (direction) {
    case 'UP':
      return 'increase';
    case 'DOWN':
      return 'decrease';
    case 'UNCHANGED':
      return 'unchanged';
    default:
      return 'unknown';
  }
}

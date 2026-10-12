import {
  formatDailyReportScreen,
  formatLastUpdateScreen,
  formatMarketHub,
  formatMovementScreen,
  formatSignedPriceValueText,
  MARKET_UNAVAILABLE_TEXT,
} from './market-format';
import {
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
} from '../../intelligence/market-intelligence.types';

/**
 * Phase 4 presentation (§30, §31, §36–§39, §52).
 *
 * The formatters must render exactly what the snapshot says — including the cases where the answer
 * is "we do not know" (`—`) — and must never compute a market value themselves (§32).
 */

const symbol = (
  overrides: Partial<MarketSymbolSnapshot> = {},
): MarketSymbolSnapshot => ({
  symbol: 'IR_GOLD_18K',
  label: 'طلای ۱۸ عیار',
  section: 'gold',
  unit: 'RIAL',
  availability: 'AVAILABLE',
  freshness: 'FRESH',
  currentPrice: 17_500_000,
  previousPrice: 17_400_000,
  open: 17_000_000,
  high: 17_500_000,
  low: 16_900_000,
  dailyChange: 500_000,
  dailyChangePercent: (500_000 / 17_000_000) * 100,
  dailyDirection: 'UP',
  movement: 100_000,
  movementPercent: (100_000 / 17_400_000) * 100,
  movementDirection: 'UP',
  lastUpdatedAt: '2026-09-30T09:30:00.000Z',
  ageMs: 60_000,
  ...overrides,
});

const snapshot = (
  overrides: Partial<MarketIntelligenceSnapshot> = {},
): MarketIntelligenceSnapshot => ({
  generatedAt: '2026-09-30T09:31:00.000Z',
  freshness: 'FRESH',
  symbols: [symbol()],
  summary: {
    increasing: 1,
    decreasing: 0,
    unchanged: 0,
    unknown: 0,
    available: 1,
    stale: 0,
    unavailable: 0,
  },
  hasData: true,
  hasStale: false,
  lastUpdate: '2026-09-30T09:30:00.000Z',
  ...overrides,
});

describe('market hub (§29)', () => {
  it('lists the three reports and states that refresh does not fetch a price', () => {
    const text = formatMarketHub();

    expect(text).toContain('📊 <b>بازار</b>');
    expect(text).toContain('📊 گزارش امروز');
    expect(text).toContain('📈 حرکت بازار');
    expect(text).toContain('🕐 آخرین بروزرسانی');
    expect(text).toContain('قیمت تازه‌ای نمی‌گیرد');
  });
});

describe('daily report (§6–§8, §30, §31)', () => {
  it('renders the compact report from the snapshot values', () => {
    const text = formatDailyReportScreen(snapshot(), 'RIAL');

    expect(text).toContain('📊 <b>گزارش امروز</b>');
    expect(text).toContain('اکنون: ۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('تغییر روزانه: 🟢 +۵۰۰٬۰۰۰ ریال | +۲٫۹۴٪');
    expect(text).toContain('+۲٫۹۴٪');
    expect(text).toContain('📈 افزایشی: ۱ · 📉 کاهشی: ۰');
    expect(text).toContain('🕐 آخرین بروزرسانی:');
  });

  it('renders the detailed report with open, high and low', () => {
    const text = formatDailyReportScreen(snapshot(), 'RIAL', {
      detailed: true,
    });

    expect(text).toContain('📋 <b>گزارش کامل امروز</b>');
    expect(text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(text).toContain('اکنون: ۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('بیشترین: ۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('کمترین: ۱۶٬۹۰۰٬۰۰۰ ریال');
    expect(text).toContain('تغییر روزانه: 🟢 +۵۰۰٬۰۰۰ ریال | +۲٫۹۴٪');
  });

  it('shows — for the daily change when the day has no usable open price', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [
          symbol({
            open: null,
            high: null,
            low: null,
            dailyChange: null,
            dailyChangePercent: null,
            dailyDirection: 'UNKNOWN',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('تغییر روزانه: —');
  });

  it('renders the negative daily change with the Persian minus sign', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [
          symbol({
            currentPrice: 16_000_000,
            dailyChange: -1_000_000,
            dailyChangePercent: (-1_000_000 / 17_000_000) * 100,
            dailyDirection: 'DOWN',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('🔴 −۱٬۰۰۰٬۰۰۰ ریال');
  });

  it('renders a zero daily change as 0 without a sign', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [
          symbol({
            currentPrice: 17_000_000,
            dailyChange: 0,
            dailyChangePercent: 0,
            dailyDirection: 'UNCHANGED',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('⚪ ۰ ریال | ۰٪');
  });

  it('marks an unavailable symbol explicitly instead of dropping it (§19, §20)', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [
          symbol(),
          symbol({
            symbol: 'SILVER',
            label: 'نقره',
            availability: 'UNAVAILABLE',
            freshness: null,
            currentPrice: null,
            previousPrice: null,
            open: null,
            high: null,
            low: null,
            dailyChange: null,
            dailyChangePercent: null,
            dailyDirection: 'UNKNOWN',
            movement: null,
            movementPercent: null,
            movementDirection: 'UNKNOWN',
            lastUpdatedAt: null,
            ageMs: null,
          }),
        ],
        summary: {
          ...snapshot().summary,
          unavailable: 1,
        },
      }),
      'RIAL',
    );

    expect(text).toContain('<b>نقره</b>');
    expect(text).toContain('⚠️ فعلاً اطلاعات معتبری در دسترس نیست.');
  });

  it('shows a friendly screen when no symbol has validated data', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [],
        hasData: false,
        hasStale: false,
        lastUpdate: null,
      }),
      'RIAL',
    );

    expect(text).toContain(MARKET_UNAVAILABLE_TEXT);
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  it('announces stale data once and marks the affected symbol (§17, §18)', () => {
    const text = formatDailyReportScreen(
      snapshot({
        symbols: [symbol({ availability: 'STALE', freshness: 'STALE' })],
        hasStale: true,
      }),
      'RIAL',
    );

    expect(text).toContain('آخرین قیمت معتبر');
    expect(text).toContain('⚠️ قیمت جدیدی برای این نماد دریافت نشده است.');
    // The last valid price is still shown, clearly labelled as stale.
    expect(text).toContain('اکنون: ۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  it('converts the unit at presentation time only', () => {
    const rial = formatDailyReportScreen(snapshot(), 'RIAL');
    const toman = formatDailyReportScreen(snapshot(), 'TOMAN');

    expect(rial).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(toman).toContain('۱٬۷۵۰٬۰۰۰ تومان');
  });
});

describe('movement report (§23–§27)', () => {
  it('renders an increase against the previous valid price', () => {
    const text = formatMovementScreen(snapshot(), 'RIAL');

    expect(text).toContain('📈 <b>حرکت بازار</b>');
    // Absolute movement and percentage, both measured against the previous valid price.
    expect(text).toContain('🟢 +۱۰۰٬۰۰۰ ریال | +۰٫۵۷٪ نسبت به آخرین بروزرسانی');
    expect(text).toContain('قیمت قبلی: ۱۷٬۴۰۰٬۰۰۰ ریال');
    expect(text).toContain('قیمت فعلی: ۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  it('renders a decrease', () => {
    const text = formatMovementScreen(
      snapshot({
        symbols: [
          symbol({
            currentPrice: 17_300_000,
            movement: -100_000,
            movementPercent: (-100_000 / 17_400_000) * 100,
            movementDirection: 'DOWN',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('🔴 −۱۰۰٬۰۰۰ ریال | −۰٫۵۷٪ نسبت به آخرین بروزرسانی');
  });

  it('renders an unchanged price without a sign', () => {
    const text = formatMovementScreen(
      snapshot({
        symbols: [
          symbol({
            movement: 0,
            movementPercent: 0,
            movementDirection: 'UNCHANGED',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('بدون تغییر نسبت به آخرین بروزرسانی');
  });

  it('renders an explicit unavailable line when there is no previous valid price', () => {
    const text = formatMovementScreen(
      snapshot({
        symbols: [
          symbol({
            previousPrice: null,
            movement: null,
            movementPercent: null,
            movementDirection: 'UNKNOWN',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('— قیمت معتبر قبلی در دسترس نیست.');
    expect(text).toContain('قیمت فعلی: ۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  it('never presents movement and daily change as the same number (§23)', () => {
    const text = formatMovementScreen(
      snapshot({
        symbols: [
          symbol({
            movement: -10_000,
            movementPercent: (-10_000 / 17_400_000) * 100,
            movementDirection: 'DOWN',
          }),
        ],
      }),
      'RIAL',
    );

    expect(text).toContain('🔴 −۱۰٬۰۰۰ ریال | −۰٫۰۶٪ نسبت به آخرین بروزرسانی');
    expect(text).not.toContain('+۲٫۹۴٪'); // the daily change is not repeated here
  });
});

describe('last update report (§12–§14, §16–§18)', () => {
  it('renders the real Tehran time of every symbol with its freshness', () => {
    const text = formatLastUpdateScreen(snapshot());

    expect(text).toContain('🕐 <b>آخرین بروزرسانی</b>');
    // 09:30 UTC is 13:00 in Tehran during the Iranian summer time (UTC+3:30).
    expect(text).toContain('۱۳:۰۰');
    expect(text).toContain('✅ تازه');
    expect(text).not.toContain('⚠️ کهنه');
  });

  it('marks a stale symbol as کهنه and an empty symbol as بدون داده معتبر', () => {
    const text = formatLastUpdateScreen(
      snapshot({
        symbols: [
          symbol({ availability: 'STALE', freshness: 'STALE' }),
          symbol({
            symbol: 'SILVER',
            label: 'نقره',
            availability: 'UNAVAILABLE',
            freshness: null,
            currentPrice: null,
            lastUpdatedAt: null,
          }),
        ],
      }),
    );

    expect(text).toContain('⚠️ کهنه');
    expect(text).toContain('نقره — بدون داده معتبر');
  });

  it('states that refreshing does not move the timestamps', () => {
    expect(formatLastUpdateScreen(snapshot())).toContain(
      '«بروزرسانی» صفحه آن را تغییر نمی‌دهد',
    );
  });

  it('shows the unavailable screen without any fabricated time', () => {
    const text = formatLastUpdateScreen(
      snapshot({ symbols: [], hasData: false, lastUpdate: null }),
    );

    expect(text).toContain(MARKET_UNAVAILABLE_TEXT);
    expect(text).not.toContain('۱۹۷۰');
  });
});

describe('signed values (§38)', () => {
  it('signs positive and negative amounts and leaves zero unsigned', () => {
    expect(formatSignedPriceValueText(1_000, 'RIAL', 'RIAL')).toBe(
      '+۱٬۰۰۰ ریال',
    );
    expect(formatSignedPriceValueText(-1_000, 'RIAL', 'RIAL')).toBe(
      '−۱٬۰۰۰ ریال',
    );
    expect(formatSignedPriceValueText(0, 'RIAL', 'RIAL')).toBe('۰ ریال');
  });

  it('keeps the currency of the symbol while converting the money unit', () => {
    expect(formatSignedPriceValueText(1_055_000, 'RIAL', 'TOMAN')).toBe(
      '+۱۰۵٬۵۰۰ تومان',
    );
    expect(formatSignedPriceValueText(4_025, 'USD', 'RIAL')).toBe(
      '+۴٬۰۲۵ دلار',
    );
  });
});

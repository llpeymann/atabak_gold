import {
  formatAlertsPlaceholder,
  formatChangeIndicator,
  formatChannelScreen,
  formatEmptySection,
  formatExpiredCallback,
  formatFavoriteLimitReached,
  formatFavoritesManageScreen,
  formatFavoritesScreen,
  formatLastUpdateLabel,
  formatMarketSnapshot,
  formatMenuScreen,
  formatPriceScreen,
  formatStaleNotice,
  formatTehranTime,
  formatWelcomeScreen,
} from './ux-format';
import {
  FavoritesManageView,
  MarketSnapshotView,
  PriceListView,
} from './ux-view.types';

const priceView = (
  overrides: Partial<PriceListView['sections'][number]['items'][number]> = {},
) => ({
  symbol: 'IR_GOLD_18K',
  label: 'طلای ۱۸ عیار',
  section: 'gold' as const,
  price: 17_500_000,
  unit: 'RIAL' as const,
  percentageChange: 0.42,
  direction: 'UP' as const,
  freshness: 'FRESH' as const,
  updatedAt: '2026-09-30T09:30:00.000Z',
  ...overrides,
});

const priceList = (overrides: Partial<PriceListView> = {}): PriceListView => ({
  sections: [{ section: 'gold', title: '🥇 طلا و انس', items: [priceView()] }],
  lastUpdate: '2026-09-30T09:30:00.000Z',
  hasStale: false,
  missing: [],
  ...overrides,
});

describe('change indicator', () => {
  it('renders an upward move', () => {
    expect(formatChangeIndicator('UP', 0.42)).toBe('🟢 +۰٫۴۲%');
  });

  it('renders a downward move', () => {
    expect(formatChangeIndicator('DOWN', -0.31)).toBe('🔴 −۰٫۳۱%');
  });

  it('renders an unchanged price', () => {
    expect(formatChangeIndicator('UNCHANGED', 0)).toBe('⚪ ۰%');
  });

  it('renders an unknown direction when a percentage exists', () => {
    expect(formatChangeIndicator('UNKNOWN', 1.5)).toBe('◽ +۱٫۵%');
  });

  it('renders nothing when there is no baseline', () => {
    expect(formatChangeIndicator('UNKNOWN', null)).toBeNull();
  });
});

describe('timestamps', () => {
  it('renders Tehran time for a valid timestamp', () => {
    // 09:30 UTC == 13:00 in Tehran (UTC+3:30).
    expect(formatTehranTime('2026-09-30T09:30:00.000Z')).toBe('۱۳:۰۰');
  });

  it('exposes the last update label', () => {
    expect(formatLastUpdateLabel('2026-09-30T09:30:00.000Z')).toBe(
      '🕐 آخرین بروزرسانی: ۱۳:۰۰',
    );
  });

  it('returns null when no timestamp is available', () => {
    expect(formatLastUpdateLabel(null)).toBeNull();
    expect(formatTehranTime('not-a-date')).toBeNull();
  });
});

describe('price screen', () => {
  it('renders the title, label, value with unit and the change', () => {
    const text = formatPriceScreen(
      '💰 قیمت لحظهای بازار',
      priceList(),
      'RIAL',
      {
        emptyText: 'خالی',
      },
    );

    expect(text).toContain('<b>💰 قیمت لحظهای بازار</b>');
    expect(text).toContain('<b>طلای ۱۸ عیار</b>');
    expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('🟢 +۰٫۴۲%');
    expect(text).toContain('🕐 آخرین بروزرسانی: ۱۳:۰۰');
  });

  it('does not repeat the section title when the screen title is that section', () => {
    const text = formatPriceScreen('🪙 سکه', priceList(), 'RIAL', {
      emptyText: 'خالی',
      includeSectionTitles: false,
    });

    expect(text).toContain('<b>🪙 سکه</b>');
    expect(text).not.toContain('<b>🟨 طلا</b>');
    expect(text.match(/🪙 سکه/g)).toHaveLength(1);
    expect(text).toContain('<b>طلای ۱۸ عیار</b>');
  });

  it('honours the configured display unit without touching the canonical value', () => {
    const text = formatPriceScreen('🟡 طلا', priceList(), 'TOMAN', {
      emptyText: 'خالی',
    });

    expect(text).toContain('۱٬۷۵۰٬۰۰۰ تومان');
  });

  it('marks stale data instead of presenting it as live', () => {
    const text = formatPriceScreen(
      '💰 قیمت لحظهای بازار',
      priceList({ hasStale: true }),
      'RIAL',
      { emptyText: 'خالی' },
    );

    expect(text).toContain(formatStaleNotice());
  });

  it('lists symbols without valid data as unavailable', () => {
    const text = formatPriceScreen(
      '🪙 سکه',
      priceList({ missing: ['نیم سکه'] }),
      'RIAL',
      { emptyText: 'خالی' },
    );

    expect(text).toContain('بدون اطلاعات معتبر: نیم سکه');
  });

  it('shows an intentional empty state', () => {
    const text = formatPriceScreen(
      '🪙 سکه',
      priceList({ sections: [], lastUpdate: null }),
      'RIAL',
      { emptyText: formatEmptySection('سکه') },
    );

    expect(text).toContain('اطلاعات معتبری برای «سکه»');
  });
});

describe('market snapshot', () => {
  const snapshot: MarketSnapshotView = {
    lines: [
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        section: 'gold',
        unit: 'RIAL',
        open: 17_000_000,
        high: 17_500_000,
        low: 16_900_000,
        current: 17_500_000,
        change: 500_000,
        freshness: 'FRESH',
        updatedAt: '2026-09-30T09:30:00.000Z',
      },
    ],
    lastUpdate: '2026-09-30T09:30:00.000Z',
    hasStale: false,
  };

  it('renders open, current, high, low and change', () => {
    const text = formatMarketSnapshot(snapshot, 'RIAL');

    expect(text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(text).toContain('اکنون: ۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('بیشترین: ۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('کمترین: ۱۶٬۹۰۰٬۰۰۰ ریال');
    expect(text).toContain('تغییر: 🟢 +۲٫۹۴%');
  });

  it('shows the prepared empty state', () => {
    const text = formatMarketSnapshot(
      { lines: [], lastUpdate: null, hasStale: false },
      'RIAL',
    );

    expect(text).toContain('اطلاعات بازار هنوز آماده نیست.');
  });
});

describe('favorites', () => {
  it('renders the list with a selection counter', () => {
    const text = formatFavoritesScreen(priceList(), 'RIAL', 10);

    expect(text).toContain('⭐ <b>علاقهمندیهای من</b>');
    expect(text).toContain('📌 ۱ از ۱۰ مورد انتخاب شده است.');
  });

  it('renders the empty state', () => {
    const text = formatFavoritesScreen(
      priceList({ sections: [], lastUpdate: null }),
      'RIAL',
      10,
    );

    expect(text).toContain('هنوز موردی به علاقهمندیها اضافه نکردهاید.');
    expect(text).toContain('مدیریت علاقهمندیها');
  });

  it('renders the management screen with selection state and remaining capacity', () => {
    const view: FavoritesManageView = {
      options: [
        {
          symbol: 'IR_GOLD_18K',
          label: 'طلای ۱۸ عیار',
          section: 'gold',
          selected: true,
        },
        {
          symbol: 'USD',
          label: '🇺🇸 دلار آمریکا',
          section: 'currency',
          selected: false,
        },
      ],
      limit: 10,
      selectedCount: 1,
      limitReached: false,
    };

    const text = formatFavoritesManageScreen(view);

    expect(text).toContain('⚙️ <b>مدیریت علاقهمندیها</b>');
    expect(text).toContain('✅ انتخابشده: ۱ از ۱۰');
    expect(text).not.toContain('سقف مجاز');
  });

  it('explains the limit when it is reached', () => {
    const view: FavoritesManageView = {
      options: [],
      limit: 2,
      selectedCount: 2,
      limitReached: true,
    };

    const text = formatFavoritesManageScreen(view);

    expect(text).toContain('به سقف مجاز (۲ مورد) رسیدهاید.');
    expect(formatFavoriteLimitReached(2)).toContain('سقف مجاز (۲ مورد)');
  });
});

describe('static screens', () => {
  it('renders a welcome that introduces the product', () => {
    const text = formatWelcomeScreen();

    expect(text).toContain('سلام');
    expect(text).toContain('طلای اتابک');
    expect(text).toContain('یکی از گزینههای زیر را انتخاب کنید');
  });

  it('renders the main menu', () => {
    const text = formatMenuScreen();

    expect(text).toContain('منوی اصلی');
    expect(text).toContain('قیمت لحظهای');
  });

  it('renders the alert placeholder without promising a working feature', () => {
    const text = formatAlertsPlaceholder();

    expect(text).toContain('بهزودی فعال میشود');
  });

  it('renders the channel CTA with the configured handle', () => {
    expect(formatChannelScreen('@tala_atabak')).toContain('@tala_atabak');
  });

  it('renders a safe expired-callback answer', () => {
    expect(formatExpiredCallback()).toContain('دیگر معتبر نیست');
  });
});

import { CHANNEL_HANDLE } from '../common/branding';
import {
  PublishableMarketUpdate,
  PublishablePrice,
} from '../market/market.types';
import { createAppConfigService } from '../testing/test-doubles';
import { PriceMessageBuilder } from './price-message.builder';

const price = (
  overrides: Partial<PublishablePrice> = {},
): PublishablePrice => ({
  symbol: 'IR_GOLD_18K',
  label: 'طلای ۱۸ عیار',
  section: 'gold',
  unit: 'RIAL',
  price: 17_981_900,
  percentageChange: 1.25,
  direction: 'UP',
  dailyChange: 100_000,
  dailyChangePercent: 0.6,
  ...overrides,
});

const update = (prices: PublishablePrice[]): PublishableMarketUpdate => ({
  publishable: true,
  source: 'https://api.example.test/prices',
  receivedAt: '2026-09-30T09:00:00.000Z',
  sourceTimestamp: null,
  dayKey: '2026-09-30',
  dateFa: '۱۴۰۵/۰۷/۰۸',
  timeFa: '۱۲:۳۰',
  prices,
  accepted: [],
  rejected: [],
  staleSymbols: [],
});

const build = (prices: PublishablePrice[], env = {}) =>
  new PriceMessageBuilder(createAppConfigService(env)).build(update(prices));

describe('PriceMessageBuilder (validated data only)', () => {
  it('renders an approved price with an explicit unit and direction', () => {
    const text = build([price()]);

    expect(text).toContain('طلای ۱۸ عیار: <b>۱۷٬۹۸۱٬۹۰۰ ریال</b> 🔺 (+۱٫۲۵%)');
    expect(text).toContain('گزارش لحظه‌ای بازار');
  });

  it('respects the configured display unit', () => {
    const text = build([price()], { PRICE_DISPLAY_UNIT: 'TOMAN' });

    expect(text).toContain('۱٬۷۹۸٬۱۹۰ تومان');
  });

  it('renders USD-quoted instruments in USD', () => {
    const text = build([
      price({
        symbol: 'XAUUSD',
        label: 'اونس جهانی',
        unit: 'USD',
        price: 2650.75,
      }),
    ]);

    expect(text).toContain('اونس جهانی');
    expect(text).toContain('دلار');
    expect(text).not.toContain('ریال');
  });

  it('uses the neutral marker when no comparison baseline exists', () => {
    const text = build([
      price({ direction: 'UNKNOWN', percentageChange: null }),
    ]);

    expect(text).toContain('◽');
    expect(text).not.toContain('%');
  });

  it('groups prices into the gold / coins / currency sections', () => {
    const text = build([
      price(),
      price({
        symbol: 'IR_COIN_EMAMI',
        label: 'سکه امامی',
        section: 'coins',
        price: 98_500_000,
      }),
      price({
        symbol: 'USD',
        label: 'دلار آمریکا',
        section: 'currency',
        price: 1_032_000,
      }),
    ]);

    expect(text).toContain('🟨 <b>طلا</b>');
    expect(text).toContain('🪙 <b>سکه</b>');
    expect(text).toContain('💰 <b>بازار ارز</b>');
  });

  it('carries the shared brand footer', () => {
    const text = build([price()]);

    expect(text).toContain(CHANNEL_HANDLE);
    expect(text).toContain('09123510031');
    expect(text).not.toContain('@atabak_gold');
  });

  it('refuses to render a non-publishable update', () => {
    const builder = new PriceMessageBuilder(createAppConfigService());
    const blocked: PublishableMarketUpdate = {
      ...update([]),
      publishable: false,
      blockingReason: 'INVALID_SCHEMA',
    };

    expect(() => builder.build(blocked)).toThrow(/non-publishable update/);
  });
});

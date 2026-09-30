import { CHANNEL_HANDLE } from '../common/branding';
import { MarketData } from '../price/price.interface';
import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import { PriceMessageBuilder } from './price-message.builder';
import { TrendTracker } from './trend-tracker';

const DAY_KEY = '2026-09-30';

const marketData = (): MarketData => ({
  gold: [
    { symbol: 'IR_GOLD_18K', priceInRial: 17_981_900, changePercent: 1.25 },
    { symbol: 'IR_COIN_EMAMI', priceInRial: 100_000_000, changePercent: null },
  ],
  currency: [{ symbol: 'USD', priceInRial: 1_000_000, changePercent: -0.5 }],
  fetchedAt: '2026-09-30T09:00:00.000Z',
});

const build = (env: EnvMap = {}) => {
  const trends = new TrendTracker();
  const builder = new PriceMessageBuilder(createAppConfigService(env), trends);

  return { trends, builder };
};

const CONTEXT = { dayKey: DAY_KEY, dateFa: '۱۴۰۵/۰۷/۰۸', timeFa: '۱۲:۳۰' };

describe('PriceMessageBuilder', () => {
  it('renders every price with its unit attached (no Rial/Toman ambiguity)', () => {
    const { builder } = build();
    const { text } = builder.build(marketData(), CONTEXT);

    expect(text).toContain('طلای ۱۸ عیار: <b>۱۷٬۹۸۱٬۹۰۰ ریال</b>');
    expect(text).toContain('۱۷٬۹۸۱٬۹۰۰ ریال');
    expect(text).toContain('۱٬۰۰۰٬۰۰۰ ریال');
    expect(text).not.toContain('(تومان)');
  });

  it('respects the configured display unit and converts centrally', () => {
    const { builder } = build({ PRICE_DISPLAY_UNIT: 'TOMAN' });
    const { text } = builder.build(marketData(), CONTEXT);

    expect(text).toContain('۱٬۷۹۸٬۱۹۰ تومان');
    expect(text).toContain('۱۰۰٬۰۰۰ تومان');
  });

  it('uses the shared brand footer', () => {
    const { builder } = build();
    const { text } = builder.build(marketData(), CONTEXT);

    expect(text).toContain(CHANNEL_HANDLE);
    expect(text).toContain('09123510031');
    expect(text).not.toContain('@atabak_gold');
  });

  it('marks the first message of a day with the neutral trend marker', () => {
    const { builder } = build();
    const { text } = builder.build(marketData(), CONTEXT);

    expect(text).toContain('◽');
    expect(text).not.toContain('🔺');
  });

  it('shows the trend against the previously committed snapshot', () => {
    const { builder, trends } = build();
    trends.commit(
      [{ symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 }],
      DAY_KEY,
    );

    const { text } = builder.build(marketData(), CONTEXT);

    expect(text).toContain('🔺');
    expect(text).toContain('(+۱٫۲۵%)');
  });

  it('returns a snapshot that only contains symbols actually present in the message', () => {
    const { builder } = build();
    const { snapshot } = builder.build(marketData(), CONTEXT);

    expect(snapshot).toEqual([
      { symbol: 'IR_GOLD_18K', priceInRial: 17_981_900 },
      { symbol: 'IR_COIN_EMAMI', priceInRial: 100_000_000 },
      { symbol: 'USD', priceInRial: 1_000_000 },
    ]);
  });

  it('skips symbols that are missing from the API payload', () => {
    const { builder } = build();
    const data = marketData();
    data.gold = [];

    const { text, snapshot } = builder.build(data, CONTEXT);

    expect(text).not.toContain('طلای ۱۸ عیار');
    expect(snapshot.map((entry) => entry.symbol)).toEqual(['USD']);
  });
});

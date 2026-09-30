import {
  PublishableMarketUpdate,
  PublishablePrice,
} from '../market/market.types';
import { createAppConfigService } from '../testing/test-doubles';
import { PosterService } from './poster.service';

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
  dailyChange: 0,
  dailyChangePercent: 0,
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

const create = (env = {}) => new PosterService(createAppConfigService(env));

describe('PosterService (validated data only)', () => {
  it('renders gold/coins and currency sections from approved prices', () => {
    const text = create().generatePricePoster(
      update([
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
      ]),
    );

    expect(text).toContain('🔸 <b>طلا و سکه</b>');
    expect(text).toContain('🔹 <b>ارز</b>');
    expect(text).toContain('طلای ۱۸ عیار');
    expect(text).toContain('۱۷٬۹۸۱٬۹۰۰ ریال');
    expect(text).toContain('@tala_atabak');
  });

  it('limits each section to five rows', () => {
    const gold = Array.from({ length: 7 }, (_, index) =>
      price({
        symbol: `G${index}`,
        label: `طلا ${index}`,
        price: 1_000_000 + index,
      }),
    );

    const text = create().generatePricePoster(update(gold));
    const rows = text.split('\n').filter((line) => line.startsWith('▫️'));

    expect(rows).toHaveLength(5);
  });

  it('never renders a rejected price (it cannot receive one)', () => {
    const service = create();
    const blocked: PublishableMarketUpdate = {
      ...update([price()]),
      publishable: false,
      blockingReason: 'NO_ACCEPTED_PRICES',
      prices: [],
    };

    expect(() => service.generatePricePoster(blocked)).toThrow(
      /non-publishable update/,
    );
  });
});

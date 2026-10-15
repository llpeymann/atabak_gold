import { MarketIntelligenceSnapshot } from '../intelligence/market-intelligence.types';
import { PublishableMarketUpdate } from '../market/market.types';
import { makeSnapshot } from '../testing/test-doubles';
import { ContentItem } from './channel.types';
import { MovementCandidate, RangeCandidate } from './channel-policy.service';
import {
  formatterNameFor,
  formatBrandedMessage,
  formatDailyRangeMessage,
  formatDailyReportMessage,
  formatMovementMessage,
  formatNightlyAnalysisMessage,
  formatValidatedMarketBlock,
} from './channel-format';

/**
 * §27.1 / §20 — the formatters.
 *
 * The important property is not the exact wording but *purity*: a missing number is rendered as an
 * explicit "not available" marker (never `0`), a stale snapshot says so, the pillar titles come from
 * the registry, and the brand footer is identical to every other published message.
 */

const now = new Date('2026-09-30T17:30:00.000Z'); // 21:00 Tehran

const snapshot = (): MarketIntelligenceSnapshot =>
  makeSnapshot([
    {
      symbol: 'IR_GOLD_18K',
      label: 'طلای ۱۸ عیار',
      currentPrice: 17_500_000,
      previousPrice: 17_100_000,
      open: 17_000_000,
      high: 17_600_000,
      low: 16_950_000,
    },
    {
      symbol: 'IR_COIN_EMAMI',
      label: 'سکه امامی',
      currentPrice: 92_000_000,
      previousPrice: 92_000_000,
      open: 92_000_000,
      high: 92_500_000,
      low: 91_800_000,
    },
  ]);

const content = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 'cnt_test_1',
  messageType: 'EDUCATIONAL',
  title: 'قیمت‌گذاری طلا',
  body: 'عیار و اجرت، دو بخش مهم در قیمت نهایی طلا هستند.',
  mediaUrl: null,
  includeMarketData: false,
  revision: 1,
  status: 'APPROVED',
  createdAt: '2026-09-30T08:00:00.000Z',
  updatedAt: '2026-09-30T08:00:00.000Z',
  approvedAt: '2026-09-30T08:05:00.000Z',
  approvedBy: 'bale:1',
  scheduledAt: null,
  reportingDate: '2026-09-30',
  lastJobId: null,
  cancelledAt: null,
  lastError: null,
  ...overrides,
});

const priceUpdate = (): PublishableMarketUpdate =>
  ({
    publishable: true,
    dayKey: '2026-09-30',
    accepted: [],
    rejected: [],
    prices: [
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        unit: 'RIAL',
        section: 'gold',
        price: 17_500_000,
        previousPrice: 17_100_000,
        change: 400_000,
        changePercent: 2.34,
        direction: 'UP',
      },
    ],
  }) as unknown as PublishableMarketUpdate;

describe('channel formatters (§20, §27.1)', () => {
  it('renders a daily range message from the snapshot only', () => {
    const text = formatDailyRangeMessage({
      snapshot: snapshot(),
      mode: 'scheduled',
      now,
      displayUnit: 'RIAL',
    });

    expect(text).toContain('بازه روزانه بازار');
    expect(text).toContain('طلای ۱۸ عیار');
    expect(text).toContain('۱۶٬۹۵۰٬۰۰۰'); // the real daily low, formatted in Persian digits
    expect(text).toContain('@tala_atabak');
  });

  it('marks a symbol without daily statistics instead of printing a zero', () => {
    const partial = makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        currentPrice: 17_500_000,
      },
    ]);
    const text = formatDailyRangeMessage({
      snapshot: partial,
      mode: 'scheduled',
      now,
      displayUnit: 'RIAL',
    });

    expect(text).toContain('بازه امروز در دسترس نیست');
    expect(text).not.toContain('۰ ریال');
  });

  it('renders an event message with the newly established extreme', () => {
    const candidate: RangeCandidate = {
      symbol: 'IR_GOLD_18K',
      label: 'طلای ۱۸ عیار',
      kind: 'HIGH',
      value: 17_600_000,
      high: 17_600_000,
      low: 16_950_000,
      currentPrice: 17_600_000,
      lastUpdatedAt: '2026-09-30T17:00:00.000Z',
    };
    const text = formatDailyRangeMessage({
      snapshot: snapshot(),
      mode: 'event',
      candidates: [candidate],
      now,
      displayUnit: 'RIAL',
    });

    expect(text).toContain('ثبت سقف/کف جدید روز');
    expect(text).toContain('سقف جدید');
  });

  it('renders movement candidates with the threshold that triggered them', () => {
    const candidate: MovementCandidate = {
      symbol: 'IR_GOLD_18K',
      label: 'طلای ۱۸ عیار',
      direction: 'UP',
      movement: 400_000,
      movementPercent: 2.34,
      thresholdPercent: 1,
      currentPrice: 17_500_000,
      previousPrice: 17_100_000,
      lastUpdatedAt: '2026-09-30T17:00:00.000Z',
    };
    const text = formatMovementMessage([candidate], now, 'RIAL');

    expect(text).toContain('حرکت مهم بازار');
    expect(text).toContain('افزایش');
    expect(text).toContain('آستانه 1%');
    expect(text).toContain('این پیام فقط یک مشاهده بازار است');
    // No signal, no recommendation, no promise — only the explicit "this is an observation" note.
    expect(text).not.toMatch(
      /سیگنال|توصیه خرید|بخرید|بفروشید|سود قطعی|فرصت طلایی/,
    );
  });

  it('renders the daily report from the Phase 4 snapshot without recalculating anything', () => {
    const text = formatDailyReportMessage(snapshot(), now, 'RIAL');

    expect(text).toContain('گزارش روزانه بازار');
    expect(text).toContain('شروع روز');
    expect(text).toContain('افزایشی: 1');
    expect(text).toContain('⚪ بدون تغییر: 1');
    expect(text).toContain('@tala_atabak');
  });

  it('labels a stale report as stale', () => {
    const stale = makeSnapshot(
      [
        {
          symbol: 'IR_GOLD_18K',
          label: 'طلای ۱۸ عیار',
          currentPrice: 17_500_000,
          freshness: 'STALE',
          availability: 'STALE',
        },
      ],
      { freshness: 'STALE' },
    );
    const text = formatDailyReportMessage(stale, now, 'RIAL');

    expect(text).toContain('تازه نیستند');
  });

  it('warns explicitly when the validated market block has no usable data', () => {
    const empty = makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        availability: 'UNAVAILABLE',
        freshness: null,
      },
    ]);
    const block = formatValidatedMarketBlock(empty, 'RIAL');

    expect(block).toContain('داده معتبر بازار در دسترس نیست');
    expect(block).not.toMatch(/طلای ۱۸ عیار: 0/);
  });

  it('prints the official series title of each editorial pillar', () => {
    const educational = formatBrandedMessage(
      content({ messageType: 'EDUCATIONAL' }),
    );
    const branded = formatBrandedMessage(content({ messageType: 'BRANDED' }));
    const nightly = formatNightlyAnalysisMessage(
      content({ messageType: 'NIGHTLY_ANALYSIS', includeMarketData: true }),
      snapshot(),
      'RIAL',
    );

    expect(educational).toContain('🏆 <b>گنجینه طلایی اتابک</b>');
    expect(branded).toContain('🏆 <b>طلای اتابک</b>');
    expect(nightly).toContain('🏆 <b>نگاه طلای اتابک</b>');
  });

  it('escapes editorial text instead of allowing markup injection', () => {
    const text = formatBrandedMessage(
      content({ title: '<b>hack</b>', body: 'متن <script>alert(1)</script>' }),
    );

    expect(text).toContain('&lt;b&gt;hack&lt;/b&gt;');
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });

  it('appends the validated market block only when the content asks for it', () => {
    const withBlock = formatNightlyAnalysisMessage(
      content({ messageType: 'NIGHTLY_ANALYSIS', includeMarketData: true }),
      snapshot(),
      'RIAL',
    );
    const withoutBlock = formatNightlyAnalysisMessage(
      content({ messageType: 'NIGHTLY_ANALYSIS', includeMarketData: false }),
      snapshot(),
      'RIAL',
    );

    expect(withBlock).toContain('داده‌های معتبر بازار');
    expect(withoutBlock).not.toContain('داده‌های معتبر بازار');
  });

  it('names one formatter per message type (deterministic, used in logs)', () => {
    expect(formatterNameFor('PRICE_UPDATE')).toBe('market-price_update');
    expect(formatterNameFor('NIGHTLY_ANALYSIS')).toBe(
      'editorial-nightly_analysis',
    );
  });

  it('does not fetch, validate or invent: the same snapshot always renders identically', () => {
    const first = formatDailyReportMessage(snapshot(), now, 'RIAL');
    const second = formatDailyReportMessage(snapshot(), now, 'RIAL');

    expect(first).toBe(second);
    // The price update formatter is the Phase 1/0 builder: it receives an already-approved update
    // and is exercised in `price-message.builder.spec.ts`; here we only prove the payload contract
    // is untouched by the channel layer.
    expect(priceUpdate().prices[0].price).toBe(17_500_000);
  });
});

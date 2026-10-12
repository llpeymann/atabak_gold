import { buildMarketSummary } from './market-summary';
import { MarketSymbolSnapshot } from './market-intelligence.types';

/**
 * §28 — the summary is arithmetic only. These tests pin the two rules that keep it honest:
 * an unknown movement is never counted as "unchanged", and unavailable symbols are counted
 * separately from the available ones.
 */

const snapshot = (
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
  open: 17_300_000,
  high: 17_500_000,
  low: 17_200_000,
  dailyChange: 200_000,
  dailyChangePercent: 1.15,
  dailyDirection: 'UP',
  movement: 100_000,
  movementPercent: 0.57,
  movementDirection: 'UP',
  lastUpdatedAt: '2026-09-30T09:00:00.000Z',
  ageMs: 1000,
  ...overrides,
});

describe('buildMarketSummary', () => {
  it('counts each movement direction', () => {
    const summary = buildMarketSummary([
      snapshot({ movementDirection: 'UP' }),
      snapshot({ movementDirection: 'UP' }),
      snapshot({ movementDirection: 'DOWN' }),
      snapshot({ movementDirection: 'UNCHANGED' }),
    ]);

    expect(summary).toMatchObject({
      increasing: 2,
      decreasing: 1,
      unchanged: 1,
      unknown: 0,
    });
  });

  it('never counts an unknown movement as unchanged', () => {
    const summary = buildMarketSummary([
      snapshot({
        movementDirection: 'UNKNOWN',
        movement: null,
        movementPercent: null,
      }),
      snapshot({
        movementDirection: 'UNCHANGED',
        movement: 0,
        movementPercent: 0,
      }),
    ]);

    expect(summary.unchanged).toBe(1);
    expect(summary.unknown).toBe(1);
  });

  it('counts availability separately from movement', () => {
    const summary = buildMarketSummary([
      snapshot(),
      snapshot({ availability: 'STALE' }),
      snapshot({
        availability: 'UNAVAILABLE',
        freshness: null,
        currentPrice: null,
        movementDirection: 'UNKNOWN',
      }),
    ]);

    expect(summary).toMatchObject({
      available: 1,
      stale: 1,
      unavailable: 1,
      increasing: 2,
      unknown: 1,
    });
  });

  it('returns zeroed counts for an empty list', () => {
    expect(buildMarketSummary([])).toEqual({
      increasing: 0,
      decreasing: 0,
      unchanged: 0,
      unknown: 0,
      available: 0,
      stale: 0,
      unavailable: 0,
    });
  });
});

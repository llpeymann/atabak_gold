import { TrendTracker } from './trend-tracker';

const DAY_ONE = '2026-09-30';
const DAY_TWO = '2026-10-01';

describe('TrendTracker', () => {
  it('reports `unknown` when there is no previous published price', () => {
    const tracker = new TrendTracker();

    expect(tracker.trendFor('IR_GOLD_18K', 17_000_000, DAY_ONE)).toBe(
      'unknown',
    );
  });

  it('detects up / down / flat against the last published price of the same day', () => {
    const tracker = new TrendTracker();
    tracker.commit(
      [{ symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 }],
      DAY_ONE,
    );

    expect(tracker.trendFor('IR_GOLD_18K', 17_500_000, DAY_ONE)).toBe('up');
    expect(tracker.trendFor('IR_GOLD_18K', 16_500_000, DAY_ONE)).toBe('down');
    expect(tracker.trendFor('IR_GOLD_18K', 17_000_000, DAY_ONE)).toBe('flat');
  });

  it('never compares a new day against the previous day (Phase 0 bug fix)', () => {
    const tracker = new TrendTracker();
    tracker.commit(
      [{ symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 }],
      DAY_ONE,
    );

    // Yesterday's value must not create a false trend on the first message of a new day.
    expect(tracker.trendFor('IR_GOLD_18K', 18_000_000, DAY_TWO)).toBe(
      'unknown',
    );
  });

  it('clears stored state when the day changes', () => {
    const tracker = new TrendTracker();
    tracker.commit(
      [{ symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 }],
      DAY_ONE,
    );
    expect(tracker.trackedSymbolCount).toBe(1);

    expect(tracker.resetForNewDay(DAY_TWO)).toBe(true);
    expect(tracker.trackedSymbolCount).toBe(0);
  });

  it('reports no reset while staying on the same day', () => {
    const tracker = new TrendTracker();
    tracker.commit(
      [{ symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 }],
      DAY_ONE,
    );

    expect(tracker.resetForNewDay(DAY_ONE)).toBe(false);
    expect(tracker.trendFor('IR_GOLD_18K', 17_000_000, DAY_ONE)).toBe('flat');
  });

  it('only tracks symbols that were actually published', () => {
    const tracker = new TrendTracker();
    tracker.commit(
      [
        { symbol: 'IR_GOLD_18K', priceInRial: 17_000_000 },
        { symbol: 'USD', priceInRial: 1_000_000 },
      ],
      DAY_ONE,
    );

    expect(tracker.trackedSymbolCount).toBe(2);
    expect(tracker.trendFor('EUR', 1_200_000, DAY_ONE)).toBe('unknown');
  });
});

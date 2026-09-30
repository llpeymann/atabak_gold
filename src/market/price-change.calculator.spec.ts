import { calculatePriceChange } from './price-change.calculator';

describe('calculatePriceChange', () => {
  it('calculates UP with full precision', () => {
    const change = calculatePriceChange(17_121_400, 17_000_000);

    expect(change.direction).toBe('UP');
    expect(change.absoluteChange).toBe(121_400);
    // 0.714117647…% — internal precision is preserved (rounding happens at display time only).
    expect(change.percentageChange).toBeCloseTo(0.7141176, 6);
  });

  it('calculates DOWN', () => {
    const change = calculatePriceChange(16_950_000, 17_000_000);

    expect(change.direction).toBe('DOWN');
    expect(change.absoluteChange).toBe(-50_000);
    expect(change.percentageChange).toBeCloseTo(-0.2941176, 6);
  });

  it('calculates UNCHANGED', () => {
    const change = calculatePriceChange(17_000_000, 17_000_000);

    expect(change).toEqual({
      absoluteChange: 0,
      percentageChange: 0,
      direction: 'UNCHANGED',
    });
  });

  it('reports UNKNOWN when there is no baseline', () => {
    expect(calculatePriceChange(17_000_000, null)).toEqual({
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
    });
  });

  it('handles the division-by-zero edge case without producing Infinity', () => {
    expect(calculatePriceChange(17_000_000, 0)).toEqual({
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
    });
  });

  it('rejects unusable baselines', () => {
    expect(calculatePriceChange(17_000_000, Number.NaN).direction).toBe(
      'UNKNOWN',
    );
    expect(calculatePriceChange(17_000_000, -5).direction).toBe('UNKNOWN');
    expect(calculatePriceChange(Number.NaN, 17_000_000).direction).toBe(
      'UNKNOWN',
    );
  });
});

import { PriceDirection } from './market.types';

export interface PriceChange {
  absoluteChange: number | null;
  percentageChange: number | null;
  direction: PriceDirection;
}

/**
 * Deterministic price-change calculation.
 *
 * Values are never rounded here (rounding is a presentation concern); the caller receives the
 * full precision of the calculation so later phases can use it as-is.
 * When the baseline is unavailable — or unusable, i.e. zero/negative — the change is reported as
 * `null` with direction `UNKNOWN` instead of producing `Infinity`/`NaN`.
 */
export function calculatePriceChange(
  current: number,
  baseline: number | null | undefined,
): PriceChange {
  if (
    baseline === null ||
    baseline === undefined ||
    !Number.isFinite(baseline) ||
    baseline <= 0 ||
    !Number.isFinite(current)
  ) {
    return {
      absoluteChange: null,
      percentageChange: null,
      direction: 'UNKNOWN',
    };
  }

  const absoluteChange = current - baseline;
  const percentageChange = (absoluteChange / baseline) * 100;

  return {
    absoluteChange,
    percentageChange,
    direction: directionOf(absoluteChange),
  };
}

export function directionOf(absoluteChange: number): PriceDirection {
  if (absoluteChange > 0) {
    return 'UP';
  }

  if (absoluteChange < 0) {
    return 'DOWN';
  }

  return 'UNCHANGED';
}

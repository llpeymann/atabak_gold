import {
  MarketSummary,
  MarketSymbolSnapshot,
} from './market-intelligence.types';

/**
 * Deterministic, purely descriptive summary of a snapshot (§28).
 *
 * Deliberately arithmetic only: counting symbols per movement direction. It never produces an
 * interpretation ("the market is rising"), a recommendation or a forecast — Phase 4 is descriptive.
 * Symbols with an unknown movement (no previous valid price) are counted separately so that a
 * missing comparison can never be presented as "unchanged".
 */
export function buildMarketSummary(
  symbols: readonly MarketSymbolSnapshot[],
): MarketSummary {
  const summary: MarketSummary = {
    increasing: 0,
    decreasing: 0,
    unchanged: 0,
    unknown: 0,
    available: 0,
    stale: 0,
    unavailable: 0,
  };

  for (const symbol of symbols) {
    switch (symbol.availability) {
      case 'AVAILABLE':
        summary.available += 1;
        break;
      case 'STALE':
        summary.stale += 1;
        break;
      default:
        summary.unavailable += 1;
        break;
    }

    // Movement direction only: the daily change is reported per symbol, never aggregated as a
    // market-wide claim.
    switch (symbol.movementDirection) {
      case 'UP':
        summary.increasing += 1;
        break;
      case 'DOWN':
        summary.decreasing += 1;
        break;
      case 'UNCHANGED':
        summary.unchanged += 1;
        break;
      default:
        summary.unknown += 1;
        break;
    }
  }

  return summary;
}

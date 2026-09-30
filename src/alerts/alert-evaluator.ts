import {
  Alert,
  AlertEvaluationResult,
  MarketObservation,
  TriggerReason,
} from './alert.types';

/**
 * Pure condition evaluation (Phase 3 §54).
 *
 * No I/O, no platform call, no mutation: given an alert and one accepted market observation it
 * answers "trigger or not" deterministically, so every rule of §5/§11/§12/§13 is unit-testable
 * without a store, a platform or a clock.
 */

const REASON_BY_TYPE: Record<Alert['type'], TriggerReason> = {
  PRICE_ABOVE: 'PRICE_ABOVE_REACHED',
  PRICE_BELOW: 'PRICE_BELOW_REACHED',
  PERCENT_INCREASE: 'PERCENT_INCREASE_REACHED',
  PERCENT_DECREASE: 'PERCENT_DECREASE_REACHED',
};

export function evaluateAlert(
  alert: Alert,
  observation: MarketObservation,
): AlertEvaluationResult {
  const base: AlertEvaluationResult = {
    alertId: alert.id,
    shouldTrigger: false,
    reason: null,
    currentPrice: observation.currentPrice,
    target: 0,
    changePercent: null,
    evaluatedAt: observation.observedAt,
  };

  if (alert.symbol !== observation.symbol) {
    return base;
  }

  // Only an ACTIVE alert may fire. The caller already filters, this is a defensive invariant:
  // a disabled/deleted/triggered alert must never produce a trigger (§15, §18, §82).
  if (alert.status !== 'ACTIVE') {
    return base;
  }

  if (
    !Number.isFinite(observation.currentPrice) ||
    observation.currentPrice <= 0
  ) {
    return base;
  }

  switch (alert.type) {
    case 'PRICE_ABOVE':
      return evaluatePriceAbove(alert, observation, base);
    case 'PRICE_BELOW':
      return evaluatePriceBelow(alert, observation, base);
    case 'PERCENT_INCREASE':
    case 'PERCENT_DECREASE':
      return evaluatePercentage(alert, observation, base);
    default:
      return base;
  }
}

/**
 * Crossing semantics (§11/§12/§13): `previous < target` **and** `current >= target`.
 *
 * This is what prevents a newly created (or re-enabled) alert from firing only because the
 * market is already beyond its target: the market must actually cross the target between two
 * valid observations, and a jump over the target (gap) still counts.
 */
function evaluatePriceAbove(
  alert: Alert,
  observation: MarketObservation,
  base: AlertEvaluationResult,
): AlertEvaluationResult {
  const target = alert.targetPrice;

  if (target === null || !Number.isFinite(target)) {
    return base;
  }

  const previous = observation.previousPrice;
  const result = { ...base, target };

  if (previous === null || !Number.isFinite(previous)) {
    // Without a preceding observation a crossing cannot be established. The alert stays
    // active and will be evaluated again on the next accepted price (§62).
    return result;
  }

  if (previous < target && observation.currentPrice >= target) {
    return {
      ...result,
      shouldTrigger: true,
      reason: REASON_BY_TYPE.PRICE_ABOVE,
    };
  }

  return result;
}

/** `previous > target` **and** `current <= target`. */
function evaluatePriceBelow(
  alert: Alert,
  observation: MarketObservation,
  base: AlertEvaluationResult,
): AlertEvaluationResult {
  const target = alert.targetPrice;

  if (target === null || !Number.isFinite(target)) {
    return base;
  }

  const previous = observation.previousPrice;
  const result = { ...base, target };

  if (previous === null || !Number.isFinite(previous)) {
    return result;
  }

  if (previous > target && observation.currentPrice <= target) {
    return {
      ...result,
      shouldTrigger: true,
      reason: REASON_BY_TYPE.PRICE_BELOW,
    };
  }

  return result;
}

/**
 * Percentage alerts compare against the **persisted baseline** (§6/§7):
 *
 *   changePercent = ((current - baseline) / baseline) * 100
 *
 * The comparison uses the full-precision value — rounding happens only for presentation (§53).
 * No crossing is required here (the baseline is an explicit starting point), so equality with
 * the target triggers.
 */
function evaluatePercentage(
  alert: Alert,
  observation: MarketObservation,
  base: AlertEvaluationResult,
): AlertEvaluationResult {
  const target = alert.targetPercent;
  const baseline = alert.baselinePrice;

  if (
    target === null ||
    !Number.isFinite(target) ||
    // `targetPercent` is a positive magnitude (the direction lives in `type`): a zero or
    // negative value can only come from a corrupt record and must never fire.
    target <= 0 ||
    baseline === null ||
    !Number.isFinite(baseline) ||
    baseline <= 0
  ) {
    return base;
  }

  const changePercent =
    ((observation.currentPrice - baseline) / baseline) * 100;
  const result: AlertEvaluationResult = {
    ...base,
    target,
    changePercent,
  };

  if (alert.type === 'PERCENT_INCREASE' && changePercent >= target) {
    return {
      ...result,
      shouldTrigger: true,
      reason: REASON_BY_TYPE.PERCENT_INCREASE,
    };
  }

  if (alert.type === 'PERCENT_DECREASE' && changePercent <= -target) {
    return {
      ...result,
      shouldTrigger: true,
      reason: REASON_BY_TYPE.PERCENT_DECREASE,
    };
  }

  return result;
}

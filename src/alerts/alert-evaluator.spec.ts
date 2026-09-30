import { evaluateAlert } from './alert-evaluator';
import {
  Alert,
  AlertStatus,
  AlertType,
  MarketObservation,
} from './alert.types';

/**
 * Pure evaluation matrix (Phase 3 §54/§55).
 *
 * `evaluateAlert` is the only place that decides "trigger or not", so every rule is pinned here:
 * crossing (not "already true"), equality, gaps, percentage baselines, disabled/deleted states
 * and malformed numbers. No store, no platform, no clock is involved.
 */

const ALERT_ID = 'alr_test_1';
const SYMBOL = 'IR_GOLD_18K';

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: ALERT_ID,
    userId: 'usr_1',
    platform: 'bale',
    symbol: SYMBOL,
    type: 'PRICE_ABOVE',
    status: 'ACTIVE',
    targetPrice: 17_500_000,
    targetPercent: null,
    direction: null,
    baselinePrice: null,
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T09:00:00.000Z',
    triggeredAt: null,
    disabledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function observation(
  overrides: Partial<MarketObservation> = {},
): MarketObservation {
  return {
    symbol: SYMBOL,
    label: 'طلای ۱۸ عیار',
    currentPrice: 17_600_000,
    previousPrice: 17_400_000,
    baseline: 'SAME_DAY',
    observedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

const percentAlert = (
  type: AlertType,
  targetPercent: number,
  baselinePrice: number,
): Alert =>
  alert({
    type,
    targetPrice: null,
    targetPercent,
    direction: type === 'PERCENT_INCREASE' ? 'UP' : 'DOWN',
    baselinePrice,
  });

describe('evaluateAlert — PRICE_ABOVE', () => {
  it('triggers when the price crosses the target from below', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 17_499_000, currentPrice: 17_500_001 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('PRICE_ABOVE_REACHED');
    expect(result.target).toBe(17_500_000);
    expect(result.currentPrice).toBe(17_500_001);
    expect(result.evaluatedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('triggers on exact equality (current >= target)', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 17_499_999, currentPrice: 17_500_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
  });

  it('triggers on a gap that jumps over the target', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 10_000_000, currentPrice: 19_000_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('PRICE_ABOVE_REACHED');
  });

  it('does not trigger while the price stays below the target', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 17_000_000, currentPrice: 17_499_999 }),
    );

    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('does not fire merely because the condition is already true (no crossing)', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 18_000_000, currentPrice: 18_100_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });

  it('treats "previous exactly at the target" as not yet crossed', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 17_500_000, currentPrice: 17_600_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });

  it('cannot trigger without a preceding observation', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: null, currentPrice: 18_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
    expect(result.target).toBe(17_500_000);
  });

  it('reports a non-null target even when it does not trigger', () => {
    const result = evaluateAlert(
      alert({ targetPrice: 17_500_000 }),
      observation({ previousPrice: 17_000_000, currentPrice: 17_100_000 }),
    );

    // The UI shows the target of a non-triggering evaluation, so it must be reported.
    expect(result.target).toBe(17_500_000);
    expect(result.changePercent).toBeNull();
  });
});

describe('evaluateAlert — PRICE_BELOW', () => {
  const below = (target = 17_500_000): Alert =>
    alert({ type: 'PRICE_BELOW', targetPrice: target });

  it('triggers when the price crosses the target from above', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 17_600_000, currentPrice: 17_499_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('PRICE_BELOW_REACHED');
  });

  it('triggers on exact equality (current <= target)', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 17_600_000, currentPrice: 17_500_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
  });

  it('triggers on a downward gap', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 19_000_000, currentPrice: 16_000_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
  });

  it('does not trigger while the price stays above the target', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 18_000_000, currentPrice: 17_500_001 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });

  it('does not fire when the condition is already true and nothing crosses', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 16_000_000, currentPrice: 15_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });

  it('does not treat "previous exactly at the target" as crossed', () => {
    const result = evaluateAlert(
      below(),
      observation({ previousPrice: 17_500_000, currentPrice: 17_400_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });
});

describe('evaluateAlert — percentage alerts', () => {
  it('triggers when the increase reaches the target exactly', () => {
    const result = evaluateAlert(
      percentAlert('PERCENT_INCREASE', 5, 1_000_000),
      observation({ currentPrice: 1_050_000, previousPrice: 1_000_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('PERCENT_INCREASE_REACHED');
    expect(result.changePercent).toBeCloseTo(5, 10);
    expect(result.target).toBe(5);
  });

  it('does not trigger just below the target', () => {
    const result = evaluateAlert(
      percentAlert('PERCENT_INCREASE', 5, 1_000_000),
      observation({ currentPrice: 1_049_999.99, previousPrice: 1_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
    expect(result.changePercent).toBeCloseTo(4.999999, 6);
  });

  it('uses the persisted baseline, never the previous observation', () => {
    // The baseline (1,000,000) is older than the preceding observation; only the baseline counts.
    const result = evaluateAlert(
      percentAlert('PERCENT_INCREASE', 5, 1_000_000),
      observation({ currentPrice: 1_100_000, previousPrice: 900_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.changePercent).toBeCloseTo(10, 10);
  });

  it('triggers a decrease at the negative target', () => {
    const result = evaluateAlert(
      percentAlert('PERCENT_DECREASE', 5, 1_000_000),
      observation({ currentPrice: 950_000, previousPrice: 1_000_000 }),
    );

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toBe('PERCENT_DECREASE_REACHED');
    expect(result.changePercent).toBeCloseTo(-5, 10);
  });

  it('does not let an increase fire a decrease alert (direction is explicit)', () => {
    const result = evaluateAlert(
      percentAlert('PERCENT_DECREASE', 5, 1_000_000),
      observation({ currentPrice: 1_500_000, previousPrice: 1_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
    expect(result.changePercent).toBeCloseTo(50, 10);
  });

  it('does not let a decrease fire an increase alert', () => {
    const result = evaluateAlert(
      percentAlert('PERCENT_INCREASE', 5, 1_000_000),
      observation({ currentPrice: 500_000, previousPrice: 1_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
  });

  it('compares with full precision (rounding is presentation-only)', () => {
    const alertUnderTest = percentAlert('PERCENT_INCREASE', 0.01, 3);

    expect(
      evaluateAlert(
        alertUnderTest,
        observation({ currentPrice: 3.00029, previousPrice: 3 }),
      ).shouldTrigger,
    ).toBe(false);

    expect(
      evaluateAlert(
        alertUnderTest,
        observation({ currentPrice: 3.0003, previousPrice: 3 }),
      ).shouldTrigger,
    ).toBe(true);
  });

  it('refuses to evaluate an unusable baseline', () => {
    for (const baseline of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateAlert(
        percentAlert('PERCENT_INCREASE', 5, baseline),
        observation({ currentPrice: 2_000_000, previousPrice: 1_000_000 }),
      );

      expect(result.shouldTrigger).toBe(false);
      expect(result.changePercent).toBeNull();
    }
  });

  it('refuses a missing or malformed target percent', () => {
    for (const target of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      const broken: Alert = {
        ...percentAlert('PERCENT_INCREASE', 5, 1_000_000),
        targetPercent: target,
      };

      expect(
        evaluateAlert(broken, observation({ currentPrice: 2_000_000 }))
          .shouldTrigger,
      ).toBe(false);
    }
  });
});

describe('evaluateAlert — invariants', () => {
  it('ignores an observation of another symbol', () => {
    const result = evaluateAlert(
      alert({ symbol: 'IR_GOLD_18K', targetPrice: 17_500_000 }),
      observation({ symbol: 'USD', currentPrice: 2_000_000 }),
    );

    expect(result.shouldTrigger).toBe(false);
    expect(result.changePercent).toBeNull();
  });

  it('never triggers a non-ACTIVE alert', () => {
    for (const status of [
      'DISABLED',
      'TRIGGERED',
      'DELETED',
    ] as AlertStatus[]) {
      const result = evaluateAlert(
        alert({ status, targetPrice: 17_500_000 }),
        observation({ previousPrice: 17_000_000, currentPrice: 17_600_000 }),
      );

      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toBeNull();
    }
  });

  it('never triggers on a malformed current price', () => {
    for (const price of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = evaluateAlert(
        alert({ targetPrice: 17_500_000 }),
        observation({ previousPrice: -1, currentPrice: price }),
      );

      expect(result.shouldTrigger).toBe(false);
    }
  });

  it('never triggers on a malformed previous price', () => {
    for (const previous of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const result = evaluateAlert(
        alert({ targetPrice: 17_500_000 }),
        observation({ previousPrice: previous, currentPrice: 18_000_000 }),
      );

      expect(result.shouldTrigger).toBe(false);
    }
  });

  it('refuses a malformed target price', () => {
    for (const target of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateAlert(
        alert({ targetPrice: target }),
        observation({ previousPrice: 1, currentPrice: 20_000_000 }),
      );

      expect(result.shouldTrigger).toBe(false);
    }
  });

  it('does not mutate the alert or the observation', () => {
    const input = alert({ targetPrice: 17_500_000 });
    const snapshot = { ...input };
    const observed = observation({
      previousPrice: 17_000_000,
      currentPrice: 18_000_000,
    });
    const observedSnapshot = { ...observed };

    evaluateAlert(input, observed);

    expect(input).toEqual(snapshot);
    expect(observed).toEqual(observedSnapshot);
  });

  it('is deterministic', () => {
    const input = percentAlert('PERCENT_INCREASE', 2, 1_000_000);
    const observed = observation({
      currentPrice: 1_030_000,
      previousPrice: 1_000_000,
    });

    expect(evaluateAlert(input, observed)).toEqual(
      evaluateAlert(input, observed),
    );
  });

  it('carries the alert id into the result', () => {
    const result = evaluateAlert(alert({ id: 'alr_abc123_x' }), observation());

    expect(result.alertId).toBe('alr_abc123_x');
  });
});

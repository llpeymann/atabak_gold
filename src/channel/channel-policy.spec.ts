import { Logger } from '@nestjs/common';

import { PublicationStore } from './publication.store';
import {
  ChannelPolicyService,
  MOVEMENT_RE_ARM_FRACTION,
} from './channel-policy.service';
import { createAppConfigService, makeSnapshot } from '../testing/test-doubles';
import { MarketIntelligenceSnapshot } from '../intelligence/market-intelligence.types';

/**
 * §27.3 / §27.4 / §27.5 — eligibility policy.
 *
 * The policy is pure with respect to the market: it only *reads* a Phase 4 snapshot and the
 * persisted event state, and every "no" is one of the typed skip reasons. These tests pin the exact
 * rules that stop the channel from becoming a noise machine:
 *   - a threshold that is missing or zeroed must never mean "publish everything",
 *   - a movement needs fresh validated data in *both* directions,
 *   - a cooldown plus a re-arm condition govern repeats,
 *   - an event is only an event once the day already has a baseline.
 */

const now = (iso: string): Date => new Date(iso);

const baseSnapshot = (
  overrides: {
    movementPercent?: number | null;
    availability?: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE';
    high?: number | null;
    low?: number | null;
  } = {},
): MarketIntelligenceSnapshot =>
  makeSnapshot([
    {
      symbol: 'IR_GOLD_18K',
      label: 'طلای ۱۸ عیار',
      currentPrice: 17_500_000,
      previousPrice: 17_100_000,
      open: 17_000_000,
      high: overrides.high === undefined ? 17_600_000 : overrides.high,
      low: overrides.low === undefined ? 16_950_000 : overrides.low,
      availability: overrides.availability ?? 'AVAILABLE',
      freshness: overrides.availability === 'STALE' ? 'STALE' : 'FRESH',
      movementPercent: overrides.movementPercent,
    },
  ]);

const harness = (env: Record<string, string> = {}) => {
  const config = createAppConfigService(env);
  const store = new PublicationStore(config);

  return { config, store, policy: new ChannelPolicyService(config, store) };
};

describe('channel policy — market gate (§27.5)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects publishing when no symbol has valid data', () => {
    const { policy } = harness();
    const empty = makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        availability: 'UNAVAILABLE',
        freshness: null,
        currentPrice: null,
      },
    ]);

    const gate = policy.evaluateMarketGate('DAILY_REPORT', empty);

    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('INVALID_MARKET_SNAPSHOT');
  });

  it('accepts a report over stale data (it says so) but not a movement', () => {
    const { policy } = harness();
    const stale = baseSnapshot({ availability: 'STALE' });

    expect(policy.evaluateMarketGate('DAILY_REPORT', stale).ok).toBe(true);
    expect(policy.evaluateMarketGate('MARKET_MOVEMENT', stale).reason).toBe(
      'STALE_MARKET_DATA',
    );
    expect(policy.evaluateMarketGate('PRICE_UPDATE', stale).ok).toBe(true);
  });

  it('refuses a daily range without a single usable daily statistic', () => {
    const { policy } = harness();
    const noRange = baseSnapshot({ high: null, low: null });

    expect(policy.evaluateMarketGate('DAILY_RANGE', noRange).reason).toBe(
      'INVALID_DAILY_STATISTICS',
    );
  });

  it('keeps the phase-1 publishability decision untouched for the price update', () => {
    const { policy } = harness();
    const gate = policy.evaluateMarketGate('PRICE_UPDATE', baseSnapshot());

    expect(gate.ok).toBe(true);
    expect(gate.reason).toBeNull();
  });
});

describe('channel policy — movement threshold (§27.3)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('selects an upward movement above the configured threshold', () => {
    const { policy } = harness({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' });

    const candidates = policy.selectMovementCandidates(
      baseSnapshot({ movementPercent: 2.34 }),
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].direction).toBe('UP');
    expect(candidates[0].thresholdPercent).toBe(1);
  });

  it('selects a downward movement as well (both directions)', () => {
    const { policy } = harness({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' });
    const down = makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        currentPrice: 17_000_000,
        previousPrice: 17_500_000,
        open: 17_500_000,
        high: 17_500_000,
        low: 17_000_000,
      },
    ]);

    const candidates = policy.selectMovementCandidates(
      down,
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].direction).toBe('DOWN');
  });

  it('ignores a movement below the threshold', () => {
    const { policy } = harness({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' });

    const candidates = policy.selectMovementCandidates(
      baseSnapshot({ movementPercent: 0.4 }),
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(candidates).toHaveLength(0);
  });

  it('never publishes a movement from stale data', () => {
    const { policy } = harness({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' });

    const candidates = policy.selectMovementCandidates(
      baseSnapshot({ movementPercent: 5, availability: 'STALE' }),
      now('2026-09-30T08:00:00.000Z'),
    );

    expect(candidates).toHaveLength(0);
  });

  it('uses a per-symbol override when one is configured', () => {
    const { policy } = harness({
      CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '5',
      CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES: 'IR_GOLD_18K=0.5',
    });

    expect(policy.movementThresholdFor('IR_GOLD_18K')).toBe(0.5);
    expect(policy.movementThresholdFor('UNKNOWN')).toBe(5);
  });

  it('disables movement publication completely when the threshold is zero', () => {
    const { policy } = harness({
      CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '0',
    });

    expect(policy.movementsEnabled).toBe(false);
    expect(policy.movementThresholdFor('IR_GOLD_18K')).toBeNull();
    expect(
      policy.selectMovementCandidates(
        baseSnapshot({ movementPercent: 25 }),
        now('2026-09-30T08:00:00.000Z'),
      ),
    ).toHaveLength(0);
  });

  it('suppresses a repeat inside the cooldown and releases it after the re-arm level', async () => {
    const { policy, store } = harness({
      CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1',
      CHANNEL_MOVEMENT_COOLDOWN_MINUTES: '120',
    });
    const start = now('2026-09-30T08:00:00.000Z');
    const snapshot = baseSnapshot({ movementPercent: 2.34 });

    const first = policy.selectMovementCandidates(snapshot, start);
    expect(first).toHaveLength(1);
    await policy.recordMovementEvent(first[0], start);

    // 30 minutes later: still inside the cooldown → suppressed.
    const insideCooldown = policy.selectMovementCandidates(
      snapshot,
      now('2026-09-30T08:30:00.000Z'),
    );
    expect(insideCooldown).toHaveLength(0);

    // After the cooldown but without a re-arm (the movement never fell back) → still suppressed.
    const afterCooldown = policy.selectMovementCandidates(
      snapshot,
      now('2026-09-30T11:00:00.000Z'),
    );
    expect(afterCooldown).toHaveLength(0);

    // The movement falls back below the re-arm fraction → the next crossing is a new event.
    await policy.updateMovementReArm(
      baseSnapshot({ movementPercent: 1 * MOVEMENT_RE_ARM_FRACTION - 0.1 }),
      now('2026-09-30T11:05:00.000Z'),
    );
    expect(store.getMovementEvent('IR_GOLD_18K', '2026-09-30')?.armed).toBe(
      true,
    );

    const released = policy.selectMovementCandidates(
      snapshot,
      now('2026-09-30T11:10:00.000Z'),
    );
    expect(released).toHaveLength(1);
  });

  it('never invents a movement when the previous price is unknown', () => {
    const { policy } = harness({ CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1' });
    const noPrevious = makeSnapshot([
      {
        symbol: 'IR_GOLD_18K',
        currentPrice: 17_500_000,
        previousPrice: null,
        open: 17_000_000,
      },
    ]);

    expect(
      policy.selectMovementCandidates(
        noPrevious,
        now('2026-09-30T08:00:00.000Z'),
      ),
    ).toHaveLength(0);
  });

  it('describes the effective policy for operations logs', () => {
    const { policy } = harness({
      CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1',
      CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES: 'IR_GOLD_18K=2',
    });

    expect(policy.describeMovementPolicy()).toContain('IR_GOLD_18K=2');
  });
});

describe('channel policy — daily range events (§27.4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const eventHarness = (env: Record<string, string> = {}) =>
    harness({
      CHANNEL_DAILY_RANGE_ENABLED: 'true',
      CHANNEL_DAILY_RANGE_EVENTS_ENABLED: 'true',
      CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES: '0',
      ...env,
    });

  it('publishes no event for the first observation of a day', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');

    await policy.recordRangeBaseline(baseSnapshot(), start);

    expect(policy.selectRangeCandidates(baseSnapshot(), start)).toHaveLength(0);
  });

  it('publishes a new high once the day has a baseline', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    const candidates = policy.selectRangeCandidates(
      baseSnapshot({ high: 17_700_000 }),
      now('2026-09-30T09:00:00.000Z'),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('HIGH');
    expect(candidates[0].value).toBe(17_700_000);
  });

  it('publishes a new low as a low event', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    const candidates = policy.selectRangeCandidates(
      baseSnapshot({ low: 16_500_000 }),
      now('2026-09-30T09:00:00.000Z'),
    );

    expect(candidates.map((candidate) => candidate.kind)).toEqual(['LOW']);
  });

  it('publishes nothing when the extremes are unchanged', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    expect(
      policy.selectRangeCandidates(
        baseSnapshot(),
        now('2026-09-30T09:00:00.000Z'),
      ),
    ).toHaveLength(0);
  });

  it('does not repeat the same extreme after it was published', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    const high = baseSnapshot({ high: 17_700_000 });
    const candidates = policy.selectRangeCandidates(
      high,
      now('2026-09-30T09:00:00.000Z'),
    );
    await policy.recordRangeEvents(candidates, now('2026-09-30T09:00:00.000Z'));

    expect(
      policy.selectRangeCandidates(high, now('2026-09-30T10:00:00.000Z')),
    ).toHaveLength(0);
    // …but a *higher* high is news again.
    expect(
      policy
        .selectRangeCandidates(
          baseSnapshot({ high: 17_900_000 }),
          now('2026-09-30T10:00:00.000Z'),
        )
        .map((candidate) => candidate.value),
    ).toEqual([17_900_000]);
  });

  it('respects the range cooldown', async () => {
    const { policy } = eventHarness({
      CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES: '90',
    });
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    const published = policy.selectRangeCandidates(
      baseSnapshot({ high: 17_700_000 }),
      now('2026-09-30T09:00:00.000Z'),
    );
    await policy.recordRangeEvents(published, now('2026-09-30T09:00:00.000Z'));

    // 30 minutes later, a new extreme arrives but the cooldown has not passed.
    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: 17_800_000 }),
        now('2026-09-30T09:30:00.000Z'),
      ),
    ).toHaveLength(0);
    // After the cooldown it is news again.
    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: 17_900_000 }),
        now('2026-09-30T10:40:00.000Z'),
      ),
    ).toHaveLength(1);
  });

  it('starts a new baseline on the next Tehran day', async () => {
    const { policy } = eventHarness();
    await policy.recordRangeBaseline(
      baseSnapshot(),
      now('2026-09-30T08:00:00.000Z'),
    );

    // The next day: no baseline yet, so the first observation is not an event…
    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: 18_000_000 }),
        now('2026-10-01T08:00:00.000Z'),
      ),
    ).toHaveLength(0);

    // …and once the baseline exists, the new extremes are events again.
    await policy.recordRangeBaseline(
      baseSnapshot({ high: 18_000_000 }),
      now('2026-10-01T08:00:00.000Z'),
    );
    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: 18_100_000 }),
        now('2026-10-01T09:00:00.000Z'),
      ),
    ).toHaveLength(1);
  });

  it('stays disabled when event publication is switched off', () => {
    const { policy } = harness({
      CHANNEL_DAILY_RANGE_ENABLED: 'true',
      CHANNEL_DAILY_RANGE_EVENTS_ENABLED: 'false',
    });

    expect(policy.rangeEventsEnabled).toBe(false);
    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: 18_000_000 }),
        new Date(),
      ),
    ).toHaveLength(0);
  });

  it('does not build an event from a symbol without statistics', async () => {
    const { policy } = eventHarness();
    const start = now('2026-09-30T08:00:00.000Z');
    await policy.recordRangeBaseline(baseSnapshot(), start);

    expect(
      policy.selectRangeCandidates(
        baseSnapshot({ high: null, low: null }),
        now('2026-09-30T09:00:00.000Z'),
      ),
    ).toHaveLength(0);
  });
});

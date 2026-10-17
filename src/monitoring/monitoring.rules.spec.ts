/**
 * Phase 11 — rules (§18.1–§18.6 policy level).
 *
 * The policy is pure, so every threshold, cooldown and staleness rule is exercised directly — no
 * clock, no store, no network.
 */

import {
  evaluateMissedJob,
  evaluateStaleness,
  fingerprintFor,
  isRetryableStatus,
  mayNotify,
  MonitoringPolicy,
  normalizeReason,
  retryDelayMs,
  severityFor,
  thresholdFor,
} from './monitoring.rules';
import { MonitoredJob } from './monitoring.types';

const policy = (
  overrides: Partial<MonitoringPolicy> = {},
): MonitoringPolicy => ({
  enabled: true,
  priceFailureThreshold: 3,
  deliveryFailureThreshold: 3,
  applicationErrorThreshold: 5,
  staleAfterMs: 45 * 60_000,
  cooldownMs: 15 * 60_000,
  repeatAfterMs: 120 * 60_000,
  maxAttempts: 3,
  retryBackoffMs: 30_000,
  batchSize: 10,
  recoveryNotifications: true,
  recoveryStabilityMs: 0,
  ...overrides,
});

const job = (overrides: Partial<MonitoredJob> = {}): MonitoredJob => ({
  name: 'market-price-cycle',
  expectedIntervalMs: 30 * 60_000,
  graceMs: 10 * 60_000,
  status: 'SUCCEEDED',
  lastStartedAt: '2026-10-17T06:00:00.000Z',
  lastCompletedAt: '2026-10-17T06:00:05.000Z',
  lastSuccessAt: '2026-10-17T06:00:05.000Z',
  lastFailureAt: null,
  lastDurationMs: 5000,
  consecutiveFailures: 0,
  lastError: null,
  missedReportedAt: null,
  updatedAt: '2026-10-17T06:00:05.000Z',
  ...overrides,
});

describe('fingerprinting (§6.3)', () => {
  it('is stable for the same condition and ignores message text', () => {
    const first = fingerprintFor({
      category: 'DELIVERY_FAILURE',
      platform: 'bale',
      target: 'channel:-100',
      reasonCode: 'retryable',
    });
    const second = fingerprintFor({
      category: 'DELIVERY_FAILURE',
      platform: 'bale',
      target: 'channel:-100',
      reasonCode: 'RETRYABLE',
    });

    expect(first).toBe(second);
    expect(first).toBe('DELIVERY_FAILURE|bale|channel:-100|RETRYABLE');
  });

  it('keeps different destinations and categories apart', () => {
    const one = fingerprintFor({
      category: 'DELIVERY_FAILURE',
      platform: 'bale',
      target: 'channel:a',
      reasonCode: 'RETRYABLE',
    });
    const two = fingerprintFor({
      category: 'DELIVERY_FAILURE',
      platform: 'bale',
      target: 'channel:b',
      reasonCode: 'RETRYABLE',
    });
    const three = fingerprintFor({
      category: 'PRICE_API',
      platform: 'bale',
      target: 'channel:a',
      reasonCode: 'RETRYABLE',
    });

    expect(one).not.toBe(two);
    expect(one).not.toBe(three);
  });

  it('normalizes arbitrary reason text into a safe token', () => {
    expect(normalizeReason('a weird reason!')).toBe('A_WEIRD_REASON_');
    expect(normalizeReason('   ')).toBe('UNCLASSIFIED');
    expect(normalizeReason('x'.repeat(100))).toBe('UNCLASSIFIED');
  });
});

describe('severity (§4.3)', () => {
  it('escalates a price streak but keeps a single failure medium', () => {
    expect(severityFor('PRICE_API', { consecutiveFailures: 1 })).toBe('MEDIUM');
    expect(severityFor('PRICE_API', { consecutiveFailures: 3 })).toBe('HIGH');
  });

  it('treats persistence as critical and stale data as high', () => {
    expect(severityFor('PERSISTENCE_FAILURE', { consecutiveFailures: 1 })).toBe(
      'CRITICAL',
    );
    expect(severityFor('MARKET_DATA_STALE', { consecutiveFailures: 1 })).toBe(
      'HIGH',
    );
  });

  it('distinguishes a single channel failure from a widespread one', () => {
    expect(
      severityFor('CHANNEL_PUBLISHING', {
        consecutiveFailures: 1,
        gateFailures: 1,
      }),
    ).toBe('MEDIUM');
    expect(
      severityFor('CHANNEL_PUBLISHING', {
        consecutiveFailures: 2,
        gateFailures: 2,
      }),
    ).toBe('HIGH');
  });

  it('never uses one constant for every category', () => {
    const values = new Set(
      [
        severityFor('PRICE_API', { consecutiveFailures: 1 }),
        severityFor('PERSISTENCE_FAILURE', { consecutiveFailures: 1 }),
        severityFor('SCHEDULED_JOB_FAILURE', { consecutiveFailures: 1 }),
      ].filter(Boolean),
    );

    expect(values.size).toBeGreaterThan(1);
  });
});

describe('thresholds (§5.2)', () => {
  it('uses the configured threshold for price and delivery failures', () => {
    expect(thresholdFor('PRICE_API', policy())).toBe(3);
    expect(
      thresholdFor('PRICE_API', policy({ priceFailureThreshold: 7 })),
    ).toBe(7);
    expect(
      thresholdFor('DELIVERY_FAILURE', policy({ deliveryFailureThreshold: 2 })),
    ).toBe(2);
  });

  it('opens immediately for conditions that are incidents on first evidence', () => {
    expect(thresholdFor('MARKET_DATA_STALE', policy())).toBe(1);
    expect(thresholdFor('PERSISTENCE_FAILURE', policy())).toBe(1);
    expect(thresholdFor('SCHEDULED_JOB_FAILURE', policy())).toBe(1);
  });
});

describe('notification gating (§12.4)', () => {
  const base = {
    kind: 'INCIDENT' as const,
    severity: 'HIGH' as const,
    now: new Date('2026-10-17T10:00:00.000Z'),
    lastNotifiedAt: null,
    incidentOpenedAt: '2026-10-17T09:00:00.000Z',
    occurrences: 1,
    policy: policy(),
  };

  it('is silent when monitoring is disabled', () => {
    expect(mayNotify({ ...base, policy: policy({ enabled: false }) })).toEqual({
      allowed: false,
      reason: 'MONITORING_DISABLED',
      bucket: 0,
    });
  });

  it('respects the cooldown', () => {
    const decision = mayNotify({
      ...base,
      lastNotifiedAt: '2026-10-17T09:55:00.000Z',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('COOLDOWN');
  });

  it('allows exactly one reminder per repeat window, in a stable bucket', () => {
    const justAfterCooldown = mayNotify({
      ...base,
      lastNotifiedAt: '2026-10-17T09:30:00.000Z',
    });

    expect(justAfterCooldown.allowed).toBe(false);
    expect(justAfterCooldown.reason).toBe('ALREADY_NOTIFIED');

    const later = mayNotify({
      ...base,
      lastNotifiedAt: '2026-10-17T07:00:00.000Z',
    });

    expect(later.allowed).toBe(true);
    expect(later.bucket).toBe(0);

    const muchLater = mayNotify({
      ...base,
      now: new Date('2026-10-17T11:30:00.000Z'),
      lastNotifiedAt: '2026-10-17T07:00:00.000Z',
    });

    expect(muchLater.bucket).toBe(1);
  });

  it('honours the recovery-notification switch', () => {
    expect(
      mayNotify({
        ...base,
        kind: 'RECOVERY',
        policy: policy({ recoveryNotifications: false }),
      }).allowed,
    ).toBe(false);
  });
});

describe('retry policy (§12.3)', () => {
  it('backs off exponentially and caps the exponent', () => {
    expect(retryDelayMs(1, policy())).toBe(30_000);
    expect(retryDelayMs(2, policy())).toBe(60_000);
    expect(retryDelayMs(3, policy())).toBe(120_000);
    // Exponent is capped at 6, so the delay never grows without bound (30s × 2^6 = 32 min).
    expect(retryDelayMs(20, policy())).toBe(1_920_000);
    // A large base still cannot exceed one hour.
    expect(retryDelayMs(9, policy({ retryBackoffMs: 600_000 }))).toBe(
      60 * 60_000,
    );
  });

  it('never retries an unknown outcome', () => {
    expect(isRetryableStatus('PENDING')).toBe(true);
    expect(isRetryableStatus('RETRY_PENDING')).toBe(true);
    expect(isRetryableStatus('FAILED')).toBe(true);
    expect(isRetryableStatus('UNKNOWN')).toBe(false);
    expect(isRetryableStatus('SENT')).toBe(false);
  });
});

describe('staleness (§5.4)', () => {
  const now = new Date('2026-10-17T10:00:00.000Z');

  it('is stale only beyond the threshold', () => {
    expect(
      evaluateStaleness({
        now,
        lastValidUpdateAt: '2026-10-17T09:50:00.000Z',
        staleAfterMs: 45 * 60_000,
        scheduledWindowOnly: false,
        inActiveWindow: true,
      }).stale,
    ).toBe(false);

    const stale = evaluateStaleness({
      now,
      lastValidUpdateAt: '2026-10-17T08:00:00.000Z',
      staleAfterMs: 45 * 60_000,
      scheduledWindowOnly: false,
      inActiveWindow: true,
    });

    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe('STALE_BEYOND_THRESHOLD');
  });

  it('reports “no data yet” as unknown rather than stale or healthy', () => {
    const evaluation = evaluateStaleness({
      now,
      lastValidUpdateAt: null,
      staleAfterMs: 45 * 60_000,
      scheduledWindowOnly: true,
      inActiveWindow: true,
    });

    expect(evaluation.stale).toBe(false);
    expect(evaluation.ageMs).toBeNull();
    expect(evaluation.reason).toBe('NO_VALID_UPDATE_YET');
  });

  it('never alarms outside the configured active window', () => {
    const evaluation = evaluateStaleness({
      now,
      lastValidUpdateAt: '2026-10-16T20:00:00.000Z',
      staleAfterMs: 45 * 60_000,
      scheduledWindowOnly: true,
      inActiveWindow: false,
    });

    expect(evaluation.stale).toBe(false);
    expect(evaluation.reason).toBe('OUTSIDE_ACTIVE_WINDOW');
  });
});

describe('missed jobs (§9.2)', () => {
  const startedAt = new Date('2026-10-17T05:00:00.000Z');

  it('does not complain before one interval plus grace', () => {
    const evaluation = evaluateMissedJob({
      job: job(),
      now: new Date('2026-10-17T06:30:00.000Z'),
      processStartedAt: startedAt,
      inActiveWindow: true,
    });

    expect(evaluation.missed).toBe(false);
    expect(evaluation.dueAt).toBe('2026-10-17T06:40:00.000Z');
  });

  it('detects a missed run after the grace period', () => {
    const evaluation = evaluateMissedJob({
      job: job(),
      now: new Date('2026-10-17T07:00:00.000Z'),
      processStartedAt: startedAt,
      inActiveWindow: true,
    });

    expect(evaluation.missed).toBe(true);
    expect(evaluation.reason).toBe('MISSED_EXPECTED_RUN');
  });

  it('never reports a missed run outside the active window', () => {
    expect(
      evaluateMissedJob({
        job: job(),
        now: new Date('2026-10-17T23:00:00.000Z'),
        processStartedAt: startedAt,
        inActiveWindow: false,
      }).missed,
    ).toBe(false);
  });

  it('reports one incident per interval, not one per sweep', () => {
    const reported = job({ missedReportedAt: '2026-10-17T07:00:00.000Z' });
    const evaluation = evaluateMissedJob({
      job: reported,
      now: new Date('2026-10-17T07:05:00.000Z'),
      processStartedAt: startedAt,
      inActiveWindow: true,
    });

    expect(evaluation.missed).toBe(false);
    expect(evaluation.reason).toBe('ALREADY_REPORTED');
  });

  it('does not treat a fresh process as a missed job', () => {
    const fresh = job({
      lastStartedAt: null,
      updatedAt: '2026-10-17T09:55:00.000Z',
      missedReportedAt: null,
    });

    expect(
      evaluateMissedJob({
        job: fresh,
        now: new Date('2026-10-17T10:00:00.000Z'),
        processStartedAt: new Date('2026-10-17T09:55:00.000Z'),
        inActiveWindow: true,
      }).missed,
    ).toBe(false);
  });
});

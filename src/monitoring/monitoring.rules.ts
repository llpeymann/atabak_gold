/**
 * Phase 11 — monitoring rules (§3.2, §11).
 *
 * Everything that decides “is this an incident, how bad is it, may we tell somebody about it” lives
 * here as pure functions. The engine has no thresholds of its own, which is what makes the policy
 * reviewable and testable without a running application.
 */

import { IncidentSeverity } from './monitoring.platform';
import {
  MonitoringCategory,
  MonitoredJob,
  NotificationKind,
  NotificationStatus,
} from './monitoring.types';

/** Thresholds the rules need. Supplied from validated configuration — never hardcoded here. */
export interface MonitoringPolicy {
  enabled: boolean;
  /** Consecutive failures before a `PRICE_API` watch opens an incident. */
  priceFailureThreshold: number;
  /** Consecutive failures of one destination before a delivery incident opens. */
  deliveryFailureThreshold: number;
  /** Consecutive application errors of the same signature before an incident opens. */
  applicationErrorThreshold: number;
  /** Market data older than this is stale (`null` = derive from the Phase 1 freshness rule). */
  staleAfterMs: number;
  /** Silence between two notifications about the same incident. */
  cooldownMs: number;
  /** After this long, an unresolved incident may be repeated once (bounded, not a stream). */
  repeatAfterMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  /** Maximum notifications processed per sweep (bounded work per tick). */
  batchSize: number;
  recoveryNotifications: boolean;
  /** How long a recovery must hold before the incident is resolved (0 = single success). */
  recoveryStabilityMs: number;
}

/** Severity is a function of category *and* evidence — never one constant per category (§4.3). */
export function severityFor(
  category: MonitoringCategory,
  evidence: { consecutiveFailures: number; gateFailures?: number },
): IncidentSeverity {
  const streak = Math.max(1, evidence.consecutiveFailures);

  switch (category) {
    case 'PERSISTENCE_FAILURE':
      // Losing a write is a data-integrity event, not an availability blip.
      return 'CRITICAL';
    case 'MARKET_DATA_STALE':
      return 'HIGH';
    case 'HEALTH_FAILURE':
      return 'HIGH';
    case 'PRICE_API':
      // A single timeout is noise; an unbroken streak means the market feed is down.
      return streak >= 3 ? 'HIGH' : 'MEDIUM';
    case 'MARKET_DATA_INVALID':
      // One rejected payload is normal operation; repeated invalidity is a feed problem.
      return streak >= 3 ? 'HIGH' : 'MEDIUM';
    case 'SCHEDULED_JOB_FAILURE':
      return streak >= 2 ? 'HIGH' : 'MEDIUM';
    case 'DELIVERY_FAILURE':
      // A single destination failing repeatedly is an outage of that destination.
      return streak >= 3 ? 'HIGH' : 'MEDIUM';
    case 'CHANNEL_PUBLISHING':
      // Widespread (every destination failed) is worse than one channel being unreachable.
      return (evidence.gateFailures ?? streak) >= 2 ? 'HIGH' : 'MEDIUM';
    case 'APPLICATION_ERROR':
      return streak >= 5 ? 'HIGH' : 'MEDIUM';
    case 'MONITORING_NOTIFICATION_FAILURE':
      // The monitor admitting it cannot reach a human is serious, but not a business outage.
      return 'MEDIUM';
    default:
      return 'MEDIUM';
  }
}

/**
 * Stable grouping key (§6.3).
 *
 * Built only from closed vocabulary — category, platform, destination reference and a machine
 * reason code. Message text, stack traces and counters never take part, so the same ongoing problem
 * keeps one identity while two unrelated failures cannot merge.
 */
export function fingerprintFor(input: {
  category: MonitoringCategory;
  platform?: string | null;
  target?: string | null;
  reasonCode: string;
}): string {
  const platform = input.platform ?? '-';
  const target = input.target ?? '-';
  const reason = normalizeReason(input.reasonCode);

  return `${input.category}|${platform}|${target}|${reason}`;
}

/** Reason codes are uppercase tokens; anything else is folded into `UNCLASSIFIED`. */
export function normalizeReason(value: string): string {
  const token = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '_');

  if (token === '' || token.length > 40) {
    return 'UNCLASSIFIED';
  }

  return token;
}

/** Whether the failure streak is enough to open an incident for this category. */
export function thresholdFor(
  category: MonitoringCategory,
  policy: MonitoringPolicy,
): number {
  switch (category) {
    case 'PRICE_API':
      return Math.max(1, policy.priceFailureThreshold);
    case 'DELIVERY_FAILURE':
      return Math.max(1, policy.deliveryFailureThreshold);
    case 'APPLICATION_ERROR':
      return Math.max(1, policy.applicationErrorThreshold);
    case 'MARKET_DATA_INVALID':
      return Math.max(1, policy.applicationErrorThreshold);
    default:
      // Categories that are incidents on first evidence (stale data, persistence, job failure,
      // health, channel publishing, self-notification failure) never need a streak.
      return 1;
  }
}

/**
 * May a notification be produced right now?
 *
 * Three separate gates, each with its own reason so the admin surface can explain a silence:
 * the global switch, the per-incident cooldown, and the “already told you, still broken” bucket that
 * allows exactly one reminder per `repeatAfterMs` instead of one per polling cycle (§12.4).
 */
export function mayNotify(input: {
  kind: NotificationKind;
  severity: IncidentSeverity;
  now: Date;
  lastNotifiedAt: string | null;
  incidentOpenedAt: string | null;
  occurrences: number;
  policy: MonitoringPolicy;
}): { allowed: boolean; reason: string | null; bucket: number } {
  if (!input.policy.enabled) {
    return { allowed: false, reason: 'MONITORING_DISABLED', bucket: 0 };
  }

  if (input.kind === 'RECOVERY') {
    if (!input.policy.recoveryNotifications) {
      return {
        allowed: false,
        reason: 'RECOVERY_NOTIFICATIONS_DISABLED',
        bucket: 0,
      };
    }

    return { allowed: true, reason: null, bucket: 0 };
  }

  const openedAt = input.incidentOpenedAt
    ? Date.parse(input.incidentOpenedAt)
    : NaN;
  const lastNotified = input.lastNotifiedAt
    ? Date.parse(input.lastNotifiedAt)
    : NaN;

  if (!Number.isNaN(lastNotified)) {
    if (input.now.getTime() - lastNotified < input.policy.cooldownMs) {
      return { allowed: false, reason: 'COOLDOWN', bucket: 0 };
    }

    if (input.now.getTime() - lastNotified < input.policy.repeatAfterMs) {
      return { allowed: false, reason: 'ALREADY_NOTIFIED', bucket: 0 };
    }
  }

  // Bucketed so that a retry of the same sweep cannot create a second row with a different key.
  const reference = Number.isNaN(openedAt) ? input.now.getTime() : openedAt;
  const bucket = Math.floor(
    Math.max(0, input.now.getTime() - reference) /
      Math.max(1, input.policy.repeatAfterMs),
  );

  return { allowed: true, reason: null, bucket };
}

/** Retry delay: exponential with a cap, deterministic per attempt (no hidden jitter in tests). */
export function retryDelayMs(
  attempt: number,
  policy: MonitoringPolicy,
): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 6);

  return Math.min(policy.retryBackoffMs * 2 ** exponent, 60 * 60_000);
}

/** Which statuses may be retried. `UNKNOWN` never can — the message may already exist (§12.3). */
export function isRetryableStatus(status: NotificationStatus): boolean {
  return (
    status === 'PENDING' || status === 'RETRY_PENDING' || status === 'FAILED'
  );
}

/**
 * Stale-data evaluation.
 *
 * The age is measured from the last *valid* market update (Phase 1 state), never from the last
 * request attempt. `scheduledWindowOnly` lets a deployment declare inactive hours: outside them the
 * absence of fresh data is expected and must not raise an incident (§5.4).
 */
export function evaluateStaleness(input: {
  now: Date;
  lastValidUpdateAt: string | null;
  staleAfterMs: number;
  scheduledWindowOnly: boolean;
  inActiveWindow: boolean;
}): { stale: boolean; ageMs: number | null; reason: string | null } {
  if (input.lastValidUpdateAt === null) {
    return {
      stale: false,
      ageMs: null,
      reason: 'NO_VALID_UPDATE_YET',
    };
  }

  const last = Date.parse(input.lastValidUpdateAt);

  if (Number.isNaN(last)) {
    return { stale: false, ageMs: null, reason: 'INVALID_TIMESTAMP' };
  }

  const ageMs = Math.max(0, input.now.getTime() - last);

  if (input.scheduledWindowOnly && !input.inActiveWindow) {
    return { stale: false, ageMs, reason: 'OUTSIDE_ACTIVE_WINDOW' };
  }

  return {
    stale: ageMs > input.staleAfterMs,
    ageMs,
    reason: ageMs > input.staleAfterMs ? 'STALE_BEYOND_THRESHOLD' : null,
  };
}

/**
 * Missed-run evaluation (§9.2).
 *
 * A job is *missed* only when the expected interval plus its grace has elapsed **and** the
 * deployment considers the current time an active window. A job that never ran yet is not “missed”
 * before one full interval has passed since the process started — otherwise every restart would
 * raise an alarm.
 */
export function evaluateMissedJob(input: {
  job: MonitoredJob;
  now: Date;
  processStartedAt: Date;
  inActiveWindow: boolean;
}): { missed: boolean; reason: string | null; dueAt: string | null } {
  const { job } = input;

  if (job.expectedIntervalMs === null) {
    return { missed: false, reason: 'NO_CADENCE', dueAt: null };
  }

  if (!input.inActiveWindow) {
    return { missed: false, reason: 'OUTSIDE_ACTIVE_WINDOW', dueAt: null };
  }

  const reference = job.lastStartedAt
    ? Date.parse(job.lastStartedAt)
    : Math.max(Date.parse(job.updatedAt), input.processStartedAt.getTime());

  if (Number.isNaN(reference)) {
    return { missed: false, reason: 'NO_REFERENCE', dueAt: null };
  }

  const dueAtMs = reference + job.expectedIntervalMs + job.graceMs;

  if (input.now.getTime() <= dueAtMs) {
    return {
      missed: false,
      reason: null,
      dueAt: new Date(dueAtMs).toISOString(),
    };
  }

  // One missed-run incident per elapsed interval, not one per sweep (§12.4).
  if (job.missedReportedAt !== null) {
    const reportedAt = Date.parse(job.missedReportedAt);

    if (
      !Number.isNaN(reportedAt) &&
      reportedAt >= reference &&
      input.now.getTime() - reportedAt < job.expectedIntervalMs + job.graceMs
    ) {
      return {
        missed: false,
        reason: 'ALREADY_REPORTED',
        dueAt: new Date(dueAtMs).toISOString(),
      };
    }
  }

  return {
    missed: true,
    reason: 'MISSED_EXPECTED_RUN',
    dueAt: new Date(dueAtMs).toISOString(),
  };
}

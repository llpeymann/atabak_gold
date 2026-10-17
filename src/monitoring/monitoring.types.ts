/**
 * Phase 11 — monitoring domain (§4).
 *
 * The types here describe *operational evidence*: what was observed, how many times, from which
 * component, and — separately — whether the administrator was actually notified about it.
 *
 * Two rules shape the model:
 *
 *  1. **Incident state and notification state are different facts.** An incident can be `OPEN`
 *     while its notification is `FAILED`, and a successfully sent message never means “solved”.
 *  2. **Unknown is a value.** A notification whose request left the process without an answer is
 *     `UNKNOWN`, not “sent” and not “failed” — retrying it could duplicate a message.
 *
 * Persisted incidents themselves stay in the Phase 10 document (`AdminStore`), which owns the one
 * incident table of the project. This document adds what Phase 10 does not model: per-component
 * watch state (consecutive failures, cooldowns), scheduled-job execution history, and the
 * notification outbox (§3.6).
 */

import { IncidentSeverity, Platform } from './monitoring.platform';

/** Monitoring categories the application can actually observe (§4.2). */
export const MONITORING_CATEGORIES = [
  'PRICE_API',
  'MARKET_DATA_STALE',
  'MARKET_DATA_INVALID',
  'DELIVERY_FAILURE',
  'CHANNEL_PUBLISHING',
  'APPLICATION_ERROR',
  'PERSISTENCE_FAILURE',
  'SCHEDULED_JOB_FAILURE',
  'HEALTH_FAILURE',
  'MONITORING_NOTIFICATION_FAILURE',
] as const;

export type MonitoringCategory = (typeof MONITORING_CATEGORIES)[number];

/** Lifecycle of one *watch* — the running condition behind an incident (§4.4). */
export type WatchPhase = 'HEALTHY' | 'DEGRADED' | 'OPEN' | 'RECOVERED';

/** What a single observation did to the watch. */
export type ObservationOutcome =
  /** Counted, below the threshold: no incident, no notification. */
  | 'BELOW_THRESHOLD'
  /** Threshold crossed: an incident was opened (or an existing one got a new occurrence). */
  | 'INCIDENT_OPEN'
  /** Repeat while the incident is open: occurrence counted, notification subject to cooldown. */
  | 'INCIDENT_REPEAT'
  /** A previously open incident saw evidence of recovery and was resolved. */
  | 'RECOVERED'
  /** Nothing to do (monitoring disabled, or a duplicate observation inside the same tick). */
  | 'IGNORED';

/** Per-component running state (§3.2). Keyed by a *stable* fingerprint, never by free text. */
export interface MonitorWatch {
  /** `${category}|${platform ?? '-'}|${target ?? '-'}|${reasonCode}` — stable grouping key. */
  key: string;
  category: MonitoringCategory;
  platform: Platform | null;
  /** Safe identifier of the affected destination/component (never a secret). */
  target: string | null;
  reasonCode: string;
  severity: IncidentSeverity;
  phase: WatchPhase;
  /** Consecutive failures since the last verified success (reset only by real success evidence). */
  consecutiveFailures: number;
  /** Total failures observed in this watch (not reset by recovery; the incident keeps its count). */
  totalFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Incident currently linked to this watch (null before the threshold is crossed). */
  incidentId: string | null;
  /**
   * Opens a new incident on recurrence instead of re-using a resolved one, and keeps the history of
   * both. Incremented every time a resolved condition comes back (§4.4).
   */
  incidentGeneration: number;
  openedAt: string | null;
  resolvedAt: string | null;
  /**
   * First success observed while the incident is open, when the policy requires a stability window
   * before declaring recovery. `null` means “no candidate yet” (§13).
   */
  recoveryCandidateAt: string | null;
  lastNotifiedAt: string | null;
  lastNotificationStatus: NotificationStatus | null;
  updatedAt: string;
}

export type JobStatus =
  | 'NEVER_RUN'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  /** No start was observed inside the expected interval + grace (§9.2). */
  | 'MISSED';

/** Execution record of one recurring job (§9.1). Upserted, never appended per run. */
export interface MonitoredJob {
  name: string;
  /** Expected cadence; `null` disables missed-run detection for this job. */
  expectedIntervalMs: number | null;
  /** Extra time allowed beyond the interval before the absence counts as missed. */
  graceMs: number;
  status: JobStatus;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** Last time a missed-run incident was raised (dedupe: one per interval, not one per sweep). */
  missedReportedAt: string | null;
  updatedAt: string;
}

/** Delivery state of one monitoring notification (§12.3). */
export type NotificationStatus =
  | 'PENDING'
  | 'SENT'
  | 'FAILED'
  /** The request left the process but no answer came back — never auto-retried (§12.3). */
  | 'UNKNOWN'
  | 'RETRY_PENDING';

export type NotificationKind = 'INCIDENT' | 'RECOVERY';

/** Durable outbox row (§3.6). Persisted *before* the send is attempted. */
export interface MonitorNotification {
  notificationId: string;
  /**
   * Unique key: `${kind}|${incidentId}|${generation}|${bucket}`. It is what makes a repeated
   * enqueue (double sweep, restart, retry) harmless.
   */
  dedupeKey: string;
  kind: NotificationKind;
  incidentId: string | null;
  category: MonitoringCategory;
  severity: IncidentSeverity;
  /** Rendered, already-sanitized message body. */
  text: string;
  status: NotificationStatus;
  attemptCount: number;
  platform: Platform;
  chatId: string;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
}

export interface MonitoringDocument {
  version: number;
  savedAt: string;
  watches: MonitorWatch[];
  jobs: MonitoredJob[];
  notifications: MonitorNotification[];
  sequences: Record<string, number>;
}

export interface DeliveryObservation {
  platform: Platform;
  /** Destination kind: `channel` for publications, `user` for direct messages. */
  destination: 'channel' | 'user';
  /** Safe reference of the destination (channel id / masked user id). */
  target: string;
  operation:
    | 'channel-publication'
    | 'alert-notification'
    | 'sales-notification'
    | 'admin-message';
  ok: boolean;
  /** Sanitized error summary; ignored when `ok` is true. */
  error?: string | null;
  /** Platform classification of a failed call (`RETRYABLE`/`PERMANENT`/`AMBIGUOUS`). */
  failureKind?: string | null;
  at?: Date;
}

export interface JobStartInput {
  name: string;
  expectedIntervalMs?: number | null;
  graceMs?: number;
  at?: Date;
}

export interface JobEndInput {
  name: string;
  ok: boolean;
  error?: string | null;
  at?: Date;
}

/** Signals the monitor exposes for the admin surface and the health endpoint. */
export interface MonitoringSnapshot {
  enabled: boolean;
  /** `true` when the notification destination is configured and could be resolved. */
  notificationDestination: { configured: boolean; reason: string | null };
  openIncidents: number;
  criticalIncidents: number;
  /** Watches with at least one consecutive failure (degraded but below threshold included). */
  degradedWatches: number;
  stale: {
    state: 'FRESH' | 'STALE' | 'UNKNOWN';
    ageMinutes: number | null;
    reason: string | null;
  };
  jobs: MonitoredJob[];
  notifications: {
    pending: number;
    retryPending: number;
    failed: number;
    unknown: number;
    lastSentAt: string | null;
  };
  lastPriceSuccessAt: string | null;
  lastDeliverySuccessAt: string | null;
}

export interface ReadinessCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: ReadinessCheck[];
  timestamp: string;
  uptimeSeconds: number;
}

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

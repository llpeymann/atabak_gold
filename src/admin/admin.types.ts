/**
 * Phase 10 — Admin System: domain model.
 *
 * The admin system is a *consumer* of the existing phases, never a second implementation of them:
 * every number on a dashboard screen is read from the authoritative store of the phase that owns it
 * (Phase 1 market state, Phase 2 identities, Phase 3 alerts, Phase 5 publications, Phase 7 referrals,
 * Phase 8 campaigns, Phase 9 leads), and every action is executed through that phase's own service.
 *
 * Three concepts are deliberately kept apart, because confusing them is what turns an operations
 * tool into a source of false claims:
 *
 *  1. **Observed** — something was recorded (an error, a failed delivery, a click).
 *  2. **Verified** — the platform (or the owning phase) confirmed it (a confirmed send, a verified
 *     channel join, a persisted lead).
 *  3. **Administered** — an authorized administrator did something about it; that act is audited.
 *
 * `UNKNOWN` is a first-class outcome everywhere: a request whose answer never arrived is never
 * reported as success and never reported as failure.
 */

import { Platform } from '../platform/platform.types';

// --- roles and capabilities -----------------------------------------------------

/**
 * Two roles only (`ADMIN_OWNER_IDS` / `ADMIN_USER_IDS`). §12.2 explicitly asks not to build an
 * enterprise permission system for a project with one owner — but every privileged operation still
 * re-checks a *capability* on the server side, so a role change is one config edit, not a code path.
 */
export type AdminRole = 'OWNER' | 'ADMIN';

export type AdminCapability =
  | 'manage'
  | 'stats'
  | 'users'
  | 'channels'
  | 'alerts'
  | 'leads'
  | 'campaigns'
  | 'errors'
  | 'broadcast'
  /** Confirming/starting a broadcast is separated: it is the single highest-impact action (§12.3). */
  | 'broadcast.send'
  | 'audit';

export const ADMIN_CAPABILITIES: Readonly<
  Record<AdminRole, readonly AdminCapability[]>
> = {
  OWNER: [
    'manage',
    'stats',
    'users',
    'channels',
    'alerts',
    'leads',
    'campaigns',
    'errors',
    'broadcast',
    'broadcast.send',
    'audit',
  ],
  ADMIN: [
    'manage',
    'stats',
    'users',
    'channels',
    'alerts',
    'leads',
    'campaigns',
    'errors',
    'broadcast',
  ],
};

export type AdminActionKind =
  | 'ADMIN_OPEN'
  | 'ADMIN_VIEW'
  | 'CHANNEL_PUBLISHING_TOGGLED'
  | 'CHANNEL_TEST_MESSAGE'
  | 'ALERT_DISABLED'
  | 'ALERT_ENABLED'
  | 'LEAD_STATUS_CHANGED'
  | 'LEAD_CONVERTED'
  | 'LEAD_SALE_RECORDED'
  | 'CAMPAIGN_STATUS_CHANGED'
  | 'INCIDENT_REVIEWED'
  | 'INCIDENT_RESOLVED'
  | 'INCIDENT_RETRIED'
  | 'BROADCAST_PREPARED'
  | 'BROADCAST_CONFIRMED'
  | 'BROADCAST_STARTED'
  | 'BROADCAST_CANCELLED'
  | 'BROADCAST_RETRIED'
  | 'BROADCAST_COMPLETED'
  | 'ADMIN_DENIED';

export type AuditResult = 'OK' | 'DENIED' | 'FAILED';

/** One durable audit row (§13). Only safe, non-personal fields are stored. */
export interface AuditRecord {
  auditId: string;
  /** Acting administrator (`<platform>:<platformUserId>`) or `system:<component>`. */
  actor: string;
  role: AdminRole | 'SYSTEM';
  action: AdminActionKind;
  targetType: string;
  targetRef: string | null;
  at: string;
  result: AuditResult;
  fromState: string | null;
  toState: string | null;
  /** Short, sanitized explanation (never a token, never customer free text). */
  reason: string | null;
  /** Groups the rows of one operation (e.g. one broadcast lifecycle). */
  correlationId: string | null;
}

// --- operational incidents (error center) ---------------------------------------

/**
 * Where an incident came from. The list is the set of *real* producing modules — a category is only
 * added when a module actually records it (§10.1), and the dashboard never invents one.
 */
export type IncidentSource =
  | 'market'
  | 'price-api'
  | 'platform-bale'
  | 'platform-telegram'
  | 'channel-publisher'
  | 'alert-engine'
  | 'alert-notification'
  | 'sales-notification'
  | 'campaign-tracking'
  | 'persistence'
  | 'scheduler'
  | 'bot-router'
  | 'admin'
  | 'broadcast';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IncidentStatus = 'OPEN' | 'REVIEWED' | 'RESOLVED';

/**
 * One aggregated incident (§10.2).
 *
 * Occurrences of the same fingerprint inside the aggregation window are counted on one row
 * (`occurrences`, `firstSeenAt`, `lastSeenAt`) instead of being silently collapsed: the count and the
 * window are part of the record, so "12 failures since 09:20" is a fact and not a guess.
 */
export interface IncidentRecord {
  incidentId: string;
  /** `${source}|${category}|${summary}` — stable identity of the *kind* of problem. */
  fingerprint: string;
  source: IncidentSource;
  category: string;
  severity: IncidentSeverity;
  summary: string;
  reference: string | null;
  correlationId: string | null;
  retryable: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  status: IncidentStatus;
  /** Who marked it reviewed / resolved, and when. */
  reviewedBy: string | null;
  reviewedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** Latest retry outcome, when an administrator actually retried the operation. */
  lastRetryAt: string | null;
  lastRetryResult: string | null;
}

export type IncidentAction = 'review' | 'resolve' | 'reopen';

// --- activity (durable, for “Active Users”) -------------------------------------

/**
 * One identity's active days (§14, “Active Users”).
 *
 * `lastInteractionAt` alone cannot answer “was this person active *in July*”, so the admin system
 * keeps a bounded, durable day-set per identity. It is written **only** from the central inbound
 * user-action path — never from a publisher, a scheduler or a delivery routine — which is what makes
 * the metric mean “a real person used the bot”.
 */
export interface ActivityRow {
  identityKey: string;
  platform: Platform;
  userId: string;
  /** Tehran day keys (`YYYY-MM-DD`) of qualifying user-initiated activity, bounded and pruned. */
  days: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

// --- broadcast ------------------------------------------------------------------

export type BroadcastAudienceKind =
  'ALL' | 'PLATFORM' | 'ACTIVE_LAST_DAYS' | 'INACTIVE_LAST_DAYS';

export interface BroadcastAudience {
  kind: BroadcastAudienceKind;
  /** `PLATFORM` only. */
  platform: Platform | null;
  /** `ACTIVE_LAST_DAYS` / `INACTIVE_LAST_DAYS`: the rolling window in days. */
  days: number | null;
}

export type BroadcastStatus =
  /** Prepared and persisted, explicitly **not** sending yet (waiting for the final confirmation). */
  | 'PREPARED'
  /** Confirmed: recipients are being processed at a safe rate. */
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELLED'
  /** Nothing could be sent (no eligible recipient, or the platform is unconfigured). */
  | 'FAILED';

export type BroadcastRecipientStatus =
  | 'PENDING'
  | 'SENT'
  | 'FAILED'
  /** The platform never answered: the message *may* have arrived. Never auto-retried (§11.4). */
  | 'UNKNOWN'
  /** Dropped without a send (cancelled broadcast, or ineligible at snapshot time). */
  | 'SKIPPED';

export interface BroadcastJob {
  broadcastId: string;
  /** Human-quotable reference (`BC-XXXXXXXX`), unique in the document. */
  reference: string;
  createdBy: string;
  createdAt: string;
  /** Exact text that will be sent — previewed to the administrator before the confirmation. */
  text: string;
  audience: BroadcastAudience;
  /** Persisted description of the audience, so the report explains itself without re-deriving it. */
  audienceLabel: string;
  status: BroadcastStatus;
  /** Set the moment the confirmation was accepted (the durable “start” of the operation). */
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** Not before this instant: set by rate-limit backoff after a 429. */
  nextAttemptAfter: string | null;
  completedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  totalRecipients: number;
  /** Bounded retry counter of the whole job (manual retries included). */
  retryCount: number;
  lastError: string | null;
}

export interface BroadcastRecipient {
  recipientId: string;
  broadcastId: string;
  userId: string;
  identityKey: string;
  platform: Platform;
  chatId: string;
  status: BroadcastRecipientStatus;
  attemptCount: number;
  sentAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  externalMessageId: string | null;
  /** Not before this instant (bounded backoff per recipient). */
  nextAttemptAt: string | null;
}

export interface BroadcastReport {
  job: BroadcastJob;
  totals: Record<BroadcastRecipientStatus, number>;
  attempts: number;
  /** Explicitly distinguishes accepted / confirmed / unknown (§11.5). */
  notes: string[];
}

/** Audience snapshot returned by the eligibility calculation (same rules as the send path). */
export interface BroadcastAudiencePreview {
  audience: BroadcastAudience;
  label: string;
  recipients: {
    userId: string;
    identityKey: string;
    platform: Platform;
    chatId: string;
  }[];
  /** Recipients dropped by the eligibility rules, by reason (never silently ignored). */
  excluded: { reason: string; count: number }[];
  /** Set when the audience is larger than `BROADCAST_MAX_RECIPIENTS`. */
  limitExceeded: boolean;
  limit: number;
}

// --- stored document ------------------------------------------------------------

export interface AdminDocument {
  version: number;
  savedAt: string;
  activity: ActivityRow[];
  audit: AuditRecord[];
  incidents: IncidentRecord[];
  broadcasts: BroadcastJob[];
  recipients: BroadcastRecipient[];
  sequences: Record<string, number>;
  /** Counters of records removed by the *documented* retention policy (§10.2, §15.2). */
  pruned: { incidents: number; incidentOccurrences: number };
}

// --- reports --------------------------------------------------------------------

export type ReportPeriodPreset = 'today' | '7d' | '30d' | 'all' | 'custom';

export interface ReportWindow {
  preset: ReportPeriodPreset;
  /** Inclusive start (ISO, UTC instant of the Tehran day boundary). */
  from: string;
  /** Exclusive end (ISO). */
  to: string;
  labelFa: string;
  /** Tehran day keys of the first and last day inside the window (for documentation/rendering). */
  fromDayKey: string;
  toDayKey: string;
}

/** How a number was counted — the same vocabulary Phase 8 uses, so screens cannot drift (§14). */
export type MetricKind = 'UNIQUE_USERS' | 'TOTAL_EVENTS' | 'EXTERNAL_AGGREGATE';

export interface MetricValue {
  key: string;
  labelFa: string;
  kind: MetricKind;
  /** `null` = not measurable; `unavailableReason` then explains why (never a silent zero). */
  value: number | null;
  unavailableReason: string | null;
  /** The authoritative source of this number, printed under the metric (§14). */
  source: string;
  /** Extra, already-formatted facts (e.g. attempt vs terminal failure breakdown). */
  detail: string[];
}

export interface MetricSection {
  key: string;
  titleFa: string;
  metrics: MetricValue[];
  notes: string[];
}

export interface AdminResult<T> {
  ok: true;
  value: T;
}

export interface AdminFailure {
  ok: false;
  code: AdminErrorCode;
  message: string;
}

export type AdminErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DISABLED'
  | 'LIMIT_EXCEEDED'
  | 'NOT_RETRYABLE'
  | 'PERSISTENCE_FAILED';

export type AdminOutcome<T> = AdminResult<T> | AdminFailure;

export function adminOk<T>(value: T): AdminResult<T> {
  return { ok: true, value };
}

export function adminFail(code: AdminErrorCode, message: string): AdminFailure {
  return { ok: false, code, message };
}

export const ADMIN_DOCUMENT_VERSION = 1;

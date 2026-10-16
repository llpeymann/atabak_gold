/**
 * Phase 8 — Campaign Tracking & Attribution: domain model.
 *
 * Every type in this file exists to keep five *different kinds of truth* apart, because mixing them
 * silently is the one failure this subsystem must not have (§1, §16):
 *
 *  1. `NATIVE`     — this bot observed the event itself (a click on its own endpoint, a new start, an
 *                    alert created through the real Phase 3 path).
 *  2. `IMPORTED`   — an aggregate number an external ad platform reported (never user level).
 *  3. `MANUAL`     — an authorized operator recorded it (leads/customers).
 *  4. `UNAVAILABLE`— the metric cannot be measured at all with the current platform capabilities.
 *  5. `REJECTED`   — an ingestion attempt that was refused (duplicate, forged token, bot fetch).
 *
 * Nothing here is a second user database or a second alert engine: identities are the existing
 * `platform` + `platformUserId` pair (§5.4) and alert data is *read* from Phase 3.
 */

import { BotRoute } from '../bot/deep-link';
import { Platform } from '../platform/platform.types';

// --- vocabularies --------------------------------------------------------------

/**
 * Lifecycle of a campaign.
 *
 * `PAUSED` stops new *public* links from working (and stops new starts/clicks being accepted) while
 * every historical event, attribution and conversion stays untouched. `ENDED` is terminal: the
 * campaign is closed for good, history is still readable.
 */
export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

/**
 * Where a campaign sends people.
 *
 *  * `BOT_START` — a route of *this* bot (`alert`, `prices`, `coin`, `gold`, `channel`); the value is
 *    validated against the existing `BotRoute` allow-list, so a campaign can never become an open
 *    redirect.
 *  * `CHANNEL_INVITE` — the public channel of a platform (`bale` | `telegram`); the value is a
 *    platform key, and the link is only produced when that channel URL is really configured.
 */
export type CampaignDestinationType = 'BOT_START' | 'CHANNEL_INVITE';

/** Funnel stages, in the order the subsystem reports them (§8). */
export type FunnelStage =
  | 'IMPRESSION'
  | 'CLICK'
  | 'START'
  | 'CHANNEL_JOIN'
  | 'ALERT_CREATED'
  | 'LEAD'
  | 'CUSTOMER';

export const FUNNEL_STAGES: readonly FunnelStage[] = [
  'IMPRESSION',
  'CLICK',
  'START',
  'CHANNEL_JOIN',
  'ALERT_CREATED',
  'LEAD',
  'CUSTOMER',
];

/** Conversions an operator can register manually (never inferred, §8.6/§8.7). */
export type ConversionType = 'LEAD' | 'CUSTOMER';

/**
 * How a metric was counted. Every number the dashboard prints carries exactly one of these labels,
 * so “unique users”, “total events” and “a number somebody else measured” can never be confused.
 */
export type MetricKind =
  /** Distinct identities (platform + platform user id). */
  | 'UNIQUE_USERS'
  /** Raw occurrences, duplicates included. */
  | 'TOTAL_EVENTS'
  /** Aggregate count reported by an external platform for a period. */
  | 'EXTERNAL_AGGREGATE';

/** Where a stored datum came from (see the file header). */
export type Provenance = 'NATIVE' | 'IMPORTED' | 'MANUAL';

/** The two required attribution models (§10). They are computed independently, never merged. */
export type AttributionModel = 'FIRST_TOUCH' | 'LAST_TOUCH';

export const ATTRIBUTION_MODELS: readonly AttributionModel[] = [
  'FIRST_TOUCH',
  'LAST_TOUCH',
];

/**
 * Documented taxonomy for conversions that do **not** end up credited to a campaign (§10.7).
 *
 * `NO_TOUCH` and `EXPIRED_WINDOW` are the classic organic/direct/unattributed buckets; the other two
 * exist so that a conversion is never silently credited to something that did not happen.
 */
export type AttributionBucket =
  /** An eligible touch inside the window was found and credited. */
  | 'CAMPAIGN'
  /** No campaign touch was ever observed for this identity (organic / direct). */
  | 'NO_TOUCH'
  /** A touch exists, but the conversion happened later than the attribution window allows. */
  | 'EXPIRED_WINDOW'
  /** The only known touch happened *after* the conversion time — crediting it would be time travel. */
  | 'TOUCH_AFTER_CONVERSION'
  /** Tracking is switched off, so no attribution is established at all. */
  | 'TRACKING_DISABLED';

/** What the redirect endpoint does with one request (§7.2/§7.4). */
export type ClickDecision =
  /** Forward to the configured destination. */
  | 'REDIRECT'
  /** The reference exists but does not accept traffic any more (paused/ended/out of range). */
  | 'GONE'
  /** The reference is unknown — nothing to forward to, and never an open redirect. */
  | 'NOT_FOUND';

/** Classification of one recorded click request (§7.3). */
export type ClickClassification =
  /** A real user click: the request came from a real client and carried no preview marker. */
  | 'HUMAN'
  /** A link-preview/bot fetch (a `bot`/crawler user agent): recorded, never counted as a click. */
  | 'PREVIEW'
  /** A request that could not be told apart (missing user agent): recorded, never counted as human. */
  | 'UNCLASSIFIED';

/** One denominator-aware percentage; `N/A` is a real outcome, not a zero (§16). */
export interface Ratio {
  /** `null` = the denominator is 0, so the ratio does not exist (rendered as `N/A`). */
  percent: number | null;
  numerator: number;
  denominator: number;
}

// --- stored records ------------------------------------------------------------

/** A campaign as it is persisted (§5.1). */
export interface CampaignRecord {
  /** Stable, human-quotable id (`cmp_<n>`), unique across the document. */
  campaignId: string;
  name: string;
  /** Acquisition source (`telegram_ad`, `bale_ad`, `instagram`, `friend`, `channel_post`, …). */
  source: string;
  /** Optional buying *medium* (`cpc`, `post`, `story`, …) — deliberately separate from `source`. */
  medium: string | null;
  status: CampaignStatus;
  destinationType: CampaignDestinationType;
  /** `BotRoute` for `BOT_START`, platform key for `CHANNEL_INVITE`. */
  destination: string;
  /** Opaque, unique tracking token used in links and start payloads. */
  trackingToken: string;
  createdAt: string;
  /** Platform user id of the operator who created it (`null` for non-interactive creation). */
  createdBy: string | null;
  startAt: string | null;
  endAt: string | null;
  costAmount: number | null;
  costCurrency: string | null;
  updatedAt: string;
  note: string | null;
}

/**
 * Attribution of one identity (§5.2).
 *
 * Both models live in one record because they are two *views* of the same ordered touch list: the
 * earliest known touch and the most recent eligible one. Neither is ever fabricated: a user whose
 * history predates campaign tracking simply has no record (and stays unattributed, §10.3).
 */
export interface CampaignAttributionRecord {
  /** `platform:platformUserId` — the existing identity, no cross-platform merging (§5.4). */
  identityKey: string;
  platform: Platform;
  platformUserId: string;
  /** Earliest observed touch of this identity; once set it is never overwritten (§10.2). */
  firstTouchCampaignId: string | null;
  firstTouchAt: string | null;
  /** Evidence of the earliest touch, e.g. `click:evt_1` or `start:evt_9`. */
  firstTouchEvidence: string | null;
  /** Most recent touch (updated by every accepted touch, §10.4). */
  lastTouchCampaignId: string | null;
  lastTouchAt: string | null;
  lastTouchEvidence: string | null;
  /** Models for which this record currently carries evidence. */
  models: AttributionModel[];
  establishedAt: string;
  updatedAt: string;
}

/** A funnel event observed or recorded by this bot (§5.3). */
export interface CampaignEventRecord {
  eventId: string;
  type: FunnelStage;
  campaignId: string | null;
  platform: Platform | null;
  platformUserId: string | null;
  identityKey: string | null;
  /** When the event happened (ISO). */
  occurredAt: string;
  /** When this bot ingested it (ISO) — never overwritten, so late ingestion stays visible (§10.6). */
  recordedAt: string;
  provenance: Provenance;
  /** Unique key that makes replaying the same ingestion a no-op (§11). */
  idempotencyKey: string;
  /** Minimal, non-identifying metadata (never tokens, payloads, prices or private content). */
  meta: Record<string, string>;
  /** External reference of the originating object (message id, request id, …) when one exists. */
  externalRef: string | null;
  /** Present for `CLICK` events: how the raw request was classified. */
  clickClassification?: ClickClassification;
}

/**
 * An aggregate number imported from an external platform (§5.5).
 *
 * `value` is an aggregate for a period: it is *never* exploded into per-user events, and it is
 * reported under `EXTERNAL_AGGREGATE` so it can never be mistaken for our own measurement.
 */
export interface ExternalMetricImportRecord {
  importId: string;
  /** The funnel stage this aggregate describes (in practice `IMPRESSION` or `CLICK`). */
  metric: FunnelStage;
  campaignId: string;
  provider: string;
  value: number;
  /** Inclusive period the number was reported for (ISO dates). */
  periodStart: string;
  periodEnd: string;
  /** `${provider}|${campaignId}|${metric}|${periodStart}|${periodEnd}` — duplicate-free by design. */
  dedupKey: string;
  importedAt: string;
  importedBy: string;
  note: string | null;
  /** `ACTIVE` records count; a corrected import is kept as `SUPERSEDED` for the audit trail. */
  status: 'ACTIVE' | 'SUPERSEDED';
}

/**
 * A manually registered conversion (§5.6).
 *
 * Only an authorized operator can create one, the operator and both timestamps are recorded, and a
 * correction never erases the previous row: it is marked `CORRECTED` and points at its successor.
 */
export interface ConversionRecord {
  conversionId: string;
  type: ConversionType;
  identityKey: string | null;
  platform: Platform | null;
  platformUserId: string | null;
  /** Business time of the conversion (chosen by the operator). */
  occurredAt: string;
  /** Ingestion time of this record. */
  recordedAt: string;
  recordedBy: string;
  /** The campaign this conversion is credited to (last-touch wins, §10.4); `null` = unattributed. */
  campaignId: string | null;
  /** The model that produced `campaignId` (`null` when nothing was credited). */
  attributionModel: AttributionModel | null;
  attributionBucket: AttributionBucket;
  /** Short explanation of the decision, kept next to the data (not only in a log line). */
  attributionReason: string;
  /** Evidence of the credited touch (`<model>:<campaignId>@<iso>`), when one was credited. */
  attributionEvidence: string | null;
  /**
   * Both model results are frozen here at ingestion time, so a later touch can never rewrite what a
   * report said yesterday (§10.6). `bucket` = why the model did or did not credit a campaign.
   */
  firstTouch: { campaignId: string | null; bucket: AttributionBucket };
  lastTouch: { campaignId: string | null; bucket: AttributionBucket };
  status: 'ACTIVE' | 'CORRECTED';
  /** Set on a corrected row: the id of the row that replaced it. */
  supersededBy: string | null;
  note: string | null;
}

/**
 * Last channel-membership observation of one identity (§8.4).
 *
 * A *verified join* is only recorded on a real transition (`NOT_MEMBER` → `MEMBER`) between two
 * platform answers. Without an earlier “not a member” answer the membership may predate the campaign,
 * so nothing is credited; when the platform cannot answer (Bale, or verification switched off) joins
 * stay `UNAVAILABLE` instead of being guessed.
 */
export interface MembershipObservationRecord {
  identityKey: string;
  platform: Platform;
  platformUserId: string;
  state: 'MEMBER' | 'NOT_MEMBER';
  observedAt: string;
  /** The campaign that was attributed to this identity when the observation was made (`null` = none). */
  campaignId: string | null;
}

/**
 * Aggregated counters of *rejected* ingestion (§16 category 5).
 *
 * Rejections are counted, not stored as events: an unknown token, a paused campaign or a crawler
 * fetch is not data about a user, and keeping attacker-controlled traffic would be both a privacy and
 * a growth problem. The counters are bounded by `campaignId|reason`.
 */
export interface CampaignRejectionRecord {
  key: string;
  campaignId: string | null;
  reason: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

/** A privileged change, kept in the same document so the audit trail cannot drift from the data. */
export interface CampaignAuditRecord {
  auditId: string;
  at: string;
  operator: string;
  action: string;
  campaignId: string | null;
  detail: string;
}

/** On-disk shape. */
export interface CampaignDocument {
  version: number;
  savedAt: string;
  campaigns: CampaignRecord[];
  attributions: CampaignAttributionRecord[];
  events: CampaignEventRecord[];
  conversions: ConversionRecord[];
  imports: ExternalMetricImportRecord[];
  audit: CampaignAuditRecord[];
  membership: MembershipObservationRecord[];
  rejections: CampaignRejectionRecord[];
  /** Monotonic id sequences, persisted so a generated id never collides after a restart. */
  sequences: Record<string, number>;
}

// --- commands / results --------------------------------------------------------

export interface CampaignCreationInput {
  name: string;
  source: string;
  medium?: string | null;
  destinationType: CampaignDestinationType;
  destination: string;
  startAt?: string | null;
  endAt?: string | null;
  costAmount?: number | null;
  costCurrency?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/** Machine-readable failure reasons; the admin surface renders them as Persian sentences. */
export type CampaignErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_SOURCE'
  | 'INVALID_MEDIUM'
  | 'INVALID_DESTINATION_TYPE'
  | 'INVALID_DESTINATION'
  | 'INVALID_DATE_RANGE'
  | 'INVALID_COST'
  | 'INVALID_STATUS_TRANSITION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'INVALID_IDENTITY'
  | 'INVALID_CONVERSION_TIME'
  | 'INVALID_IMPORT';

export type CampaignResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CampaignErrorCode; message: string };

export function campaignOk<T>(value: T): CampaignResult<T> {
  return { ok: true, value };
}

export function campaignFail<T>(
  code: CampaignErrorCode,
  message: string,
): CampaignResult<T> {
  return { ok: false, code, message };
}

/** A touch of one identity, in a form the attribution rules can consume (§10). */
export interface CampaignTouch {
  campaignId: string;
  /** Business time of the touch. */
  occurredAt: Date;
  /** Ingestion time — the deterministic tie-breaker. */
  recordedAt: Date;
  eventId: string;
  type: 'CLICK' | 'START' | 'CHANNEL_JOIN';
}

/** Outcome of evaluating the two attribution models for one identity at one point in time. */
export interface AttributionDecision {
  model: AttributionModel;
  campaignId: string | null;
  bucket: AttributionBucket;
  touch: CampaignTouch | null;
  reason: string;
}

/** The result of resolving an incoming tracking reference (a start payload or a redirect token). */
export interface TrackingResolution {
  campaign: CampaignRecord;
  /** `false` when the campaign is paused/ended or outside its date range: nothing is recorded. */
  accepting: boolean;
  /** Human-readable reason when `accepting` is false. */
  blockedReason: string | null;
}

/** Route allow-list used for `BOT_START` destinations (reuses the Phase 6 routes, §6). */
export type CampaignBotRoute = BotRoute;

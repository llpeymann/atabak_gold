/**
 * Phase 5 — Channel Engine domain contracts.
 *
 * Three concepts are kept strictly apart (§4, §9, §10 of the phase specification):
 *
 *   ContentItem        — the *text* of an editorial message and its approval state,
 *   PublicationJob     — one logical "publish X to destination-set D for window W",
 *   PublicationDelivery— the per-platform result of one job.
 *
 * Nothing here knows how a platform is called, and nothing here contains market data.
 */
import { BotRoute } from '../bot/deep-link';

// The channel layer references bot routes by name (CTA intents); re-exported so channel modules have a
// single import site.
export type { BotRoute };
import { Platform } from '../platform/platform.types';
import { PriceDirection, PriceUnit } from '../market/market.types';

// --- message types (§5) -------------------------------------------------------

export type MessageType =
  | 'PRICE_UPDATE'
  | 'MARKET_MOVEMENT'
  | 'DAILY_RANGE'
  | 'DAILY_REPORT'
  | 'EDUCATIONAL'
  | 'BRANDED'
  | 'NIGHTLY_ANALYSIS';

export const MESSAGE_TYPES: readonly MessageType[] = [
  'PRICE_UPDATE',
  'MARKET_MOVEMENT',
  'DAILY_RANGE',
  'DAILY_REPORT',
  'EDUCATIONAL',
  'BRANDED',
  'NIGHTLY_ANALYSIS',
];

export function isMessageType(value: unknown): value is MessageType {
  return MESSAGE_TYPES.includes(value as MessageType);
}

/** Market messages are produced from validated data; editorial messages are written by a person. */
export type MessageKind = 'MARKET' | 'EDITORIAL';

export type PriceUpdateVariant = 'full' | 'poster';

// --- publication job (§9) -----------------------------------------------------

export type PublicationStatus =
  | 'PENDING'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  /** Not sent — and it never will be. A *typed* reason is always stored with it. */
  | 'SKIPPED';

/**
 * Why a publication did not happen (§16). Typed, exhaustive and part of the stored record: an
 * operator (and a test) can tell "no fresh data" apart from "the operator cancelled it".
 */
export type SkipReason =
  | 'INVALID_MARKET_SNAPSHOT'
  | 'STALE_MARKET_DATA'
  | 'MISSING_REQUIRED_SYMBOL'
  | 'INVALID_DAILY_STATISTICS'
  | 'CONTENT_NOT_APPROVED'
  | 'CONTENT_NOT_PUBLISHABLE'
  | 'PUBLICATION_CANCELLED'
  | 'DUPLICATE_PUBLICATION'
  | 'DESTINATION_UNAVAILABLE'
  | 'MISSED_WINDOW'
  | 'MOVEMENT_BELOW_THRESHOLD'
  | 'RANGE_EVENT_SUPPRESSED'
  | 'TYPE_DISABLED'
  /** Phase 10 — the operator switched publishing off; the work item is left pending, not lost. */
  | 'PUBLISHING_DISABLED';

export interface PublicationJob {
  id: string;
  messageType: MessageType;
  /** `PRICE_UPDATE` only: the two rendering variants are two different publications. */
  variant: PriceUpdateVariant | null;
  status: PublicationStatus;
  /**
   * Stable logical identity (§12). The same key can exist only once — that is what makes
   * "publish this window once" a state transition instead of an in-memory boolean.
   */
  idempotencyKey: string;
  /** Sorted platform list the job was created for (idempotency is scoped to the destination set). */
  destinationKey: string;
  /** When the publication *should* happen (cron tick / approved schedule time). */
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Editorial source, when the job is editorial. */
  contentId: string | null;
  contentRevision: number | null;
  /** Tehran reporting day (`null` for messages that are not bound to a day). */
  reportingDate: string | null;
  /** Symbols the message is about (empty for editorial messages). */
  subjects: string[];
  attemptCount: number;
  lastError: string | null;
  skipReason: SkipReason | null;
}

// --- delivery (§10) -----------------------------------------------------------

export type DeliveryStatus =
  | 'PENDING'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  /** The platform never answered: the message *may* be published. Never auto-retried (§13). */
  | 'UNKNOWN';

/**
 * Failure classification (§13/§14).
 * `RETRYABLE` — the platform explicitly refused the request (5xx/429); a bounded retry is safe.
 * `PERMANENT` — the request itself is wrong (4xx); retrying would fail again.
 * `AMBIGUOUS` — no answer at all (timeout/socket reset); a retry could duplicate the message.
 */
export type FailureCategory = 'RETRYABLE' | 'PERMANENT' | 'AMBIGUOUS';

export type MediaStatus = 'NOT_ATTACHED' | 'SENT' | 'FAILED';

export interface PublicationDelivery {
  id: string;
  publicationJobId: string;
  platform: Platform;
  /** Channel/chat the message was sent to (never a token). */
  destination: string;
  status: DeliveryStatus;
  attemptCount: number;
  failureCategory: FailureCategory | null;
  /** Platform id of the delivered message (proof of delivery, kept for traceability). */
  externalMessageId: string | null;
  /** Platform id of the separate media message, when one was sent (§14 media rule). */
  mediaMessageId: string | null;
  mediaStatus: MediaStatus;
  mediaError: string | null;
  createdAt: string;
  sentAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /**
   * Phase 6 — the CTA route attached to this delivery, or `null` when the message went out without a
   * button (feature disabled, or no public bot username for that platform). Optional so documents
   * written before Phase 6 keep loading.
   */
  ctaRoute?: BotRoute | null;
}

// --- editorial content (§7) ---------------------------------------------------

export type ContentStatus =
  'DRAFT' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED' | 'CANCELLED';

/**
 * Phase 6 — call-to-action choice stored on an editorial item.
 *
 * `auto` follows the message-type policy; `none` removes the button entirely; a concrete route is an
 * explicit admin decision (the only way an *alert-promotion* post can exist, §4.2).
 */
export type CtaRouteChoice = 'auto' | 'none' | BotRoute;

/**
 * The complete, canonical set of CTA choices (Phase 6 §4.2). Every other list — configuration
 * validation, the admin command, the item view — is derived from this one, so a choice can never be
 * accepted in one place and refused in another.
 */
export const CTA_CHOICES: readonly CtaRouteChoice[] = [
  'auto',
  'none',
  'alert',
  'prices',
  'coin',
  'gold',
  'channel',
];

/** Runtime guard for the CTA choice (configuration/admins may hand over arbitrary strings). */
export function isCtaRouteChoice(value: unknown): value is CtaRouteChoice {
  return (
    typeof value === 'string' &&
    (CTA_CHOICES as readonly string[]).includes(value)
  );
}

export interface ContentItem {
  id: string;
  messageType: MessageType;
  /** Internal title (admin-facing; also used as the message headline). */
  title: string;
  /** The human-written body. Never generated (§4). */
  body: string;
  /**
   * Optional single image URL (validated `http(s)`), delivered as a photo message.
   */
  mediaUrl: string | null;
  /**
   * `NIGHTLY_ANALYSIS` (and any editorial type) may append the *validated* market block taken from
   * the Phase 4 snapshot. The block is data, never editorial text.
   */
  includeMarketData: boolean;
  /**
   * Call-to-action override (Phase 6). Absent on documents written before Phase 6 — readers must treat
   * a missing value exactly like `auto`.
   */
  ctaRoute?: CtaRouteChoice;
  /** Incremented on every material edit; a new revision invalidates a previous approval (§19). */
  revision: number;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  scheduledAt: string | null;
  /** Tehran reporting date the content belongs to (`null` = “not dated”). */
  reportingDate: string | null;
  /** Latest publication job created for this item (history is kept in `jobs`). */
  lastJobId: string | null;
  cancelledAt: string | null;
  /** Why the last attempt failed, when it did (sanitized, never a secret). */
  lastError: string | null;
}

export type ContentMutationFailure =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_INPUT'
  | 'LIMIT_REACHED'
  | 'NOT_AUTHORIZED';

export type ContentMutationResult =
  | { ok: true; content: ContentItem }
  | { ok: false; reason: ContentMutationFailure; detail?: string };

// --- event state (§17, §18) ---------------------------------------------------

/** Per symbol+Tehran-day state of the movement de-duplication policy. */
export interface MovementEventState {
  symbol: string;
  dayKey: string;
  lastPublishedAt: string;
  lastDirection: PriceDirection;
  /** `false` until the movement has fallen back below the re-arm level (§17). */
  armed: boolean;
}

/** Per symbol+Tehran-day state of the daily-range event policy (§18). */
export interface RangeEventState {
  symbol: string;
  dayKey: string;
  lastEvent: 'HIGH' | 'LOW';
  /**
   * When the last *event* of the day was published; `null` while the day only has a baseline.
   *
   * A baseline is not an event, so it must not start the cooldown — otherwise the first genuine
   * extreme of a day could be silently swallowed by the cooldown of a message that was never sent.
   */
  lastPublishedAt: string | null;
  /** Last extreme the event was published for (used to detect a genuinely new extreme). */
  high: number | null;
  low: number | null;
}

/** Persisted document (one JSON file, atomic writes — same pattern as Phases 1–3). */
export interface PersistedChannelData {
  version: number;
  savedAt: string;
  contents: ContentItem[];
  jobs: PublicationJob[];
  deliveries: PublicationDelivery[];
  movementEvents: MovementEventState[];
  rangeEvents: RangeEventState[];
  /**
   * Phase 10 — durable operational settings.
   *
   * Optional on purpose: a document written before Phase 10 keeps loading, and a missing switch means
   * “publishing enabled”, which is exactly the behaviour those deployments already had.
   */
  settings?: ChannelSettings;
}

export interface ChannelSettings {
  /** `false` = the operator paused publishing; scheduled work stays pending instead of being lost. */
  publishingEnabled: boolean;
  /** Who changed it last and when (an operator identity, never a secret). */
  publishingChangedBy?: string | null;
  publishingChangedAt?: string | null;
}

// --- payload contract (§15) ---------------------------------------------------

/** A channel → bot call to action: the logical route plus its (destination-neutral) label. */
export interface PublicationCta {
  route: BotRoute;
  labelFa: string;
}

export interface PublicationMedia {
  /** Absolute `http(s)` URL, already validated when the content was saved. */
  url: string;
}

export interface PublicationMeta {
  /** Tehran day this publication reports about (`null` when not dated). */
  reportingDate: string | null;
  /** Symbols whose validated values the message contains. */
  symbols: string[];
  variant: PriceUpdateVariant | null;
  /** Content revision behind an editorial publication. */
  contentRevision: number | null;
}

/**
 * The only object a destination adapter receives. It is *already rendered*: no adapter may fetch a
 * price, validate a value or decide anything about the market.
 */
export interface PublicationPayload {
  /** Logical publication id (= job id) — the same for every destination of one job. */
  publicationId: string;
  messageType: MessageType;
  text: string;
  /** Only HTML is produced (all text is escaped before rendering), so it is a literal type. */
  parseMode: 'HTML';
  /**
   * Phase 6 — call to action of this publication, if any.
   *
   * Only the *intent* is stored here; the platform-specific URL is built per destination by
   * `BotDestinationService` (a Bale link is not a Telegram link), so the button is correct on each
   * platform and simply omitted where no public bot username is configured.
   */
  cta: PublicationCta | null;
  media: PublicationMedia | null;
  /** Platforms the payload is intended for (idempotency scope, §12). */
  destinationKey: string;
  meta: PublicationMeta;
}

// --- results ------------------------------------------------------------------

/** Summary of one executed (or skipped) publication, returned to the caller/logger. */
export interface PublicationOutcome {
  jobId: string;
  messageType: MessageType;
  status: PublicationStatus;
  skipReason: SkipReason | null;
  deliveries: PublicationDelivery[];
}

export type ChannelEntityPrefix = 'cnt' | 'pub' | 'dlv';

/**
 * Entity id: `<prefix>_<36-radix time>_<8 random chars>` — the same shape Phase 2/3 use, so ids are
 * safe to carry inside a callback payload (`^[a-z]{3}_[a-z0-9_]{1,40}$`).
 */
export function createChannelId(prefix: ChannelEntityPrefix): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

const CHANNEL_ID_PATTERN = /^[a-z]{3}_[a-z0-9_]{1,40}$/;

export function isSafeChannelId(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_ID_PATTERN.test(value);
}

/** Symbols carried inside a job record (used for diagnostics only). */
export type ChannelSymbolUnit = PriceUnit;

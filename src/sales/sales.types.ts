/**
 * Phase 9 — Sales Engine: domain model.
 *
 * The Sales Engine adds a **conversational lead workflow** on top of the existing project: no new
 * database engine, no CRM, no second identity system. Everything here maps onto the same document
 * store pattern the other phases use (atomic `tmp` + `rename` write, copy-on-write transaction, one
 * writer per process), and every customer-facing number is an *identifier*, never a display string.
 *
 * Three concepts are deliberately kept apart (§11.1), because merging them is the classic way a
 * sales report starts lying:
 *
 *  1. `LEAD_CREATED`       — a quotation request was *durably persisted* (see `LeadRecord`).
 *  2. `CUSTOMER_CONVERTED` — an authorized administrator recorded that the lead became a customer
 *                            (a Phase 8 `CUSTOMER` conversion row, §12.3).
 *  3. `SALE_RECORDED`      — an authorized administrator recorded a real sale outcome with an
 *                            optional verified amount (`SalesOutcomeRecord`), §11.2.
 */

// --- product categories --------------------------------------------------------

/**
 * Stable internal category identifiers, independent of their Persian display labels (§3.2).
 *
 * Adding a category later is a data change here plus a label — no handler restructuring, because
 * every handler iterates this registry instead of hard-coding the three initial values.
 */
export type ProductCategory = 'MANUFACTURED_GOLD' | 'MELTED_GOLD' | 'COIN';

export interface ProductCategoryDefinition {
  category: ProductCategory;
  /** Persian label shown to the customer (the single source of truth for this wording). */
  labelFa: string;
  /** Examples offered as *inspiration*, never as a verified inventory (§3.3). */
  exampleItemsFa: readonly string[];
  /**
   * Symbols of the validated Phase 1 market state used as a **market reference price** for this
   * category. An empty list means the project has no trustworthy reference for it — the flow then
   * says so instead of inventing a number (§4.1).
   */
  referenceSymbols: readonly string[];
  /** Why a final price cannot be derived from the reference alone (shown to the customer). */
  pricingNoteFa: string;
}

export const PRODUCT_CATEGORIES: readonly ProductCategoryDefinition[] = [
  {
    category: 'MANUFACTURED_GOLD',
    labelFa: '🥇 طلای ساخته',
    exampleItemsFa: ['انگشتر طلا', 'گردنبند طلا', 'دستبند طلا', 'گوشواره طلا'],
    referenceSymbols: ['IR_GOLD_18K'],
    pricingNoteFa:
      'قیمت نهایی طلای ساخته به وزن، عیار، اجرت ساخت و مالیات بستگی دارد و فقط با تأیید کارشناس مشخص می‌شود.',
  },
  {
    category: 'MELTED_GOLD',
    labelFa: '🟡 طلای آب‌شده',
    exampleItemsFa: ['طلای آب‌شده', 'شمش آب‌شده'],
    referenceSymbols: ['IR_GOLD_MELTED'],
    pricingNoteFa:
      'قیمت آب‌شده بر پایه قیمت مرجع بازار است؛ قیمت قطعی معامله پس از تأیید کارشناس اعلام می‌شود.',
  },
  {
    category: 'COIN',
    labelFa: '🪙 سکه',
    exampleItemsFa: ['سکه امامی', 'نیم‌سکه', 'ربع‌سکه', 'سکه بهار آزادی'],
    referenceSymbols: [
      'IR_COIN_EMAMI',
      'IR_COIN_BAHAR',
      'IR_COIN_HALF',
      'IR_COIN_QUARTER',
    ],
    pricingNoteFa:
      'قیمت قطعی سکه بر پایه قیمت مرجع بازار و در زمان تأیید سفارش اعلام می‌شود.',
  },
];

export const DEFAULT_PRODUCT_CATEGORY: ProductCategory = 'MANUFACTURED_GOLD';

export function isProductCategory(value: unknown): value is ProductCategory {
  return (
    typeof value === 'string' &&
    PRODUCT_CATEGORIES.some((definition) => definition.category === value)
  );
}

export function categoryDefinition(
  category: ProductCategory,
): ProductCategoryDefinition {
  const found = PRODUCT_CATEGORIES.find(
    (definition) => definition.category === category,
  );

  // The registry is a compile-time constant; the fallback keeps the function total for callers
  // that hand in a value which somehow escaped validation.
  return found ?? PRODUCT_CATEGORIES[0];
}

// --- lead lifecycle ------------------------------------------------------------

export type LeadStatus =
  'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'LOST';

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'LOST',
];

/**
 * Allowed status transitions (§10.2).
 *
 * Terminal-by-default: `CONVERTED` and `LOST` can only move through an *explicit* authorized
 * re-open action, which is audited. Nothing else may jump arbitrarily.
 */
export const ALLOWED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ['CONTACTED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'LOST'],
  QUALIFIED: ['CONVERTED', 'LOST', 'CONTACTED'],
  CONVERTED: ['QUALIFIED'],
  LOST: ['NEW'],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Why a sales opportunity was lost (§10.1/§11.2) — a fixed vocabulary, never free-form status. */
export type LossReason =
  | 'NO_RESPONSE'
  | 'PRICE'
  | 'NOT_INTERESTED'
  | 'BOUGHT_ELSEWHERE'
  | 'INVALID_CONTACT'
  | 'OUT_OF_STOCK'
  | 'OTHER';

export const LOSS_REASONS: readonly LossReason[] = [
  'NO_RESPONSE',
  'PRICE',
  'NOT_INTERESTED',
  'BOUGHT_ELSEWHERE',
  'INVALID_CONTACT',
  'OUT_OF_STOCK',
  'OTHER',
];

export function isLossReason(value: unknown): value is LossReason {
  return (
    typeof value === 'string' && LOSS_REASONS.includes(value as LossReason)
  );
}

/** Which model credited the campaign on a lead, mirroring Phase 8 (never re-invented here). */
export type LeadAttributionModel = 'FIRST_TOUCH' | 'LAST_TOUCH';

/** Phase 8 bucket vocabulary, copied by value so a sales record stays readable on its own. */
export type LeadAttributionBucket =
  | 'CAMPAIGN'
  | 'NO_TOUCH'
  | 'EXPIRED_WINDOW'
  | 'TOUCH_AFTER_CONVERSION'
  | 'TRACKING_DISABLED';

/** How the Phase 8 lead/customer record for this lead ended up (§12.2). */
export type Phase8LeadLink =
  /** A Phase 8 `LEAD` conversion row was recorded for this lead. */
  | 'RECORDED'
  /** Phase 8 already had an active `LEAD` row for this identity — not duplicated (§12.4). */
  | 'ALREADY_RECORDED'
  /** The identity has no campaign attribution; nothing to attach (still a valid lead). */
  | 'UNATTRIBUTED'
  /** Campaign tracking is switched off; recorded on the lead and reported as such. */
  | 'TRACKING_DISABLED'
  /** Phase 8 refused or failed to persist the link — kept for retry/diagnosis, never hidden. */
  | 'FAILED';

/** Per-lead link state, so a failed integration is visible instead of silently swallowed. */
export interface LeadPhase8Link {
  status: Phase8LeadLink;
  /** Phase 8 conversion id (`cnv_…`) when one exists. */
  conversionId: string | null;
  attributionModel: LeadAttributionModel | null;
  bucket: LeadAttributionBucket;
  /** Human-readable reason of the current status (Persian, operator-facing). */
  reason: string;
  updatedAt: string;
}

// --- stored records ------------------------------------------------------------

/**
 * One quotation request.
 *
 * The customer's submission is stored once and never overwritten: later changes live in the
 * activity history and in the sales outcome rows, so a correction cannot rewrite what the customer
 * originally asked for (§10.3).
 */
export interface LeadRecord {
  /** Stable internal id (`lead_<n>`); never shown to customers. */
  leadId: string;
  /** Customer-safe public reference (`SL-XXXXXXXX`), unique in the document (§7.2). */
  reference: string;
  /**
   * Durable idempotency key of *this submission* (`sub_<random>`), generated in the form session.
   * A repeated confirmation callback (double click, platform redelivery) resolves to the same lead
   * instead of creating a second one (§7.3).
   */
  submissionKey: string;
  /** Existing Phase 2 identity; the Sales Engine never invents a second user system (§7.1). */
  userId: string;
  identityKey: string;
  platform: 'bale' | 'telegram';
  platformUserId: string;
  /** Chat the request came from, used to answer the same conversation. */
  chatId: string | null;
  customerName: string;
  /** Canonical `+98…` form, suitable for matching and contact (§5.2). */
  phone: string;
  /** Always `false` in this phase: nothing here proves the customer owns the number (§5.2). */
  phoneVerified: boolean;
  category: ProductCategory;
  /** Customer-provided description; *not* an inventory SKU (§3.3). */
  productDescription: string | null;
  notes: string | null;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
  /** Version of the consent text the customer saw before submitting (§6). */
  consentTextVersion: string;
  consentedAt: string;
  /** Platform user id of the assigned operator (`null` = unassigned). */
  assignedTo: string | null;
  /** Last recorded contact attempt (ISO). */
  lastContactAt: string | null;
  /** Number of recorded contact attempts (derived from the activity log, kept for fast listing). */
  contactAttempts: number;
  lossReason: LossReason | null;
  lossNote: string | null;
  /** Frozen attribution resolved with Phase 8 rules at creation time (§12.1). */
  campaignId: string | null;
  campaignName: string | null;
  campaignSource: string | null;
  attributionModel: LeadAttributionModel | null;
  attributionBucket: LeadAttributionBucket;
  attributionReason: string;
  /** Frozen at creation: a later touch can never rewrite what this lead was attributed to (§12.1). */
  attributedAt: string | null;
  /** Id of the Phase 8 conversion row that represents the conversion to customer (`cnv_…`). */
  customerConversionId: string | null;
  customerConvertedAt: string | null;
  /** State of the Phase 8 `CUSTOMER` link (set when the lead is converted). */
  phase8Customer: LeadPhase8Link | null;
  /** Id of the active sale outcome (`sale_<n>`), when one was recorded. */
  saleOutcomeId: string | null;
  /** Where this identity last saw the quotation reference, for support conversations. */
  phase8: LeadPhase8Link;
}

/** One durable activity row of a lead's history (§10.3). */
export type LeadAction =
  | 'CREATED'
  | 'STATUS_CHANGED'
  | 'ASSIGNED'
  | 'NOTE_ADDED'
  | 'CONTACT_LOGGED'
  | 'CUSTOMER_CONVERTED'
  | 'SALE_RECORDED'
  | 'SALE_CORRECTED'
  | 'LOST'
  | 'REOPENED'
  | 'CUSTOMER_NOTIFIED'
  | 'ADMIN_NOTIFIED'
  | 'NOTIFICATION_FAILED'
  | 'PHASE8_LINK';

export interface LeadActivityRecord {
  activityId: string;
  leadId: string;
  action: LeadAction;
  /** Operator that performed the action (`system:sales` for engine-generated rows). */
  actor: string;
  at: string;
  fromStatus: LeadStatus | null;
  toStatus: LeadStatus | null;
  /** Short, non-sensitive summary (never a copy of customer notes or the phone number). */
  summary: string;
}

/** A recorded real sales outcome (§11.2) — never inferred, never fabricated. */
export interface SalesOutcomeRecord {
  outcomeId: string;
  leadId: string;
  leadReference: string;
  outcomeType: 'SALE' | 'CANCELLED';
  /** Optional *verified* amount entered by the operator; `null` is a real answer (§14). */
  amount: number | null;
  /** ISO 4217-ish code, required whenever an amount exists. */
  currency: string | null;
  recordedAt: string;
  recordedBy: string;
  note: string | null;
  status: 'ACTIVE' | 'CORRECTED';
  /** Set when a later row replaced this one; the old row is kept as evidence (§11.2). */
  supersededBy: string | null;
}

/** Delivery state of one notification (§9.2). */
export type NotificationKind = 'ADMIN' | 'CUSTOMER';

export type NotificationStatus =
  'PENDING' | 'SENT' | 'FAILED' | 'UNDELIVERABLE';

export interface SalesNotificationRecord {
  notificationId: string;
  /** Unique idempotency key (`admin:<leadId>` / `customer:<leadId>`), so retries never duplicate. */
  key: string;
  leadId: string;
  reference: string;
  kind: NotificationKind;
  platform: 'bale' | 'telegram';
  /** Destination identity (an admin's platform user id, or the customer's own id). */
  targetUserId: string;
  status: NotificationStatus;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface SalesDocument {
  version: number;
  savedAt: string;
  leads: LeadRecord[];
  activities: LeadActivityRecord[];
  outcomes: SalesOutcomeRecord[];
  notifications: SalesNotificationRecord[];
  sequences: Record<string, number>;
}

// --- commands / results --------------------------------------------------------

export type SalesErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_PHONE'
  | 'INVALID_CATEGORY'
  | 'INVALID_DESCRIPTION'
  | 'INVALID_NOTE'
  | 'INVALID_STATUS_TRANSITION'
  | 'INVALID_LOSS_REASON'
  | 'INVALID_AMOUNT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'LIMIT_REACHED'
  | 'PERSISTENCE_FAILED';

export type SalesResult<T> =
  { ok: true; value: T } | { ok: false; code: SalesErrorCode; message: string };

export function salesOk<T>(value: T): SalesResult<T> {
  return { ok: true, value };
}

export function salesFail<T>(
  code: SalesErrorCode,
  message: string,
): SalesResult<T> {
  return { ok: false, code, message };
}

export interface LeadCreationInput {
  userId: string;
  identityKey: string;
  platform: 'bale' | 'telegram';
  platformUserId: string;
  chatId: string | null;
  customerName: string;
  phone: string;
  category: ProductCategory;
  productDescription: string | null;
  notes: string | null;
  submissionKey: string;
  consentTextVersion: string;
}

export interface LeadCreationOutcome {
  lead: LeadRecord;
  /** `false` when this submission was already persisted (idempotent replay, §7.3). */
  created: boolean;
  /** State of the Phase 8 lead link (never “success” when the event did not persist). */
  phase8: LeadPhase8Link;
}

import { Platform } from '../platform/platform.types';

/**
 * Phase 3 — Price Alert domain model.
 *
 * The model deliberately stores the *canonical* value of the Phase 1 registry unit (Rial for
 * Iranian instruments, USD for the world ounce). No conversion, no rounding and no derived price
 * is ever persisted here: a target is compared against `MarketStateService` values directly, and
 * Rial/Toman (or any other) presentation happens only in `alert-format.ts`.
 */

/** Exactly four alert behaviours are supported (Phase 3 §5). */
export type AlertType =
  'PRICE_ABOVE' | 'PRICE_BELOW' | 'PERCENT_INCREASE' | 'PERCENT_DECREASE';

export const ALERT_TYPES: readonly AlertType[] = [
  'PRICE_ABOVE',
  'PRICE_BELOW',
  'PERCENT_INCREASE',
  'PERCENT_DECREASE',
];

/** Direction of a percentage alert; `targetPercent` is always a positive magnitude. */
export type PercentDirection = 'UP' | 'DOWN';

export function isAlertType(value: unknown): value is AlertType {
  return (
    typeof value === 'string' &&
    (ALERT_TYPES as readonly string[]).includes(value)
  );
}

export function isPercentAlert(type: AlertType): boolean {
  return type === 'PERCENT_INCREASE' || type === 'PERCENT_DECREASE';
}

/**
 * Lifecycle (Phase 3 §9).
 *  - ACTIVE: evaluated on every accepted market update of its symbol,
 *  - DISABLED: kept, never evaluated,
 *  - TRIGGERED: one-shot fired; cannot fire again,
 *  - DELETED: soft-deleted; hidden, never evaluated, does not consume capacity.
 */
export type AlertStatus = 'ACTIVE' | 'DISABLED' | 'TRIGGERED' | 'DELETED';

export const ALERT_STATUSES: readonly AlertStatus[] = [
  'ACTIVE',
  'DISABLED',
  'TRIGGERED',
  'DELETED',
];

/** Statuses that consume the per-user alert capacity (frozen policy, §36). */
export const CAPACITY_STATUSES: readonly AlertStatus[] = ['ACTIVE', 'DISABLED'];

export function countsTowardsCapacity(status: AlertStatus): boolean {
  return CAPACITY_STATUSES.includes(status);
}

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

/** Machine-readable trigger reasons (Phase 3 §56) — never free-form text. */
export type TriggerReason =
  | 'PRICE_ABOVE_REACHED'
  | 'PRICE_BELOW_REACHED'
  | 'PERCENT_INCREASE_REACHED'
  | 'PERCENT_DECREASE_REACHED';

export interface Alert {
  id: string;
  /** Internal Phase 2 user id — the single source of ownership (never taken from a callback). */
  userId: string;
  /** Platform the owner talks through; used to deliver the notification. */
  platform: Platform;
  /** Canonical Phase 1 registry symbol. */
  symbol: string;
  type: AlertType;
  status: AlertStatus;
  /** Canonical-unit target for `PRICE_ABOVE`/`PRICE_BELOW` (null for percentage alerts). */
  targetPrice: number | null;
  /** Positive magnitude for percentage alerts (null for price alerts). */
  targetPercent: number | null;
  /** `UP`/`DOWN` for percentage alerts (null for price alerts). */
  direction: PercentDirection | null;
  /** Fixed reference price of a percentage alert; never recalculated implicitly. */
  baselinePrice: number | null;
  createdAt: string;
  updatedAt: string;
  triggeredAt: string | null;
  disabledAt: string | null;
  deletedAt: string | null;
}

/**
 * One row per fired alert: the durable proof that this alert already triggered, plus the
 * delivery state of the notification. It exists only to make Phase 3 reliable (§44): the alert's
 * `TRIGGERED` status and this record are written together, so a repeated evaluation, a market
 * retry or a process restart can never produce a second notification for the same trigger.
 */
export interface AlertDelivery {
  id: string;
  alertId: string;
  userId: string;
  platform: Platform;
  chatId: string;
  reason: TriggerReason;
  /** `PENDING` until the platform confirms delivery, then `SENT` (or `FAILED` when exhausted). */
  status: DeliveryStatus;
  triggerPrice: number;
  triggerPercent: number | null;
  triggeredAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  /** Sanitized failure description (never contains tokens/credentials). */
  lastError: string | null;
  /**
   * Set when the notification was deliberately not sent because the alert was deleted or
   * disabled before delivery (Phase 3 §59/§60). Kept separate from `lastError`, which means
   * "the platform failed".
   */
  skippedReason:
    'ALERT_DELETED' | 'ALERT_DISABLED' | 'DELIVERY_OUTCOME_UNKNOWN' | null;
}

/** Result of a pure condition evaluation (§54/§55). */
export interface AlertEvaluationResult {
  alertId: string;
  shouldTrigger: boolean;
  reason: TriggerReason | null;
  currentPrice: number;
  target: number;
  /** Signed percentage change (percentage alerts only, unrounded). */
  changePercent: number | null;
  evaluatedAt: string;
}

/** A market observation the alert engine reacts to (built from Phase 1, never from raw API data). */
export interface MarketObservation {
  symbol: string;
  label: string;
  /** Newly accepted current price (canonical unit). */
  currentPrice: number;
  /** The observation that immediately preceded it as reported by Phase 1 (may be null). */
  previousPrice: number | null;
  /** Whether Phase 1 compared against the same day (`SAME_DAY`) or a previous day. */
  baseline: 'SAME_DAY' | 'PREVIOUS_DAY' | 'NONE';
  observedAt: string;
}

export type AlertMutationFailure =
  | 'USER_NOT_FOUND'
  | 'UNKNOWN_SYMBOL'
  | 'INVALID_TYPE'
  | 'INVALID_TARGET'
  | 'INVALID_BASELINE'
  | 'NO_VALID_PRICE'
  | 'LIMIT_REACHED'
  | 'DUPLICATE'
  | 'ALERT_NOT_FOUND'
  | 'INVALID_STATE';

export type AlertMutationResult<T> =
  | { ok: true; alert: T }
  | { ok: false; reason: AlertMutationFailure; limit?: number };

export interface PersistedAlertData {
  version: number;
  savedAt: string;
  alerts: Alert[];
  deliveries: AlertDelivery[];
}

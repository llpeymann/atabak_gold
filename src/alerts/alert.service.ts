import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { AlertCapacityService } from './alert-capacity.service';
import { SymbolDefinition } from '../market/symbols';
import { MarketStateService } from '../market/market-state.service';
import { UserStore } from '../users/user.store';
import { AlertStore } from './alert.store';
import {
  Alert,
  AlertDelivery,
  AlertMutationFailure,
  AlertMutationResult,
  AlertType,
  countsTowardsCapacity,
  isAlertType,
  isPercentAlert,
  PercentDirection,
  TriggerReason,
} from './alert.types';

/** Target of a new (or edited) alert, already parsed from user input. */
export interface AlertTargetInput {
  type: AlertType;
  symbol: string;
  /** Canonical-unit target for absolute alerts. */
  targetPrice?: number | null;
  /** Positive magnitude for percentage alerts. */
  targetPercent?: number | null;
}

/** Current market picture of one symbol, as the alert layer is allowed to see it. */
export interface SymbolPriceSnapshot {
  symbol: string;
  label: string;
  definition: SymbolDefinition;
  /** Latest accepted price (canonical unit), or `null` when the symbol has no state at all. */
  price: number | null;
  /** True when that price is usable as a baseline / comparison value (Phase 1 freshness). */
  usable: boolean;
}

export interface TriggerReservation {
  reason: TriggerReason;
  price: number;
  percent: number | null;
  observedAt: string;
  chatId: string;
}

/**
 * Alert domain rules (§33–§38, §63, §68).
 *
 * Everything that decides whether an alert may be created, changed, triggered or deleted lives
 * here, so the bot router stays a presenter and the engine stays an orchestrator:
 *  - symbols come from the canonical Phase 1 registry (never a local list) and targets are
 *    validated against that registry's accepted range,
 *  - percentage alerts require a *usable* (fresh) Phase 1 price as baseline — the baseline is
 *    persisted and never silently recalculated,
 *  - ownership is enforced on every operation from the resolved user id, never from a callback,
 *  - capacity (`MAX_ALERTS_PER_USER`) counts ACTIVE + DISABLED and is checked inside the same
 *    critical section as the insert, so concurrent creates cannot bypass it,
 *  - an identical active/disabled alert is rejected as a duplicate (§38).
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: AlertStore,
    private readonly marketState: MarketStateService,
    private readonly users: UserStore,
    private readonly capacity: AlertCapacityService,
  ) {}

  /**
   * Configured base capacity — **not** the effective limit any more.
   *
   * Phase 7 adds permanent referral bonuses on top of this number. Everything that displays or
   * enforces capacity must use {@link effectiveMaxAlerts} instead; this getter is kept because the
   * effective limit is documented and shown relative to the configured base (§8.3).
   */
  get maxAlerts(): number {
    return this.config.maxAlertsPerUser;
  }

  /**
   * Capacity actually in force for one user: the configured base plus the permanent bonuses of the
   * rewards that were applied (derived from the ledger on every read — no second counter).
   */
  effectiveMaxAlerts(userId: string): number {
    return this.capacity.effectiveLimit(userId).limit;
  }

  // --- validation -------------------------------------------------------------

  isSupportedSymbol(symbol: string): boolean {
    return this.definitionFor(symbol) !== null;
  }

  definitionFor(symbol: string): SymbolDefinition | null {
    return (
      this.config.symbolRegistry.find(
        (definition) => definition.symbol === symbol,
      ) ?? null
    );
  }

  /**
   * Market snapshot of a symbol: the alert layer never reads anything else. `usable` follows the
   * Phase 1 freshness semantics and additionally requires a positive finite value, so neither a
   * stale state nor a corrupt number can become a baseline (§51).
   */
  priceSnapshot(symbol: string): SymbolPriceSnapshot | null {
    const definition = this.definitionFor(symbol);

    if (!definition) {
      return null;
    }

    const state = this.marketState.getState(definition);
    const price = state?.currentPrice ?? null;
    const usable =
      state !== null &&
      state.freshness === 'FRESH' &&
      price !== null &&
      Number.isFinite(price) &&
      price > 0;

    return {
      symbol: definition.symbol,
      label: definition.label,
      definition,
      price,
      usable,
    };
  }

  /** Snapshot of every registry symbol — used by the symbol picker (supported symbols only). */
  listSymbolSnapshots(): SymbolPriceSnapshot[] {
    return this.config.symbolRegistry.map((definition) => {
      const snapshot = this.priceSnapshot(definition.symbol);

      // `definitionFor` resolved above, so the snapshot always exists.
      return (
        snapshot ?? {
          symbol: definition.symbol,
          label: definition.label,
          definition,
          price: null,
          usable: false,
        }
      );
    });
  }

  /**
   * Is this condition already true right now? Used only to warn the user before confirming
   * (§14) — the alert itself never fires just because the condition was already met, because
   * absolute alerts require a crossing.
   */
  isConditionAlreadyMet(input: AlertTargetInput): boolean {
    if (isPercentAlert(input.type)) {
      // A percentage alert measures change from *now*: it is never "already met" at creation.
      return false;
    }

    const snapshot = this.priceSnapshot(input.symbol);
    const target = input.targetPrice ?? null;

    if (!snapshot || snapshot.price === null || target === null) {
      return false;
    }

    return input.type === 'PRICE_ABOVE'
      ? snapshot.price >= target
      : snapshot.price <= target;
  }

  /**
   * Early validation for the wizard: lets the bot refuse a bad number *before* the confirmation
   * screen instead of failing after the user already confirmed. The authoritative check still
   * happens inside `create`/`edit`.
   */
  checkTarget(
    input: AlertTargetInput,
  ): { ok: true } | { ok: false; reason: AlertMutationFailure } {
    const validated = this.validateInput(input);

    if ('reason' in validated) {
      this.logger.warn(
        `Rejected alert target for ${input.symbol}: ${validated.reason}.`,
      );
      return { ok: false, reason: validated.reason };
    }

    if (validated.baselineFailure) {
      return { ok: false, reason: validated.baselineFailure };
    }

    return { ok: true };
  }

  /** Latest price usable as a baseline (fresh, positive), or `null`. */
  latestUsablePrice(symbol: string): number | null {
    return this.requireUsablePrice(symbol);
  }

  // --- reads ------------------------------------------------------------------

  /** Alerts of exactly one user (soft-deleted ones are excluded). */
  listForUser(userId: string): Alert[] {
    return this.store
      .listAlertsByUser(userId)
      .filter((alert) => alert.status !== 'DELETED')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Number of alerts consuming capacity (ACTIVE + DISABLED). */
  countForCapacity(userId: string): number {
    return this.store
      .listAlertsByUser(userId)
      .filter((alert) => countsTowardsCapacity(alert.status)).length;
  }

  /**
   * Owned alert lookup. A foreign alert id is reported exactly like a missing one, so the caller
   * can never learn that another user's alert exists (§19, §68).
   */
  findForUser(userId: string, alertId: string): Alert | null {
    const alert = this.store.findAlert(alertId);

    if (!alert || alert.userId !== userId || alert.status === 'DELETED') {
      return null;
    }

    return alert;
  }

  /** Raw lookup used by the engine (already scoped by symbol + ACTIVE inside the store). */
  listActiveForSymbol(symbol: string): Alert[] {
    return this.store.listActiveBySymbol(symbol);
  }

  // --- mutations --------------------------------------------------------------

  async create(
    userId: string,
    input: AlertTargetInput,
  ): Promise<AlertMutationResult<Alert>> {
    const user = this.users.findUser(userId);

    if (!user) {
      return { ok: false, reason: 'USER_NOT_FOUND' };
    }

    const validated = this.validateInput(input);

    if ('reason' in validated) {
      return { ok: false, reason: validated.reason };
    }

    if (validated.baselineFailure) {
      return { ok: false, reason: validated.baselineFailure };
    }

    const { definition, targetPrice, targetPercent, direction, baselinePrice } =
      validated;

    // Read *inside* the same call, right before the critical section: the referral ledger can only
    // raise this number, so a grant racing with a create can at worst reject a create that would have
    // been accepted a moment later — never accept more alerts than the effective capacity allows.
    const limit = this.effectiveMaxAlerts(userId);
    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      if (tx.countForCapacity(userId) >= limit) {
        return { ok: false as const, reason: 'LIMIT_REACHED' as const, limit };
      }

      const duplicate = tx.listAlertsByUser(userId).some(
        (alert) =>
          countsTowardsCapacity(alert.status) &&
          this.isSameTarget(alert, {
            symbol: definition.symbol,
            type: validated.type,
            targetPrice,
            targetPercent,
            direction,
          }),
      );

      if (duplicate) {
        return { ok: false as const, reason: 'DUPLICATE' as const };
      }

      const alert: Alert = {
        id: this.nextId('alr'),
        userId,
        platform: user.platform,
        symbol: definition.symbol,
        type: validated.type,
        status: 'ACTIVE',
        targetPrice,
        targetPercent,
        direction,
        baselinePrice,
        createdAt: now,
        updatedAt: now,
        triggeredAt: null,
        disabledAt: null,
        deletedAt: null,
      };

      tx.saveAlert(alert);

      return { ok: true as const, alert };
    });
  }

  /** Enable a DISABLED alert (§16). A percentage alert restarts from the current valid price. */
  async enable(
    userId: string,
    alertId: string,
  ): Promise<AlertMutationResult<Alert>> {
    const validated = this.ownedAlert(userId, alertId);

    if ('reason' in validated) {
      return { ok: false, reason: validated.reason };
    }

    const { alert } = validated;

    if (alert.status === 'ACTIVE') {
      // Idempotent: pressing enable twice is not an error.
      return { ok: true, alert };
    }

    if (alert.status !== 'DISABLED') {
      // A triggered one-shot alert never becomes active again (§10, §40).
      return { ok: false, reason: 'INVALID_STATE' };
    }

    let baselinePrice = alert.baselinePrice;

    if (isPercentAlert(alert.type)) {
      baselinePrice = this.requireUsablePrice(alert.symbol);

      if (baselinePrice === null) {
        return { ok: false, reason: 'NO_VALID_PRICE' };
      }
    }

    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const stored = tx.findAlert(alertId);

      if (!stored || stored.userId !== userId || stored.status !== 'DISABLED') {
        return { ok: false as const, reason: 'INVALID_STATE' as const };
      }

      const updated: Alert = {
        ...stored,
        status: 'ACTIVE',
        baselinePrice,
        disabledAt: null,
        updatedAt: now,
      };

      tx.saveAlert(updated);

      return { ok: true as const, alert: updated };
    });
  }

  /** Disable an ACTIVE alert (§15). */
  async disable(
    userId: string,
    alertId: string,
  ): Promise<AlertMutationResult<Alert>> {
    const validated = this.ownedAlert(userId, alertId);

    if ('reason' in validated) {
      return { ok: false, reason: validated.reason };
    }

    const { alert } = validated;

    if (alert.status === 'DISABLED') {
      return { ok: true, alert };
    }

    if (alert.status !== 'ACTIVE') {
      return { ok: false, reason: 'INVALID_STATE' };
    }

    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const stored = tx.findAlert(alertId);

      if (!stored || stored.userId !== userId || stored.status !== 'ACTIVE') {
        return { ok: false as const, reason: 'INVALID_STATE' as const };
      }

      const updated: Alert = {
        ...stored,
        status: 'DISABLED',
        disabledAt: now,
        updatedAt: now,
      };

      tx.saveAlert(updated);

      return { ok: true as const, alert: updated };
    });
  }

  /**
   * Edit the target of an alert atomically (§17). The symbol and type stay fixed (changing them
   * means "create another alert"), the status is preserved, and a percentage alert always takes
   * a fresh baseline so the new condition starts from an explicit point in time.
   */
  async edit(
    userId: string,
    alertId: string,
    input: { targetPrice?: number | null; targetPercent?: number | null },
  ): Promise<AlertMutationResult<Alert>> {
    const validated = this.ownedAlert(userId, alertId);

    if ('reason' in validated) {
      return { ok: false, reason: validated.reason };
    }

    const { alert } = validated;

    if (alert.status === 'TRIGGERED') {
      return { ok: false, reason: 'INVALID_STATE' };
    }

    const definition = this.definitionFor(alert.symbol);

    if (!definition) {
      return { ok: false, reason: 'UNKNOWN_SYMBOL' };
    }

    let targetPrice = alert.targetPrice;
    let targetPercent = alert.targetPercent;
    let baselinePrice = alert.baselinePrice;

    if (isPercentAlert(alert.type)) {
      const percent = input.targetPercent;

      if (
        percent === undefined ||
        percent === null ||
        !this.isValidPercent(percent)
      ) {
        return { ok: false, reason: 'INVALID_TARGET' };
      }

      targetPercent = percent;
      baselinePrice = this.requireUsablePrice(alert.symbol);

      if (baselinePrice === null) {
        return { ok: false, reason: 'NO_VALID_PRICE' };
      }
    } else {
      const price = input.targetPrice;

      if (price === undefined || price === null) {
        return { ok: false, reason: 'INVALID_TARGET' };
      }

      if (!this.isValidTargetPrice(definition, price)) {
        return { ok: false, reason: 'INVALID_TARGET' };
      }

      targetPrice = price;
    }

    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const stored = tx.findAlert(alertId);

      if (
        !stored ||
        stored.userId !== userId ||
        stored.status === 'DELETED' ||
        stored.status === 'TRIGGERED'
      ) {
        return { ok: false as const, reason: 'INVALID_STATE' as const };
      }

      const duplicate = tx.listAlertsByUser(userId).some(
        (candidate) =>
          candidate.id !== alertId &&
          countsTowardsCapacity(candidate.status) &&
          this.isSameTarget(candidate, {
            symbol: stored.symbol,
            type: stored.type,
            targetPrice,
            targetPercent,
            direction: stored.direction,
          }),
      );

      if (duplicate) {
        return { ok: false as const, reason: 'DUPLICATE' as const };
      }

      const updated: Alert = {
        ...stored,
        targetPrice,
        targetPercent,
        baselinePrice,
        updatedAt: now,
      };

      tx.saveAlert(updated);

      return { ok: true as const, alert: updated };
    });
  }

  /** Soft delete (§18/§67): the row stays in the file, all queries and evaluations ignore it. */
  async remove(
    userId: string,
    alertId: string,
  ): Promise<AlertMutationResult<Alert>> {
    const validated = this.ownedAlert(userId, alertId);

    if ('reason' in validated) {
      return { ok: false, reason: validated.reason };
    }

    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const stored = tx.findAlert(alertId);

      if (!stored || stored.userId !== userId || stored.status === 'DELETED') {
        return { ok: false as const, reason: 'ALERT_NOT_FOUND' as const };
      }

      const updated: Alert = {
        ...stored,
        status: 'DELETED',
        deletedAt: now,
        updatedAt: now,
      };

      tx.saveAlert(updated);

      return { ok: true as const, alert: updated };
    });
  }

  // --- trigger & delivery state ----------------------------------------------

  /**
   * Reserve the (single) trigger of an alert and create its delivery record.
   *
   * Runs inside one critical section, so:
   *  - a second evaluation can no longer see an ACTIVE alert and can never create a second
   *    record (§43, §82),
   *  - a delete/disable that landed first makes the reservation fail, so no notification is sent
   *    for an alert the user already removed (§59, §60).
   */
  async reserveTrigger(
    alertId: string,
    reservation: TriggerReservation,
  ): Promise<AlertDelivery | null> {
    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const alert = tx.findAlert(alertId);

      if (!alert || alert.status !== 'ACTIVE') {
        return null;
      }

      if (tx.findDeliveryByAlert(alertId) !== null) {
        // The alert already has a trigger record: it must never fire twice.
        return null;
      }

      const delivery: AlertDelivery = {
        id: this.nextId('dlv'),
        alertId,
        userId: alert.userId,
        platform: alert.platform,
        chatId: reservation.chatId,
        reason: reservation.reason,
        status: 'PENDING',
        triggerPrice: reservation.price,
        triggerPercent: reservation.percent,
        triggeredAt: reservation.observedAt,
        attemptCount: 0,
        lastAttemptAt: null,
        sentAt: null,
        lastError: null,
        skippedReason: null,
      };

      tx.saveAlert({
        ...alert,
        status: 'TRIGGERED',
        triggeredAt: now,
        updatedAt: now,
      });
      tx.saveDelivery(delivery);

      return delivery;
    });
  }

  findDelivery(alertId: string): AlertDelivery | null {
    return this.store.findDeliveryByAlert(alertId);
  }

  listDeliveries(): AlertDelivery[] {
    return this.store.listDeliveries();
  }

  /** Marks the beginning of a send attempt *before* the platform call (attempt counting). */
  async beginAttempt(alertId: string): Promise<AlertDelivery | null> {
    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const delivery = tx.findDeliveryByAlert(alertId);

      if (!delivery || delivery.status !== 'PENDING') {
        return null;
      }

      const updated: AlertDelivery = {
        ...delivery,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: now,
      };

      tx.saveDelivery(updated);

      return updated;
    });
  }

  async markSent(alertId: string): Promise<AlertDelivery | null> {
    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const delivery = tx.findDeliveryByAlert(alertId);

      if (!delivery) {
        return null;
      }

      const updated: AlertDelivery = {
        ...delivery,
        status: 'SENT',
        sentAt: now,
        lastError: null,
      };

      tx.saveDelivery(updated);

      return updated;
    });
  }

  /** Record a failed attempt. Returns the updated record so the caller can decide to retry. */
  async recordFailure(
    alertId: string,
    error: string,
  ): Promise<AlertDelivery | null> {
    const now = new Date().toISOString();

    return this.store.transact((tx) => {
      const delivery = tx.findDeliveryByAlert(alertId);

      if (!delivery) {
        return null;
      }

      const updated: AlertDelivery = {
        ...delivery,
        lastError: error,
        lastAttemptAt: now,
      };

      tx.saveDelivery(updated);

      return updated;
    });
  }

  /** Terminal state when the notification is intentionally not sent or cannot be retried. */
  async markUndeliverable(
    alertId: string,
    skippedReason: AlertDelivery['skippedReason'],
    error: string | null,
  ): Promise<AlertDelivery | null> {
    return this.store.transact((tx) => {
      const delivery = tx.findDeliveryByAlert(alertId);

      if (!delivery) {
        return null;
      }

      const updated: AlertDelivery = {
        ...delivery,
        status: 'FAILED',
        skippedReason,
        lastError: error,
      };

      tx.saveDelivery(updated);

      return updated;
    });
  }

  // --- internals --------------------------------------------------------------

  private ownedAlert(
    userId: string,
    alertId: string,
  ): { alert: Alert } | { reason: 'ALERT_NOT_FOUND' | 'INVALID_STATE' } {
    const alert = this.findForUser(userId, alertId);

    if (!alert) {
      return { reason: 'ALERT_NOT_FOUND' };
    }

    return { alert };
  }

  private validateInput(input: AlertTargetInput):
    | {
        type: AlertType;
        definition: SymbolDefinition;
        targetPrice: number | null;
        targetPercent: number | null;
        direction: PercentDirection | null;
        /** Resolved baseline of a percentage alert (`null` for absolute alerts). */
        baselinePrice: number | null;
        baselineFailure?: 'NO_VALID_PRICE';
      }
    | { reason: 'UNKNOWN_SYMBOL' | 'INVALID_TYPE' | 'INVALID_TARGET' } {
    if (!isAlertType(input.type)) {
      return { reason: 'INVALID_TYPE' };
    }

    const definition = this.definitionFor(input.symbol);

    if (!definition) {
      return { reason: 'UNKNOWN_SYMBOL' };
    }

    if (isPercentAlert(input.type)) {
      const percent = input.targetPercent ?? null;

      if (percent === null || !this.isValidPercent(percent)) {
        return { reason: 'INVALID_TARGET' };
      }

      const direction: PercentDirection =
        input.type === 'PERCENT_INCREASE' ? 'UP' : 'DOWN';

      // The baseline is read here (not inside the critical section): it is a market input, and
      // an unavailable price must abort the creation with a clear reason (§8, §51).
      const baseline = this.requireUsablePrice(definition.symbol);

      return {
        type: input.type,
        definition,
        targetPrice: null,
        targetPercent: percent,
        direction,
        baselinePrice: baseline,
        ...(baseline === null
          ? { baselineFailure: 'NO_VALID_PRICE' as const }
          : {}),
      };
    }

    const price = input.targetPrice ?? null;

    if (price === null || !this.isValidTargetPrice(definition, price)) {
      return { reason: 'INVALID_TARGET' };
    }

    return {
      type: input.type,
      definition,
      targetPrice: price,
      targetPercent: null,
      direction: null,
      baselinePrice: null,
    };
  }

  private isValidTargetPrice(
    definition: SymbolDefinition,
    value: number,
  ): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return false;
    }

    // The accepted data range of the symbol (Phase 1 registry) doubles as the input bound: a
    // target outside it could never be crossed, because such a price would be rejected upstream.
    // A symbol without bounds (both null) accepts any positive finite value.
    if (definition.minPrice !== null && value < definition.minPrice) {
      return false;
    }

    return definition.maxPrice === null || value <= definition.maxPrice;
  }

  private isValidPercent(value: number): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return false;
    }

    return (
      value >= this.config.alertMinTargetPercent &&
      value <= this.config.alertMaxTargetPercent
    );
  }

  /** Latest price usable as a baseline: Phase 1 state must exist, be FRESH and positive. */
  private requireUsablePrice(symbol: string): number | null {
    const snapshot = this.priceSnapshot(symbol);

    if (!snapshot || !snapshot.usable || snapshot.price === null) {
      return null;
    }

    return snapshot.price;
  }

  private isSameTarget(
    alert: Alert,
    candidate: {
      symbol: string;
      type: AlertType;
      targetPrice: number | null;
      targetPercent: number | null;
      direction: PercentDirection | null;
    },
  ): boolean {
    return (
      alert.symbol === candidate.symbol &&
      alert.type === candidate.type &&
      alert.direction === candidate.direction &&
      alert.targetPrice === candidate.targetPrice &&
      alert.targetPercent === candidate.targetPercent
    );
  }

  private nextId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
}

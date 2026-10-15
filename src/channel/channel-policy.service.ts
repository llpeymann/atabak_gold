import { Injectable, Logger } from '@nestjs/common';

import { tehranDayKey } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import {
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
} from '../intelligence/market-intelligence.types';
import { PriceDirection } from '../market/market.types';
import { MessageType, SkipReason } from './channel.types';
import { PublicationStore, PublicationTransaction } from './publication.store';

/**
 * Phase 5 policies: what may be published, and when an event may repeat (§16–§18, §31-B/C).
 *
 * Everything here is a *decision function* over data that was already validated elsewhere:
 *  - the market gate uses the Phase 4 snapshot (which is itself a projection of Phase 1 state),
 *  - movement and range events use the same snapshot plus the persisted event state,
 *  - no market number is computed here — thresholds/cooldowns only *compare* existing values.
 */

/**
 * Fraction of the threshold a movement must fall back to before a new event may be emitted for the
 * same symbol in the same Tehran day (§17 "re-arm condition"). Documented, deterministic and
 * intentionally generous: half of the configured threshold.
 */
export const MOVEMENT_RE_ARM_FRACTION = 0.5;

export interface MarketGateResult {
  ok: boolean;
  reason: SkipReason | null;
  /** Symbols with usable (fresh or stale) validated data, in registry order. */
  usableSymbols: readonly string[];
  /** Symbols with *fresh* validated data. */
  freshSymbols: readonly string[];
}

export interface MovementCandidate {
  symbol: string;
  label: string;
  direction: PriceDirection;
  movement: number;
  movementPercent: number;
  thresholdPercent: number;
  currentPrice: number;
  previousPrice: number;
  lastUpdatedAt: string | null;
}

export interface RangeCandidate {
  symbol: string;
  label: string;
  kind: 'HIGH' | 'LOW';
  value: number;
  high: number | null;
  low: number | null;
  currentPrice: number | null;
  lastUpdatedAt: string | null;
}

@Injectable()
export class ChannelPolicyService {
  private readonly logger = new Logger(ChannelPolicyService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: PublicationStore,
  ) {}

  // --- market data gate (§16) --------------------------------------------------

  /**
   * Publishability of a market-derived message.
   *
   * `PRICE_UPDATE` is additionally gated by Phase 1 itself (`PublishableMarketUpdate.publishable`);
   * this gate exists for the types that are rendered from the Phase 4 snapshot and makes the
   * failure reasons explicit and traceable.
   */
  evaluateMarketGate(
    type: MessageType,
    snapshot: MarketIntelligenceSnapshot,
  ): MarketGateResult {
    const usable = snapshot.symbols.filter(
      (symbol) => symbol.availability !== 'UNAVAILABLE',
    );
    const fresh = usable.filter(
      (symbol) => symbol.availability === 'AVAILABLE',
    );
    const usableSymbols = usable.map((symbol) => symbol.symbol);
    const freshSymbols = fresh.map((symbol) => symbol.symbol);

    if (usable.length === 0) {
      return {
        ok: false,
        reason: 'INVALID_MARKET_SNAPSHOT',
        usableSymbols,
        freshSymbols,
      };
    }

    switch (type) {
      case 'PRICE_UPDATE':
        // Phase 1 decides publishability; here we only require that something exists at all.
        return { ok: true, reason: null, usableSymbols, freshSymbols };

      case 'DAILY_REPORT':
        // A report may be stale (it says so explicitly) but never empty.
        return { ok: true, reason: null, usableSymbols, freshSymbols };

      case 'DAILY_RANGE': {
        const withRange = usable.filter(
          (symbol) => symbol.high !== null && symbol.low !== null,
        );

        if (withRange.length === 0) {
          return {
            ok: false,
            reason: 'INVALID_DAILY_STATISTICS',
            usableSymbols,
            freshSymbols,
          };
        }

        return { ok: true, reason: null, usableSymbols, freshSymbols };
      }

      case 'MARKET_MOVEMENT': {
        const withMovement = usable.filter(
          (symbol) =>
            symbol.movement !== null &&
            symbol.movementPercent !== null &&
            symbol.availability === 'AVAILABLE',
        );

        if (withMovement.length === 0) {
          return {
            ok: false,
            reason: 'STALE_MARKET_DATA',
            usableSymbols,
            freshSymbols,
          };
        }

        return { ok: true, reason: null, usableSymbols, freshSymbols };
      }

      default:
        // Editorial types are gated by approval, not by market data (§19).
        return { ok: true, reason: null, usableSymbols, freshSymbols };
    }
  }

  // --- movement events (§17) ---------------------------------------------------

  /**
   * Per-symbol movement threshold. `null` means "movement publication is disabled" — either
   * globally (`CHANNEL_MOVEMENT_THRESHOLD_PERCENT=0`) or for that symbol through an override.
   * A missing threshold therefore never turns into an unrestricted publication policy.
   */
  movementThresholdFor(symbol: string): number | null {
    const overrides = this.config.channelMovementThresholdOverrides;

    if (Object.prototype.hasOwnProperty.call(overrides, symbol)) {
      const override = overrides[symbol];

      return override > 0 ? override : null;
    }

    const fallback = this.config.channelMovementThresholdPercent;

    return fallback > 0 ? fallback : null;
  }

  get movementsEnabled(): boolean {
    return this.config.channelMovementThresholdPercent > 0;
  }

  /**
   * Movements that qualify for a publication *right now* (§17):
   * fresh validated data only, above the per-symbol threshold, outside the cooldown and re-armed.
   */
  selectMovementCandidates(
    snapshot: MarketIntelligenceSnapshot,
    now: Date,
  ): MovementCandidate[] {
    if (!this.movementsEnabled) {
      return [];
    }

    const dayKey = tehranDayKey(now);
    const cooldownMs = this.config.channelMovementCooldownMinutes * 60_000;
    const candidates: MovementCandidate[] = [];

    for (const symbol of snapshot.symbols) {
      // Rejected, missing or stale data can never produce an event (§16, §17).
      if (symbol.availability !== 'AVAILABLE') {
        continue;
      }

      const threshold = this.movementThresholdFor(symbol.symbol);

      if (threshold === null) {
        continue;
      }

      const { movement, movementPercent } = symbol;

      if (
        movement === null ||
        movementPercent === null ||
        symbol.movementDirection === 'UNKNOWN' ||
        symbol.movementDirection === 'UNCHANGED' ||
        movement === 0
      ) {
        continue;
      }

      if (Math.abs(movementPercent) < threshold) {
        continue;
      }

      const state = this.store.getMovementEvent(symbol.symbol, dayKey);

      if (state) {
        const elapsed = now.getTime() - Date.parse(state.lastPublishedAt);

        // Cooldown first: repeated samples above the threshold must not create a message each time.
        if (!Number.isFinite(elapsed) || elapsed < cooldownMs || !state.armed) {
          continue;
        }
      }

      candidates.push({
        symbol: symbol.symbol,
        label: symbol.label,
        direction: symbol.movementDirection,
        movement,
        movementPercent,
        thresholdPercent: threshold,
        currentPrice: symbol.currentPrice ?? 0,
        previousPrice: symbol.previousPrice ?? 0,
        lastUpdatedAt: symbol.lastUpdatedAt,
      });
    }

    return candidates;
  }

  /**
   * Advance the re-arm flags: a symbol whose movement has fallen back below half of its threshold
   * becomes eligible for a *new* event once the cooldown has passed.
   */
  async updateMovementReArm(
    snapshot: MarketIntelligenceSnapshot,
    now: Date,
  ): Promise<void> {
    if (!this.movementsEnabled) {
      return;
    }

    const dayKey = tehranDayKey(now);

    await this.store.transact((tx) => {
      for (const symbol of snapshot.symbols) {
        const state = tx.getMovementEvent(symbol.symbol, dayKey);

        if (!state || state.armed) {
          continue;
        }

        const threshold = this.movementThresholdFor(symbol.symbol);

        if (threshold === null) {
          continue;
        }

        const magnitude =
          symbol.movementPercent === null
            ? 0
            : Math.abs(symbol.movementPercent);

        if (magnitude < threshold * MOVEMENT_RE_ARM_FRACTION) {
          tx.saveMovementEvent({ ...state, armed: true });
        }
      }
    });
  }

  /** Record a published movement event (called only after a confirmed delivery, §17). */
  async recordMovementEvent(
    candidate: MovementCandidate,
    now: Date,
  ): Promise<void> {
    const dayKey = tehranDayKey(now);

    await this.store.transact((tx) => {
      tx.saveMovementEvent({
        symbol: candidate.symbol,
        dayKey,
        lastPublishedAt: now.toISOString(),
        lastDirection: candidate.direction,
        // Re-arm only after the movement has fallen back below the re-arm level.
        armed: false,
      });
    });
  }

  /** Drop event state that belongs to an older Tehran day (called once per market cycle). */
  async prunePreviousDays(now: Date): Promise<void> {
    const dayKey = tehranDayKey(now);

    await this.store.transact((tx) => {
      for (const state of tx.listMovementEvents()) {
        if (state.dayKey !== dayKey) {
          tx.saveMovementEvent({ ...state, armed: true });
        }
      }
    });
  }

  // --- daily range events (§18) ------------------------------------------------

  get rangeEventsEnabled(): boolean {
    return (
      this.config.channelDailyRangeEnabled &&
      this.config.channelDailyRangeEventsEnabled
    );
  }

  /**
   * New daily extremes since the last published/extreme state.
   *
   * The very first observation of a Tehran day only records the baseline (the first accepted price
   * of the day *is* the high and the low, which is not news). After that, a genuinely new high or
   * low is an event, subject to the configured cooldown.
   */
  selectRangeCandidates(
    snapshot: MarketIntelligenceSnapshot,
    now: Date,
  ): RangeCandidate[] {
    if (!this.rangeEventsEnabled) {
      return [];
    }

    const dayKey = tehranDayKey(now);
    const cooldownMs = this.config.channelDailyRangeCooldownMinutes * 60_000;
    const candidates: RangeCandidate[] = [];

    for (const symbol of snapshot.symbols) {
      if (symbol.availability !== 'AVAILABLE') {
        continue;
      }

      if (symbol.high === null || symbol.low === null) {
        continue;
      }

      const state = this.store.getRangeEvent(symbol.symbol, dayKey);

      if (!state) {
        // Baseline for today: recorded by `recordRangeBaseline`, never published as an event.
        continue;
      }

      const newHigh = state.high === null || symbol.high > state.high;
      const newLow = state.low === null || symbol.low < state.low;

      if (!newHigh && !newLow) {
        continue;
      }

      if (state.lastPublishedAt !== null) {
        const elapsed = now.getTime() - Date.parse(state.lastPublishedAt);

        if (Number.isFinite(elapsed) && elapsed < cooldownMs) {
          continue;
        }
      }

      candidates.push({
        symbol: symbol.symbol,
        label: symbol.label,
        // A cycle that made both extremes is reported as a new high first (deterministic).
        kind: newHigh ? 'HIGH' : 'LOW',
        value: newHigh ? symbol.high : symbol.low,
        high: symbol.high,
        low: symbol.low,
        currentPrice: symbol.currentPrice,
        lastUpdatedAt: symbol.lastUpdatedAt,
      });
    }

    return candidates;
  }

  /** Record today's baseline extremes for symbols that have no event state yet. */
  async recordRangeBaseline(
    snapshot: MarketIntelligenceSnapshot,
    now: Date,
  ): Promise<void> {
    if (!this.rangeEventsEnabled) {
      return;
    }

    const dayKey = tehranDayKey(now);

    await this.store.transact((tx) => {
      for (const symbol of snapshot.symbols) {
        if (
          symbol.availability !== 'AVAILABLE' ||
          symbol.high === null ||
          symbol.low === null
        ) {
          continue;
        }

        if (tx.getRangeEvent(symbol.symbol, dayKey)) {
          continue;
        }

        tx.saveRangeEvent({
          symbol: symbol.symbol,
          dayKey,
          lastEvent: 'HIGH',
          // Baseline only: no event was published, so no cooldown starts here.
          lastPublishedAt: null,
          high: symbol.high,
          low: symbol.low,
        });
      }
    });
  }

  /** Record published range events (advances the extremes, so they cannot repeat, §18). */
  async recordRangeEvents(
    candidates: readonly RangeCandidate[],
    now: Date,
  ): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    const dayKey = tehranDayKey(now);

    await this.store.transact((tx) => {
      for (const candidate of candidates) {
        tx.saveRangeEvent({
          symbol: candidate.symbol,
          dayKey,
          lastEvent: candidate.kind,
          lastPublishedAt: now.toISOString(),
          high: candidate.high,
          low: candidate.low,
        });
      }
    });
  }

  // --- helpers -----------------------------------------------------------------

  /** Freshness/availability of one symbol, for the report labels (§5.4). */
  static describeAvailability(symbol: MarketSymbolSnapshot): string {
    switch (symbol.availability) {
      case 'AVAILABLE':
        return 'تازه';
      case 'STALE':
        return 'کهنه';
      default:
        return 'بدون داده معتبر';
    }
  }

  /** Log the effective movement policy once at startup so operators can see it (§21). */
  describeMovementPolicy(): string {
    if (!this.movementsEnabled) {
      return 'movement publication DISABLED (CHANNEL_MOVEMENT_THRESHOLD_PERCENT=0)';
    }

    const overrides = Object.entries(
      this.config.channelMovementThresholdOverrides,
    ).map(([symbol, value]) => `${symbol}=${value}%`);

    return (
      `movement threshold ${this.config.channelMovementThresholdPercent}%` +
      (overrides.length > 0 ? ` (overrides: ${overrides.join(', ')})` : '') +
      `, cooldown ${this.config.channelMovementCooldownMinutes}min, ` +
      `re-arm at ${MOVEMENT_RE_ARM_FRACTION * 100}% of the threshold`
    );
  }

  /** Everything the publication transaction needs, for tests and diagnostics. */
  static describeEventState(tx: PublicationTransaction): string {
    const movements = tx.listMovementEvents();
    const ranges = tx.listRangeEvents();

    return `movement events=${movements.length}, range events=${ranges.length}`;
  }

  logPolicy(): void {
    this.logger.log(`Movement policy: ${this.describeMovementPolicy()}`);
    this.logger.log(
      `Daily range: ${this.config.channelDailyRangeEnabled ? 'enabled' : 'disabled'}` +
        ` (events ${this.config.channelDailyRangeEventsEnabled ? 'on' : 'off'}` +
        `, cooldown ${this.config.channelDailyRangeCooldownMinutes}min) | ` +
        `Daily report: ${this.config.channelDailyReportEnabled ? 'enabled' : 'disabled'}`,
    );
  }
}

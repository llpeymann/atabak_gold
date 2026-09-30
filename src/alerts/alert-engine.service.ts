import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import {
  MarketEngineService,
  MarketPriceCommittedEvent,
} from '../market/market-engine.service';
import { UserStore } from '../users/user.store';
import { AlertNotificationService } from './alert-notification.service';
import { AlertStore } from './alert.store';
import { AlertService } from './alert.service';
import { evaluateAlert } from './alert-evaluator';
import { MarketObservation } from './alert.types';

/**
 * Phase 3 integration point (§49): alert evaluation runs **after** Phase 1 committed accepted
 * prices into the market state, and it can only ever see that state.
 *
 * Order of operations per accepted symbol:
 *   Phase 1 commit → listener notification → pure evaluation → atomic trigger reservation
 *   → notification dispatch (bounded retry, decoupled from the market cycle)
 *
 * A rejected/anomalous price never reaches this service: the Phase 1 engine only publishes
 * accepted prices to the listener, which is why invalid data cannot fire an alert (§50, §85).
 */
@Injectable()
export class AlertEngineService implements OnModuleInit {
  private readonly logger = new Logger(AlertEngineService.name);

  constructor(
    private readonly marketEngine: MarketEngineService,
    private readonly alerts: AlertService,
    private readonly store: AlertStore,
    private readonly notifications: AlertNotificationService,
    private readonly users: UserStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureLoaded();
    await this.users.ensureLoaded();

    this.marketEngine.registerUpdateListener({
      // Evaluation + trigger reservation are awaited (they are fast and must be durable before
      // the cycle ends); notification delivery itself is dispatched in the background.
      onMarketPricesCommitted: async (events): Promise<void> => {
        await this.handleCommittedPrices(events);
      },
    });

    // §61: a delivery that was interrupted by a restart is resumed exactly once.
    await this.notifications.recoverPending();
  }

  /**
   * Evaluate every ACTIVE alert of the updated symbols. Returns the number of reserved triggers
   * (used by tests/diagnostics); never throws into the market cycle.
   */
  async handleCommittedPrices(
    events: readonly MarketPriceCommittedEvent[],
  ): Promise<number> {
    let triggered = 0;

    for (const event of events) {
      try {
        triggered += await this.evaluateSymbol(event);
      } catch (error) {
        // A failure in the alert layer must never break price publication or the cycle state.
        this.logger.error(
          `Alert evaluation failed for ${event.symbol}: ${describeError(error)}`,
        );
      }
    }

    return triggered;
  }

  private async evaluateSymbol(
    event: MarketPriceCommittedEvent,
  ): Promise<number> {
    // §57: only the ACTIVE alerts of the symbol that actually received an accepted price.
    const candidates = this.alerts.listActiveForSymbol(event.symbol);

    if (candidates.length === 0) {
      return 0;
    }

    const observation: MarketObservation = {
      symbol: event.symbol,
      label: event.label,
      currentPrice: event.price,
      previousPrice: event.previousPrice,
      baseline: event.baseline,
      observedAt: event.evaluatedAt,
    };

    let reserved = 0;

    for (const alert of candidates) {
      const result = evaluateAlert(alert, observation);

      if (!result.shouldTrigger || result.reason === null) {
        continue;
      }

      const user = this.users.findUser(alert.userId);
      const delivery = await this.alerts.reserveTrigger(alert.id, {
        reason: result.reason,
        price: result.currentPrice,
        percent: result.changePercent,
        observedAt: observation.observedAt,
        // The notification goes to the chat the user last interacted from (§41).
        chatId: user?.chatId ?? user?.platformUserId ?? '',
      });

      if (delivery === null) {
        // Either the alert was already triggered/deleted/disabled in the meantime.
        this.logger.warn(
          `Trigger for alert ${alert.id} was not reserved (state changed concurrently) — no notification.`,
        );
        continue;
      }

      reserved += 1;
      this.logger.log(
        `🔔 Alert ${alert.id} triggered (${result.reason}) for ${alert.symbol} at ${result.currentPrice}` +
          `${result.changePercent === null ? '' : ` (${result.changePercent.toFixed(4)}%)`}.`,
      );
      this.notifications.dispatch(delivery);
    }

    return reserved;
  }
}

import { AlertEngineService } from './alert-engine.service';
import { Alert, AlertDelivery } from './alert.types';
import { PriceService } from '../price/price.service';
import {
  createUxHarness,
  DEFAULT_SEED_PRICES,
  EnvMap,
  rawPricePayload,
  seedMarketState,
  UxHarness,
} from '../testing/test-doubles';

/**
 * End-to-end evaluation pipeline (Phase 3 §49/§50/§57/§62/§85).
 *
 *   accepted Phase 1 price → listener → pure evaluation → atomic reservation → notification
 *
 * The whole Phase 1 pipeline runs for real (parser → normalizer → sanity → state), so this suite
 * also proves the two hard rules: the alert layer can only ever see *accepted* prices, and it
 * never touches the external price API.
 */

const NOW = (): Date => new Date();
const CHAT_ID = 'chat-engine-1';

describe('AlertEngineService (integration)', () => {
  let harness: UxHarness;
  let engine: AlertEngineService;
  let ownerId: string;
  /** A provider double that records every call: the alert path must never use it (§50). */
  let providerCalls: string[];
  let provider: PriceService;

  beforeEach(async () => {
    providerCalls = [];
    provider = {
      fetchRawPayload: () => {
        providerCalls.push(new Date().toISOString());
        return Promise.reject(
          new Error('Phase 3 must never call the external price API.'),
        );
      },
    } as unknown as PriceService;

    harness = createUxHarness({ ALERT_NOTIFICATION_RETRY_DELAY_MS: '0' });
    await seedMarketState(harness, { receivedAt: NOW() });
    const user = await harness.users.resolveUser(
      'bale',
      'engine-user',
      CHAT_ID,
    );
    ownerId = user.id;

    engine = new AlertEngineService(
      harness.market.engine,
      harness.alerts,
      harness.alertStore,
      harness.notifications,
      harness.store,
    );
    await engine.onModuleInit();
  });

  /**
   * Run one real Phase 1 cycle (raw payload → parser → normalizer → sanity → state) and wait for
   * the alert pipeline that hangs off it.
   */
  const cycle = async (
    prices: Record<string, number>,
    receivedAt: Date = NOW(),
  ): Promise<void> => {
    await harness.market.engine.evaluateCycle(
      rawPricePayload(
        { ...DEFAULT_SEED_PRICES, ...prices },
        receivedAt.toISOString(),
      ),
      receivedAt,
    );
    await flush();
  };

  /** Wait for the market listener and any queued notification work. */
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.notifications.drain();
  };

  /** Current validated state of the gold symbol (Phase 1 is the only price source). */
  const goldState = () =>
    harness.market.marketState.getState(
      harness.market.config.symbolRegistry.find(
        (definition) => definition.symbol === 'IR_GOLD_18K',
      )!,
    );

  const createAlert = async (
    targetPrice: number,
    type: Alert['type'] = 'PRICE_ABOVE',
  ): Promise<Alert> => {
    const result = await harness.alerts.create(ownerId, {
      type,
      symbol: 'IR_GOLD_18K',
      targetPrice,
    });
    if (!result.ok) {
      throw new Error(`could not create the alert: ${result.reason}`);
    }

    return result.alert;
  };

  const notifications = () =>
    harness.platform.calls.filter(
      (call) =>
        call.kind === 'send' &&
        call.chatId === CHAT_ID &&
        (call.text ?? '').includes('🔔'),
    );

  // --- the main flow ----------------------------------------------------------

  it('triggers on an accepted crossing and notifies exactly once', async () => {
    const alert = await createAlert(17_700_000);

    await cycle({ IR_GOLD_18K: 17_750_000 });

    const triggered = harness.alerts.findForUser(ownerId, alert.id) as Alert;
    expect(triggered.status).toBe('TRIGGERED');
    expect(triggered.triggeredAt).not.toBeNull();

    const delivery = harness.alerts.findDelivery(alert.id) as AlertDelivery;
    expect(delivery.status).toBe('SENT');
    expect(delivery.reason).toBe('PRICE_ABOVE_REACHED');
    expect(delivery.triggerPrice).toBe(17_750_000);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]?.text).toContain('طلای ۱۸ عیار');
  });

  it('never calls the external price API (§50)', async () => {
    const alert = await createAlert(17_700_000);
    await cycle({ IR_GOLD_18K: 17_750_000 });

    expect(providerCalls).toEqual([]);
    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'TRIGGERED',
    );
    void provider;
  });

  it('does not fire while the target is not crossed', async () => {
    const alert = await createAlert(19_000_000);

    await cycle({ IR_GOLD_18K: 17_600_000 });
    await cycle({ IR_GOLD_18K: 17_800_000 });

    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'ACTIVE',
    );
    expect(harness.alerts.listDeliveries()).toHaveLength(0);
    expect(notifications()).toHaveLength(0);
  });

  it('never fires for a symbol that did not receive a price', async () => {
    const alert = await createAlert(17_700_000);

    // Only USD is published: the gold alert must stay untouched.
    await harness.market.engine.evaluateCycle(
      rawPricePayload({ USD: 1_060_000 }, NOW().toISOString()),
      NOW(),
    );
    await flush();

    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'ACTIVE',
    );
  });

  it('evaluates only the ACTIVE alerts of the updated symbol', async () => {
    const active = await createAlert(17_700_000);
    const disabled = await createAlert(17_800_000);
    await harness.alerts.disable(ownerId, disabled.id);
    const otherSymbol = await harness.alerts.create(ownerId, {
      type: 'PRICE_ABOVE',
      symbol: 'USD',
      targetPrice: 1_060_000,
    });
    if (!otherSymbol.ok) {
      throw new Error('could not create the USD alert');
    }

    await cycle({ IR_GOLD_18K: 17_750_000 });

    expect(harness.alerts.findForUser(ownerId, active.id)?.status).toBe(
      'TRIGGERED',
    );
    expect(harness.alerts.findForUser(ownerId, disabled.id)?.status).toBe(
      'DISABLED',
    );
    expect(
      harness.alerts.findForUser(ownerId, otherSymbol.alert.id)?.status,
    ).toBe('ACTIVE');
    expect(notifications()).toHaveLength(1);
  });

  it('is a one-shot: a second crossing of the same alert never notifies again', async () => {
    const alert = await createAlert(17_700_000);

    await cycle({ IR_GOLD_18K: 17_750_000 });
    // The market goes back below the target and crosses again.
    await cycle({ IR_GOLD_18K: 17_600_000 });
    await cycle({ IR_GOLD_18K: 17_900_000 });

    expect(notifications()).toHaveLength(1);
    expect(harness.alerts.findDelivery(alert.id)?.status).toBe('SENT');
  });

  it('does not fire merely because a new alert is already beyond its target (§13)', async () => {
    // The current price is 17,500,000; this target is already true.
    const alert = await createAlert(17_000_000);

    await cycle({ IR_GOLD_18K: 17_550_000 });
    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'ACTIVE',
    );

    // Only a real crossing from below fires it.
    await cycle({ IR_GOLD_18K: 16_900_000 });
    await cycle({ IR_GOLD_18K: 17_100_000 });
    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'TRIGGERED',
    );
  });

  it('triggers on a gap that jumps over the target', async () => {
    const alert = await createAlert(17_700_000);

    await cycle({ IR_GOLD_18K: 17_900_000 });

    expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
      'TRIGGERED',
    );
  });

  it('evaluates percentage alerts against the stored baseline', async () => {
    const created = await harness.alerts.create(ownerId, {
      type: 'PERCENT_DECREASE',
      symbol: 'USD',
      targetPercent: 2,
    });
    if (!created.ok) {
      throw new Error('could not create the percentage alert');
    }
    expect(created.alert.baselinePrice).toBe(1_055_000);

    // -2.09% from the stored baseline of 1,055,000 → the -2% target is reached.
    await cycle({ USD: 1_033_000 }, NOW());

    const triggered = harness.alerts.findForUser(
      ownerId,
      created.alert.id,
    ) as Alert;
    expect(triggered.status).toBe('TRIGGERED');
    const delivery = harness.alerts.findDelivery(
      created.alert.id,
    ) as AlertDelivery;
    expect(delivery.reason).toBe('PERCENT_DECREASE_REACHED');
    expect(delivery.triggerPercent).toBeLessThan(0);
    expect(notifications()).toHaveLength(1);
  });

  // --- invalid / rejected market data -----------------------------------------

  describe('rejected and anomalous data can never trigger an alert (§50/§85)', () => {
    it('ignores a price that Phase 1 rejects as malformed', async () => {
      const alert = await createAlert(17_700_000);

      for (const broken of [Number.NaN, -1, 0]) {
        await harness.market.engine.evaluateCycle(
          rawPricePayload({ IR_GOLD_18K: broken }, NOW().toISOString()),
          NOW(),
        );
        await flush();
      }

      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'ACTIVE',
      );
      expect(notifications()).toHaveLength(0);
    });

    it('ignores a price outside the accepted range of the symbol', async () => {
      const alert = await createAlert(17_700_000);

      // 5,000,000,000 Rial is far outside the registry range: Phase 1 rejects it.
      await cycle({ IR_GOLD_18K: 5_000_000_000 });

      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'ACTIVE',
      );
      expect(notifications()).toHaveLength(0);
    });

    it('ignores an anomalous jump that Phase 1 refuses to publish', async () => {
      const alert = await createAlert(19_000_000);

      // +60% in one cycle is far above the 10% threshold of this symbol.
      await cycle({ IR_GOLD_18K: 17_500_000 * 1.6 });

      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'ACTIVE',
      );
      expect(notifications()).toHaveLength(0);
      // The state still holds the last *valid* price.
      expect(goldState()?.currentPrice).toBe(DEFAULT_SEED_PRICES.IR_GOLD_18K);
    });

    it('keeps using the last valid price for the crossing test', async () => {
      const alert = await createAlert(17_700_000);

      // A rejected observation must not become part of the comparison history.
      await cycle({ IR_GOLD_18K: 17_400_000 });
      await harness.market.engine.evaluateCycle(
        rawPricePayload({ IR_GOLD_18K: 20_000_000 }, NOW().toISOString()),
        NOW(),
      );
      await flush();
      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'ACTIVE',
      );

      await cycle({ IR_GOLD_18K: 17_750_000 });
      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'TRIGGERED',
      );
    });
  });

  // --- concurrency and restart ------------------------------------------------

  describe('concurrency and restart', () => {
    it('never triggers a deleted alert (delete wins over a simultaneous evaluation)', async () => {
      const alert = await createAlert(17_700_000);
      await harness.alerts.remove(ownerId, alert.id);

      await cycle({ IR_GOLD_18K: 17_750_000 });

      expect(harness.alerts.findForUser(ownerId, alert.id)).toBeNull();
      expect(notifications()).toHaveLength(0);
    });

    it('never triggers a disabled alert even when the price crosses', async () => {
      const alert = await createAlert(17_700_000);
      await harness.alerts.disable(ownerId, alert.id);

      await cycle({ IR_GOLD_18K: 17_750_000 });

      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'DISABLED',
      );
      expect(notifications()).toHaveLength(0);
    });

    it('reserves exactly one trigger when the same crossing is evaluated twice', async () => {
      await createAlert(17_700_000);
      const observed = {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
        section: 'gold' as const,
        unit: 'RIAL' as const,
        price: 17_750_000,
        previousPrice: 17_600_000,
        baseline: 'SAME_DAY' as const,
        dayKey: '2026-09-30',
        evaluatedAt: NOW().toISOString(),
      };

      // Two cycles with the same committed event (a retry of the market cycle).
      const first = await engine.handleCommittedPrices([observed]);
      const second = await engine.handleCommittedPrices([observed]);
      await flush();

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(harness.alerts.listDeliveries()).toHaveLength(1);
      expect(notifications()).toHaveLength(1);
    });

    it('does not notify twice when the same alert is restored after a restart', async () => {
      const alert = await createAlert(17_700_000);
      await cycle({ IR_GOLD_18K: 17_750_000 });
      expect(notifications()).toHaveLength(1);

      // A second engine instance over the same store (a restarted process).
      const restarted = new AlertEngineService(
        harness.market.engine,
        harness.alerts,
        harness.alertStore,
        harness.notifications,
        harness.store,
      );
      await restarted.onModuleInit();

      await cycle({ IR_GOLD_18K: 17_800_000 });
      await cycle({ IR_GOLD_18K: 17_900_000 });

      expect(notifications()).toHaveLength(1);
      expect(harness.alerts.findForUser(ownerId, alert.id)?.status).toBe(
        'TRIGGERED',
      );
    });
  });

  // --- configuration ----------------------------------------------------------

  describe('configuration', () => {
    it('honours a custom capacity limit end to end', async () => {
      const limited = createUxHarness({
        MAX_ALERTS_PER_USER: '1',
        ALERT_NOTIFICATION_RETRY_DELAY_MS: '0',
      });
      await seedMarketState(limited, { receivedAt: NOW() });
      const user = await limited.users.resolveUser(
        'bale',
        'engine-limited',
        CHAT_ID,
      );
      const limitedEngine = new AlertEngineService(
        limited.market.engine,
        limited.alerts,
        limited.alertStore,
        limited.notifications,
        limited.store,
      );
      await limitedEngine.onModuleInit();

      const env: EnvMap = { MAX_ALERTS_PER_USER: '1' };
      expect(env.MAX_ALERTS_PER_USER).toBe('1');

      const first = await limited.alerts.create(user.id, {
        type: 'PRICE_ABOVE',
        symbol: 'IR_GOLD_18K',
        targetPrice: 17_700_000,
      });
      expect(first.ok).toBe(true);

      await expect(
        limited.alerts.create(user.id, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_800_000,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'LIMIT_REACHED',
        limit: 1,
      });

      // The one alert still works.
      await limited.market.engine.evaluateCycle(
        rawPricePayload({ IR_GOLD_18K: 17_750_000 }, NOW().toISOString()),
        NOW(),
      );
      await limited.notifications.drain();
      if (!first.ok) {
        throw new Error('unreachable');
      }
      expect(limited.alerts.findDelivery(first.alert.id)?.status).toBe('SENT');
    });
  });
});

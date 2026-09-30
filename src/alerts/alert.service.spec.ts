import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlertService, SymbolPriceSnapshot } from './alert.service';
import { AlertStore } from './alert.store';
import { Alert, AlertMutationResult } from './alert.types';
import { UserStore } from '../users/user.store';
import { UserService } from '../users/user.service';
import {
  createAppConfigService,
  createMarketHarness,
  EnvMap,
  MarketHarness,
  seedMarketState,
} from '../testing/test-doubles';

/**
 * Domain rules of the price alert service (Phase 3 §6–§40).
 *
 * Everything here is enforced in the service/domain layer — never in the UI — so these tests call
 * the service directly: validation, canonical symbols, ownership, capacity, duplicates, the
 * lifecycle matrix, atomic editing and the trigger reservation.
 */

interface Stack {
  config: ReturnType<typeof createAppConfigService>;
  market: MarketHarness;
  alertStore: AlertStore;
  /** Phase 2 identity layer (the single user system — no second one for alerts). */
  users: UserService;
  userStore: UserStore;
  service: AlertService;
}

function createStack(env: EnvMap = {}): Stack {
  const config = createAppConfigService(env);
  const market = createMarketHarness(env);
  const alertStore = new AlertStore(config);
  const userStore = new UserStore(config);
  const users = new UserService(config, userStore);
  const service = new AlertService(
    config,
    alertStore,
    market.marketState,
    userStore,
  );

  return { config, market, alertStore, users, userStore, service };
}

/** Register a user through the Phase 2 identity layer (no second user system). */
async function registerUser(
  stack: Stack,
  platformUserId: string,
  platform: 'bale' | 'telegram' = 'bale',
): Promise<string> {
  const user = await stack.users.resolveUser(
    platform,
    platformUserId,
    `chat-${platformUserId}`,
  );

  return user.id;
}

/**
 * Seed the market state with the current defaults.
 *
 * The alert layer only accepts a *fresh* Phase 1 state as a baseline, so the seeded timestamps
 * must be recent (the shared default of `seedMarketState` is a fixed date in the past).
 */
async function seedNow(
  harness: MarketHarness,
  prices?: Record<string, number>,
  receivedAt: Date = new Date(),
): Promise<void> {
  await seedMarketState(harness, { prices, receivedAt });
}

const expectOk = (result: AlertMutationResult<Alert>): Alert => {
  if (!result.ok) {
    throw new Error(`Expected success but got ${result.reason}`);
  }

  return result.alert;
};

describe('AlertService', () => {
  let stack: Stack;
  let ownerId: string;
  let strangerId: string;

  beforeEach(async () => {
    stack = createStack();
    await seedNow(stack.market);
    ownerId = await registerUser(stack, 'owner');
    strangerId = await registerUser(stack, 'stranger');
  });

  // --- symbols & snapshots ----------------------------------------------------

  describe('market access (§51/§57)', () => {
    it('knows only the canonical Phase 1 symbols', () => {
      expect(stack.service.isSupportedSymbol('IR_GOLD_18K')).toBe(true);
      expect(stack.service.isSupportedSymbol('USD')).toBe(true);

      for (const symbol of [
        'BTCUSD',
        'GOLD18',
        '',
        'ir_gold_18k',
        ' IR_GOLD_18K',
      ]) {
        expect(stack.service.isSupportedSymbol(symbol)).toBe(false);
        expect(stack.service.definitionFor(symbol)).toBeNull();
        expect(stack.service.priceSnapshot(symbol)).toBeNull();
      }
    });

    it('exposes the registry with labels and units, never a local list', () => {
      const snapshots = stack.service.listSymbolSnapshots();

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.map((item) => item.symbol)).toContain('IR_GOLD_18K');
      expect(
        snapshots.every((item) => item.definition.symbol === item.symbol),
      ).toBe(true);
    });

    it('reports a fresh price as usable and a stale one as unusable', async () => {
      const snapshot = stack.service.priceSnapshot(
        'IR_GOLD_18K',
      ) as SymbolPriceSnapshot;
      expect(snapshot.usable).toBe(true);
      expect(snapshot.price).toBe(17_500_000);

      const stale = createStack({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedMarketState(stale.market, {
        receivedAt: new Date(Date.now() - 30 * 60_000),
      });

      const staleSnapshot = stale.service.priceSnapshot(
        'IR_GOLD_18K',
      ) as SymbolPriceSnapshot;
      expect(staleSnapshot.usable).toBe(false);
      expect(staleSnapshot.price).toBe(17_500_000);
    });

    it('returns a null price for a symbol that was never published', async () => {
      const empty = createStack();
      await seedMarketState(empty.market, {
        replace: true,
        prices: { USD: 1_055_000 },
        receivedAt: new Date(),
      });
      const emptyOwner = await registerUser(empty, 'owner-2');

      expect(empty.service.priceSnapshot('IR_GOLD_18K')).toMatchObject({
        price: null,
        usable: false,
      });

      const result = await empty.service.create(emptyOwner, {
        type: 'PERCENT_INCREASE',
        symbol: 'IR_GOLD_18K',
        targetPercent: 5,
      });

      expect(result).toMatchObject({ ok: false, reason: 'NO_VALID_PRICE' });
    });

    it('never converts the canonical unit (Rial stays Rial)', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_500_000,
        }),
      );

      // 17,500,000 Rial must not be silently stored as 1,750,000 Toman or anything else.
      expect(alert.targetPrice).toBe(17_500_000);
    });
  });

  // --- validation -------------------------------------------------------------

  describe('validation (§26/§27/§28)', () => {
    it('refuses an unknown user', async () => {
      const result = await stack.service.create('usr_unknown', {
        type: 'PRICE_ABOVE',
        symbol: 'IR_GOLD_18K',
        targetPrice: 17_500_000,
      });

      expect(result).toMatchObject({ ok: false, reason: 'USER_NOT_FOUND' });
    });

    it('refuses an unknown or malformed symbol', async () => {
      for (const symbol of ['', 'BTCUSD', 'ir_gold_18k', 'IR_GOLD_18K;DROP']) {
        const result = await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol,
          targetPrice: 17_500_000,
        });

        expect(result).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL' });
      }
    });

    it('refuses an unknown alert type', async () => {
      const result = await stack.service.create(ownerId, {
        type: 'PRICE_SIDEWAYS' as never,
        symbol: 'IR_GOLD_18K',
        targetPrice: 17_500_000,
      });

      expect(result).toMatchObject({ ok: false, reason: 'INVALID_TYPE' });
    });

    it('refuses invalid absolute targets', async () => {
      const invalid: (number | null)[] = [
        null,
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        // Outside the Phase 1 accepted range of the symbol (1,000,000 … 1,000,000,000 Rial):
        // a target there could never be crossed, because such a price is rejected upstream.
        999_999,
        1_000_000_001,
      ];

      for (const targetPrice of invalid) {
        const result = await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice,
        });

        expect(result).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
      }
    });

    it('refuses invalid percentages', async () => {
      const invalid: (number | null)[] = [
        null,
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        0.001, // below ALERT_MIN_TARGET_PERCENT
        150, // above ALERT_MAX_TARGET_PERCENT
      ];

      for (const targetPercent of invalid) {
        const result = await stack.service.create(ownerId, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent,
        });

        expect(result).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
      }
    });

    it('accepts the documented boundaries of the percentage range', async () => {
      const min = expectOk(
        await stack.service.create(ownerId, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 0.01,
        }),
      );
      const max = expectOk(
        await stack.service.create(ownerId, {
          type: 'PERCENT_DECREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 100,
        }),
      );

      expect(min.targetPercent).toBe(0.01);
      expect(max.targetPercent).toBe(100);
      expect(max.direction).toBe('DOWN');
    });

    it('honours a configured percentage range instead of a hard-coded one', async () => {
      const custom = createStack({
        ALERT_MIN_TARGET_PERCENT: '5',
        ALERT_MAX_TARGET_PERCENT: '10',
      });
      await seedNow(custom.market);
      const customOwner = await registerUser(custom, 'owner-3');

      expect(
        await custom.service.create(customOwner, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 4,
        }),
      ).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });

      expect(
        await custom.service.create(customOwner, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 7,
        }),
      ).toMatchObject({ ok: true });
    });

    it('stores the baseline of a percentage alert from the current Phase 1 price', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PERCENT_DECREASE',
          symbol: 'USD',
          targetPercent: 2,
        }),
      );

      expect(alert.baselinePrice).toBe(1_055_000);
      expect(alert.direction).toBe('DOWN');
      expect(alert.targetPrice).toBeNull();
    });

    it('never invents a baseline without an accepted price', async () => {
      const empty = createStack();
      const emptyOwner = await registerUser(empty, 'owner-4');

      const result = await empty.service.create(emptyOwner, {
        type: 'PERCENT_INCREASE',
        symbol: 'IR_COIN_EMAMI',
        targetPercent: 3,
      });

      expect(result).toMatchObject({ ok: false, reason: 'NO_VALID_PRICE' });
      expect(empty.alertStore.alertCount).toBe(0);
    });

    it('refuses to use a stale price as a baseline', async () => {
      const stale = createStack({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedMarketState(stale.market, {
        receivedAt: new Date(Date.now() - 30 * 60_000),
      });
      const staleOwner = await registerUser(stale, 'owner-5');

      const result = await stale.service.create(staleOwner, {
        type: 'PERCENT_INCREASE',
        symbol: 'IR_GOLD_18K',
        targetPercent: 3,
      });

      expect(result).toMatchObject({ ok: false, reason: 'NO_VALID_PRICE' });
    });

    it('validates early for the wizard without creating anything (`checkTarget`)', () => {
      expect(
        stack.service.checkTarget({
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_500_000,
        }),
      ).toEqual({ ok: true });

      expect(
        stack.service.checkTarget({
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: -1,
        }),
      ).toMatchObject({ ok: false, reason: 'INVALID_TARGET' });

      expect(stack.alertStore.alertCount).toBe(0);
    });

    it('reports whether the condition is already true (a warning, never a trigger)', () => {
      expect(
        stack.service.isConditionAlreadyMet({
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_000_000,
        }),
      ).toBe(true);

      expect(
        stack.service.isConditionAlreadyMet({
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      ).toBe(false);

      expect(
        stack.service.isConditionAlreadyMet({
          type: 'PRICE_BELOW',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      ).toBe(true);

      // A percentage alert measures the change from now on: it is never "already met".
      expect(
        stack.service.isConditionAlreadyMet({
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
      ).toBe(false);
    });
  });

  // --- ownership --------------------------------------------------------------

  describe('ownership (§19/§68)', () => {
    let alert: Alert;

    beforeEach(async () => {
      alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_500_000,
        }),
      );
    });

    it('gives every alert exactly one owner', () => {
      expect(alert.userId).toBe(ownerId);
      expect(stack.service.listForUser(strangerId)).toEqual([]);
      expect(stack.service.listForUser(ownerId).map((item) => item.id)).toEqual(
        [alert.id],
      );
    });

    it('reports a foreign alert exactly like a missing one', () => {
      expect(stack.service.findForUser(strangerId, alert.id)).toBeNull();
      expect(
        stack.service.findForUser(strangerId, 'alr_does_not_exist'),
      ).toBeNull();
      expect(
        stack.service.findForUser(ownerId, 'alr_does_not_exist'),
      ).toBeNull();
    });

    it('refuses every mutation of a foreign alert', async () => {
      const results = await Promise.all([
        stack.service.disable(strangerId, alert.id),
        stack.service.enable(strangerId, alert.id),
        stack.service.edit(strangerId, alert.id, { targetPrice: 18_000_000 }),
        stack.service.remove(strangerId, alert.id),
      ]);

      for (const result of results) {
        expect(result).toMatchObject({ ok: false, reason: 'ALERT_NOT_FOUND' });
      }

      // The owner's alert is untouched.
      const unchanged = stack.service.findForUser(ownerId, alert.id) as Alert;
      expect(unchanged.status).toBe('ACTIVE');
      expect(unchanged.targetPrice).toBe(17_500_000);
      expect(unchanged.userId).toBe(ownerId);
    });

    it('keeps alerts of different users separate when both use the same target', async () => {
      const other = expectOk(
        await stack.service.create(strangerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 17_500_000,
        }),
      );

      expect(other.id).not.toBe(alert.id);
      expect(
        stack.service.listForUser(strangerId).map((item) => item.id),
      ).toEqual([other.id]);
      expect(stack.service.listForUser(ownerId).map((item) => item.id)).toEqual(
        [alert.id],
      );
    });
  });

  // --- capacity ---------------------------------------------------------------

  describe('capacity limits (§36/§37)', () => {
    it('uses the configured limit and defaults to 5', () => {
      expect(stack.service.maxAlerts).toBe(5);

      const custom = createStack({ MAX_ALERTS_PER_USER: '2' });
      expect(custom.service.maxAlerts).toBe(2);
    });

    it('counts ACTIVE and DISABLED alerts, not TRIGGERED or DELETED ones', async () => {
      const limited = createStack({ MAX_ALERTS_PER_USER: '3' });
      await seedNow(limited.market);
      const limitedOwner = await registerUser(limited, 'owner-6');

      const first = expectOk(
        await limited.service.create(limitedOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      expectOk(
        await limited.service.create(limitedOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_100_000,
        }),
      );
      expectOk(
        await limited.service.create(limitedOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_200_000,
        }),
      );

      expect(limited.service.countForCapacity(limitedOwner)).toBe(3);
      expect(
        await limited.service.create(limitedOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_300_000,
        }),
      ).toEqual({ ok: false, reason: 'LIMIT_REACHED', limit: 3 });

      // A DISABLED alert still occupies its slot.
      await limited.service.disable(limitedOwner, first.id);
      expect(limited.service.countForCapacity(limitedOwner)).toBe(3);

      // A TRIGGERED one releases its slot: the user may create another alert again.
      const third = limited.service
        .listForUser(limitedOwner)
        .find((item) => item.targetPrice === 18_200_000) as Alert;
      await limited.service.reserveTrigger(third.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_500_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: 'chat-owner-6',
      });
      expect(limited.service.countForCapacity(limitedOwner)).toBe(2);

      // A DELETED one does not count either (even though the row stays for auditability).
      await limited.service.remove(limitedOwner, third.id);
      expect(limited.service.countForCapacity(limitedOwner)).toBe(2);

      await expect(
        limited.service.create(limitedOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_300_000,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('cannot be bypassed by concurrent creations', async () => {
      const limited = createStack({ MAX_ALERTS_PER_USER: '2' });
      await seedNow(limited.market);
      const limitedOwner = await registerUser(limited, 'owner-7');

      // Ten simultaneous presses of "create" — exactly two may be accepted.
      const results = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          limited.service.create(limitedOwner, {
            type: 'PRICE_ABOVE',
            symbol: 'IR_GOLD_18K',
            targetPrice: 18_000_000 + index * 1_000,
          }),
        ),
      );

      expect(results.filter((result) => result.ok)).toHaveLength(2);
      expect(
        results.filter(
          (result) => !result.ok && result.reason === 'LIMIT_REACHED',
        ),
      ).toHaveLength(8);
      expect(limited.service.countForCapacity(limitedOwner)).toBe(2);
      expect(limited.alertStore.alertCount).toBe(2);
    });
  });

  // --- duplicates -------------------------------------------------------------

  describe('duplicate prevention (§38)', () => {
    const create = async (
      targetPrice: number,
      type: 'PRICE_ABOVE' | 'PRICE_BELOW' = 'PRICE_ABOVE',
    ) =>
      stack.service.create(ownerId, {
        type,
        symbol: 'IR_GOLD_18K',
        targetPrice,
      });

    it('refuses an identical second alert (double click / repeated tap)', async () => {
      expectOk(await create(18_000_000));

      const again = await create(18_000_000);
      expect(again).toMatchObject({ ok: false, reason: 'DUPLICATE' });
      expect(stack.alertStore.alertCount).toBe(1);
    });

    it('refuses a duplicate of a DISABLED alert but allows one after TRIGGERED/DELETED', async () => {
      const alert = expectOk(await create(18_000_000));
      await stack.service.disable(ownerId, alert.id);

      expect(await create(18_000_000)).toMatchObject({
        ok: false,
        reason: 'DUPLICATE',
      });

      await stack.service.enable(ownerId, alert.id);
      await stack.service.reserveTrigger(alert.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_100_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: 'chat-owner',
      });

      // The triggered alert is spent, so the same target may be used again.
      await expect(create(18_000_000)).resolves.toMatchObject({ ok: true });
    });

    it('never blocks a legitimately different alert', async () => {
      // A wider capacity so the test is about duplication, not about the limit.
      const roomy = createStack({ MAX_ALERTS_PER_USER: '20' });
      await seedNow(roomy.market);
      const roomyOwner = await registerUser(roomy, 'owner-duplicates');

      const attempts = await Promise.all([
        roomy.service.create(roomyOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
        roomy.service.create(roomyOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_001,
        }),
        roomy.service.create(roomyOwner, {
          type: 'PRICE_BELOW',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
        roomy.service.create(roomyOwner, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
        roomy.service.create(roomyOwner, {
          type: 'PERCENT_DECREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
        roomy.service.create(roomyOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'USD',
          targetPrice: 1_100_000,
        }),
      ]);

      expect(attempts.map((result) => result.ok)).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(roomy.alertStore.alertCount).toBe(6);
      expect(roomy.service.countForCapacity(roomyOwner)).toBe(6);
    });

    it('cannot be bypassed by two simultaneous identical creations', async () => {
      const results = await Promise.all([
        create(18_000_000),
        create(18_000_000),
        create(18_000_000),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toHaveLength(2);
    });
  });

  // --- lifecycle --------------------------------------------------------------

  describe('lifecycle (§9–§18)', () => {
    let alert: Alert;

    beforeEach(async () => {
      alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
    });

    it('starts every new alert as ACTIVE', () => {
      expect(alert.status).toBe('ACTIVE');
      expect(alert.triggeredAt).toBeNull();
      expect(alert.deletedAt).toBeNull();
    });

    it('disables and re-enables an absolute alert without changing its target', async () => {
      const disabled = expectOk(await stack.service.disable(ownerId, alert.id));
      expect(disabled.status).toBe('DISABLED');
      expect(disabled.disabledAt).not.toBeNull();
      expect(disabled.targetPrice).toBe(18_000_000);

      // A disabled alert is not evaluated at all.
      expect(stack.service.listActiveForSymbol('IR_GOLD_18K')).toEqual([]);

      const enabled = expectOk(await stack.service.enable(ownerId, alert.id));
      expect(enabled.status).toBe('ACTIVE');
      expect(enabled.disabledAt).toBeNull();
      expect(enabled.targetPrice).toBe(18_000_000);
      expect(enabled.baselinePrice).toBeNull();
      expect(stack.service.listActiveForSymbol('IR_GOLD_18K')).toHaveLength(1);
    });

    it('is idempotent for repeated enable/disable presses', async () => {
      await stack.service.disable(ownerId, alert.id);
      await expect(
        stack.service.disable(ownerId, alert.id),
      ).resolves.toMatchObject({ ok: true });

      await stack.service.enable(ownerId, alert.id);
      await expect(
        stack.service.enable(ownerId, alert.id),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(stack.service.countForCapacity(ownerId)).toBe(1);
    });

    it('refreshes the baseline when a percentage alert is re-enabled (§16)', async () => {
      const percent = expectOk(
        await stack.service.create(ownerId, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
      );
      expect(percent.baselinePrice).toBe(17_500_000);

      await stack.service.disable(ownerId, percent.id);
      // The market moves while the alert sleeps: the old baseline (17,500,000) is +5.7% away.
      await seedNow(stack.market, { IR_GOLD_18K: 18_500_000 });

      const enabled = expectOk(await stack.service.enable(ownerId, percent.id));
      expect(enabled.baselinePrice).toBe(18_500_000);
      expect(enabled.status).toBe('ACTIVE');
    });

    it('refuses to re-enable without a usable price for a percentage alert', async () => {
      const staleStack = createStack({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedNow(staleStack.market);
      const staleOwner = await registerUser(staleStack, 'owner-8');
      const staleAlert = expectOk(
        await staleStack.service.create(staleOwner, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
      );
      await staleStack.service.disable(staleOwner, staleAlert.id);

      // Time passes without a validated price: nothing may become the new baseline.
      await seedMarketState(staleStack.market, {
        receivedAt: new Date(Date.now() - 30 * 60_000),
      });

      const result = await staleStack.service.enable(staleOwner, staleAlert.id);
      expect(result).toMatchObject({ ok: false, reason: 'NO_VALID_PRICE' });

      const stillDisabled = staleStack.service.findForUser(
        staleOwner,
        staleAlert.id,
      ) as Alert;
      expect(stillDisabled.status).toBe('DISABLED');
      expect(stillDisabled.baselinePrice).toBe(17_500_000);
    });

    it('treats a TRIGGERED alert as final: it is never enabled or disabled again', async () => {
      await stack.service.reserveTrigger(alert.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_100_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: 'chat-owner',
      });

      const triggered = stack.service.findForUser(ownerId, alert.id) as Alert;
      expect(triggered.status).toBe('TRIGGERED');
      expect(triggered.triggeredAt).not.toBeNull();

      await expect(
        stack.service.enable(ownerId, alert.id),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'INVALID_STATE',
      });
      await expect(
        stack.service.disable(ownerId, alert.id),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'INVALID_STATE',
      });
      expect(stack.service.listActiveForSymbol('IR_GOLD_18K')).toEqual([]);
    });

    it('soft-deletes and forgets the alert everywhere', async () => {
      const removed = expectOk(await stack.service.remove(ownerId, alert.id));

      expect(removed.status).toBe('DELETED');
      expect(removed.deletedAt).not.toBeNull();
      expect(stack.service.listForUser(ownerId)).toEqual([]);
      expect(stack.service.findForUser(ownerId, alert.id)).toBeNull();
      expect(stack.service.countForCapacity(ownerId)).toBe(0);
      expect(stack.service.listActiveForSymbol('IR_GOLD_18K')).toEqual([]);
      // The row is kept for auditability (soft delete), it is just no longer visible/usable.
      expect(stack.alertStore.alertCount).toBe(1);
    });

    it('refuses a second delete with a clean "not found"', async () => {
      await stack.service.remove(ownerId, alert.id);
      await expect(
        stack.service.remove(ownerId, alert.id),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'ALERT_NOT_FOUND',
      });
    });

    it('lists the newest alert first', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_500_000,
        }),
      );

      const list = stack.service.listForUser(ownerId);
      expect(list).toHaveLength(2);
      expect(list[0]?.id).toBe(second.id);
    });
  });

  // --- editing ----------------------------------------------------------------

  describe('editing (§17)', () => {
    it('changes an absolute target atomically', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );

      const edited = expectOk(
        await stack.service.edit(ownerId, alert.id, {
          targetPrice: 18_400_000,
        }),
      );

      expect(edited.targetPrice).toBe(18_400_000);
      expect(edited.status).toBe('ACTIVE');
      expect(edited.symbol).toBe('IR_GOLD_18K');
      expect(edited.type).toBe('PRICE_ABOVE');
      expect(edited.id).toBe(alert.id);
    });

    it('keeps the previous target when the new one is invalid (no partial edit)', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );

      for (const targetPrice of [null, 0, -5, Number.NaN, 10 ** 12]) {
        await expect(
          stack.service.edit(ownerId, alert.id, { targetPrice }),
        ).resolves.toMatchObject({ ok: false, reason: 'INVALID_TARGET' });
      }

      const unchanged = stack.service.findForUser(ownerId, alert.id) as Alert;
      expect(unchanged.targetPrice).toBe(18_000_000);
      expect(unchanged.updatedAt).toBe(alert.updatedAt);
    });

    it('refreshes the baseline when a percentage target is edited', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PERCENT_INCREASE',
          symbol: 'IR_GOLD_18K',
          targetPercent: 5,
        }),
      );

      await seedNow(stack.market, { IR_GOLD_18K: 18_000_000 });

      const edited = expectOk(
        await stack.service.edit(ownerId, alert.id, { targetPercent: 2 }),
      );

      expect(edited.targetPercent).toBe(2);
      expect(edited.baselinePrice).toBe(18_000_000);
      expect(edited.direction).toBe('UP');
    });

    it('refuses an edit that would duplicate another alert', async () => {
      const first = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      const second = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_200_000,
        }),
      );

      await expect(
        stack.service.edit(ownerId, second.id, { targetPrice: 18_000_000 }),
      ).resolves.toMatchObject({ ok: false, reason: 'DUPLICATE' });

      const unchanged = stack.service.findForUser(ownerId, second.id) as Alert;
      expect(unchanged.targetPrice).toBe(18_200_000);
      expect(first.targetPrice).toBe(18_000_000);
    });

    it('keeps the status of a disabled alert while editing it', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      await stack.service.disable(ownerId, alert.id);

      const edited = expectOk(
        await stack.service.edit(ownerId, alert.id, {
          targetPrice: 18_300_000,
        }),
      );

      expect(edited.status).toBe('DISABLED');
      expect(edited.targetPrice).toBe(18_300_000);
      expect(stack.service.listActiveForSymbol('IR_GOLD_18K')).toEqual([]);
    });

    it('never edits a triggered alert', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      await stack.service.reserveTrigger(alert.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_100_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: 'chat-owner',
      });

      await expect(
        stack.service.edit(ownerId, alert.id, { targetPrice: 18_500_000 }),
      ).resolves.toMatchObject({ ok: false, reason: 'INVALID_STATE' });
    });

    it('never edits a deleted alert', async () => {
      const alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      await stack.service.remove(ownerId, alert.id);

      await expect(
        stack.service.edit(ownerId, alert.id, { targetPrice: 18_500_000 }),
      ).resolves.toMatchObject({ ok: false, reason: 'ALERT_NOT_FOUND' });
    });
  });

  // --- trigger reservation & delivery state -----------------------------------

  describe('trigger reservation and delivery state (§40–§44)', () => {
    let alert: Alert;

    beforeEach(async () => {
      alert = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
    });

    const reserve = (alertId: string) =>
      stack.service.reserveTrigger(alertId, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_050_000,
        percent: null,
        observedAt: '2026-09-30T13:00:00.000Z',
        chatId: 'chat-owner',
      });

    it('reserves exactly one trigger and flips the alert to TRIGGERED', async () => {
      const delivery = await reserve(alert.id);

      expect(delivery).not.toBeNull();
      expect(delivery?.status).toBe('PENDING');
      expect(delivery?.attemptCount).toBe(0);
      expect(delivery?.triggerPrice).toBe(18_050_000);
      expect(delivery?.reason).toBe('PRICE_ABOVE_REACHED');

      const triggered = stack.service.findForUser(ownerId, alert.id) as Alert;
      expect(triggered.status).toBe('TRIGGERED');
      expect(stack.service.findDelivery(alert.id)?.id).toBe(delivery?.id);
    });

    it('never reserves a second trigger (one-shot)', async () => {
      expect(await reserve(alert.id)).not.toBeNull();
      expect(await reserve(alert.id)).toBeNull();
      expect(stack.service.listDeliveries()).toHaveLength(1);
    });

    it('never reserves a trigger for a disabled or deleted alert', async () => {
      const disabled = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_100_000,
        }),
      );
      await stack.service.disable(ownerId, disabled.id);
      expect(await reserve(disabled.id)).toBeNull();

      const removed = expectOk(
        await stack.service.create(ownerId, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_200_000,
        }),
      );
      await stack.service.remove(ownerId, removed.id);
      expect(await reserve(removed.id)).toBeNull();

      expect(stack.service.listDeliveries()).toHaveLength(0);
    });

    it('allows exactly one of two simultaneous reservations', async () => {
      const results = await Promise.all([
        reserve(alert.id),
        reserve(alert.id),
        reserve(alert.id),
      ]);

      expect(results.filter((delivery) => delivery !== null)).toHaveLength(1);
      expect(stack.service.listDeliveries()).toHaveLength(1);
    });

    it('records attempts, success and failure without losing the trigger', async () => {
      await reserve(alert.id);

      const started = await stack.service.beginAttempt(alert.id);
      expect(started?.attemptCount).toBe(1);
      expect(started?.lastAttemptAt).not.toBeNull();
      expect(started?.status).toBe('PENDING');

      const failed = await stack.service.recordFailure(alert.id, 'HTTP 502');
      expect(failed?.status).toBe('PENDING');
      expect(failed?.lastError).toBe('HTTP 502');

      const sent = await stack.service.markSent(alert.id);
      expect(sent?.status).toBe('SENT');
      expect(sent?.sentAt).not.toBeNull();

      const stillTriggered = stack.service.findForUser(
        ownerId,
        alert.id,
      ) as Alert;
      expect(stillTriggered.status).toBe('TRIGGERED');
    });

    it('marks an undeliverable notification as FAILED while keeping the trigger', async () => {
      await reserve(alert.id);

      const failed = await stack.service.markUndeliverable(
        alert.id,
        null,
        'notification delivery failed after the maximum number of attempts',
      );

      expect(failed?.status).toBe('FAILED');
      expect(failed?.skippedReason).toBeNull();
      expect(stack.service.findForUser(ownerId, alert.id)?.status).toBe(
        'TRIGGERED',
      );
      // A failed notification is never retried by creating a new trigger.
      expect(await reserve(alert.id)).toBeNull();
    });

    it('survives a restart with the same delivery record (no second notification)', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'alert-service-'));
      const filePath = join(directory, 'alerts.json');
      const persistent = createStack({ ALERTS_DATA_FILE: filePath });
      await seedNow(persistent.market);
      const persistentOwner = await registerUser(persistent, 'owner-9');
      const persistentAlert = expectOk(
        await persistent.service.create(persistentOwner, {
          type: 'PRICE_ABOVE',
          symbol: 'IR_GOLD_18K',
          targetPrice: 18_000_000,
        }),
      );
      await persistent.service.reserveTrigger(persistentAlert.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_050_000,
        percent: null,
        observedAt: '2026-09-30T13:00:00.000Z',
        chatId: 'chat-owner-9',
      });

      const restarted = createStack({ ALERTS_DATA_FILE: filePath });
      await restarted.alertStore.ensureLoaded();

      const restored = restarted.service.findForUser(
        persistentOwner,
        persistentAlert.id,
      ) as Alert;
      expect(restored.status).toBe('TRIGGERED');
      expect(restarted.service.findDelivery(persistentAlert.id)?.status).toBe(
        'PENDING',
      );
      expect(
        await restarted.service.reserveTrigger(persistentAlert.id, {
          reason: 'PRICE_ABOVE_REACHED',
          price: 18_100_000,
          percent: null,
          observedAt: '2026-09-30T14:00:00.000Z',
          chatId: 'chat-owner-9',
        }),
      ).toBeNull();
      expect(restarted.service.listDeliveries()).toHaveLength(1);

      await rm(directory, { recursive: true, force: true });
    });
  });
});

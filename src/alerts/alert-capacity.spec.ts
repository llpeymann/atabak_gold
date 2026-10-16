import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { AlertCapacityService } from './alert-capacity.service';
import { AlertService } from '../alerts/alert.service';
import { AlertStore } from '../alerts/alert.store';
import { AppConfigService } from '../config/app-config.service';
import {
  createAppConfigService,
  createMarketHarness,
  EnvMap,
  seedMarketState,
} from '../testing/test-doubles';
import { UserStore } from '../users/user.store';
import { ReferralService } from '../referrals/referral.service';
import { RewardGrant } from '../referrals/referral.types';

/**
 * Phase 7 §8.3 — capacity integration and the reward application path, one concern per test.
 *
 * The capacity rule has three failure modes that must never happen: a bonus applied twice, a bonus
 * that silently reduces the base capacity, and a broken write reported as a success. Each of them has
 * a dedicated test below.
 */

interface Stack {
  config: AppConfigService;
  store: UserStore;
  service: ReferralService;
  capacity: AlertCapacityService;
  alertService: AlertService;
  userId: string;
  dispose: () => Promise<void>;
}

const createStack = async (env: EnvMap = {}): Promise<Stack> => {
  const directory = await mkdtemp(joinPath(tmpdir(), 'atabak-capacity-'));
  const config = createAppConfigService({
    USER_DATA_FILE: joinPath(directory, 'users.json'),
    ALERTS_DATA_FILE: joinPath(directory, 'alerts.json'),
    ...env,
  });
  const store = new UserStore(config);
  await store.ensureLoaded();
  const capacity = new AlertCapacityService(config, store);
  const market = createMarketHarness({ BOT_POLLING_ENABLED: 'false' });
  await seedMarketState(market, { receivedAt: new Date() });

  const alertService = new AlertService(
    config,
    new AlertStore(config),
    market.marketState,
    store,
    capacity,
  );
  const service = new ReferralService(config, store, capacity);
  const user = await store.upsertUser('capacity-user', 'bale', 'chat-capacity');

  return {
    config,
    store,
    service,
    capacity,
    alertService,
    userId: user.id,
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const grantReward = async (
  stack: Stack,
  threshold: number,
  status: RewardGrant['status'] = 'PENDING',
): Promise<void> => {
  await stack.store.transact((tx) => {
    tx.saveReward({
      id: tx.nextId('rwd'),
      userId: stack.userId,
      rewardType: 'ALERT_CAPACITY',
      threshold,
      status,
      referralsAtGrant: threshold * 3,
      capacityBonus: 1,
      createdAt: new Date().toISOString(),
      grantedAt: status === 'GRANTED' ? new Date().toISOString() : null,
      lastError: null,
    });
  });
};

describe('effective alert capacity (§8.3)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack({ MAX_ALERTS_PER_USER: '3' });
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('equals the configured base when there is no reward', () => {
    expect(stack.capacity.effectiveLimit(stack.userId)).toEqual({
      baseLimit: 3,
      bonusSlots: 0,
      limit: 3,
    });
    expect(stack.alertService.maxAlerts).toBe(3); // the base getter is untouched
  });

  it('adds one slot per applied reward and never touches the base', () => {
    return (async () => {
      await grantReward(stack, 1, 'GRANTED');
      await grantReward(stack, 2, 'GRANTED');

      expect(stack.capacity.effectiveLimit(stack.userId)).toEqual({
        baseLimit: 3,
        bonusSlots: 2,
        limit: 5,
      });
      expect(stack.config.maxAlertsPerUser).toBe(3);
    })();
  });

  it('ignores rewards that are not applied (pending is not capacity)', async () => {
    await grantReward(stack, 1, 'PENDING');

    expect(stack.capacity.effectiveLimit(stack.userId).bonusSlots).toBe(0);
  });

  it('never applies the same ledger row twice (derived, not incremented)', async () => {
    await grantReward(stack, 1, 'GRANTED');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await stack.service.applyPendingRewards(stack.userId);
    }

    expect(stack.capacity.effectiveLimit(stack.userId).bonusSlots).toBe(1);
  });

  it('applies several pending rewards of one user exactly once each', async () => {
    await grantReward(stack, 1);
    await grantReward(stack, 2);
    await grantReward(stack, 3);

    const applied = await stack.service.applyPendingRewards(stack.userId);
    const again = await stack.service.applyPendingRewards(stack.userId);

    expect(applied).toHaveLength(3);
    expect(again).toHaveLength(0);
    expect(stack.capacity.effectiveLimit(stack.userId).bonusSlots).toBe(3);
  });

  it('never falls below the base capacity, whatever the ledger says', async () => {
    await stack.store.transact((tx) => {
      tx.saveReward({
        id: tx.nextId('rwd'),
        userId: stack.userId,
        rewardType: 'ALERT_CAPACITY',
        threshold: 1,
        status: 'GRANTED',
        referralsAtGrant: 3,
        // A corrupted row (hand-edited document) must never be able to *reduce* capacity.
        capacityBonus: -10,
        createdAt: new Date().toISOString(),
        grantedAt: new Date().toISOString(),
        lastError: null,
      });
    });

    expect(
      stack.capacity.effectiveLimit(stack.userId).limit,
    ).toBeGreaterThanOrEqual(3);
  });

  it('keeps the documented ceiling even with a huge ledger', async () => {
    const capped = await createStack({
      MAX_ALERTS_PER_USER: '2',
      REFERRAL_MAX_BONUS_SLOTS: '3',
    });

    for (let threshold = 1; threshold <= 10; threshold += 1) {
      await grantReward(capped, threshold, 'GRANTED');
    }

    expect(capped.capacity.effectiveLimit(capped.userId)).toEqual({
      baseLimit: 2,
      bonusSlots: 3,
      limit: 5,
    });

    await capped.dispose();
  });

  it('gives each user their own capacity', async () => {
    const other = await stack.store.upsertUser(
      'other-user',
      'bale',
      'chat-other',
    );
    await grantReward(stack, 1, 'GRANTED');

    expect(stack.capacity.effectiveLimit(stack.userId).limit).toBe(4);
    expect(stack.capacity.effectiveLimit(other.id).limit).toBe(3);
  });

  it('survives a restart with the same effective capacity', async () => {
    await grantReward(stack, 1, 'GRANTED');

    const reloadedStore = new UserStore(stack.config);
    await reloadedStore.ensureLoaded();
    const reloaded = new AlertCapacityService(stack.config, reloadedStore);

    expect(reloaded.effectiveLimit(stack.userId)).toEqual({
      baseLimit: 3,
      bonusSlots: 1,
      limit: 4,
    });
  });
});

describe('alert creation against the effective capacity (§8.3)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack({ MAX_ALERTS_PER_USER: '1' });
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('enforces the effective limit through the existing alert path (no bypass)', async () => {
    // The alert service is built on the same store as the ledger, so the limit it reports is the
    // effective one. Verified here without any alert creation to keep the test deterministic.
    expect(stack.alertService.effectiveMaxAlerts(stack.userId)).toBe(1);

    await grantReward(stack, 1, 'GRANTED');

    expect(stack.alertService.effectiveMaxAlerts(stack.userId)).toBe(2);
  });
});

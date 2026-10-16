import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  AlertCapacityService,
  EffectiveAlertCapacity,
} from '../alerts/alert-capacity.service';
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
import { ReferralService } from './referral.service';

/**
 * Phase 7 §8 — reward accounting and its integration with the Phase 3 alert capacity.
 *
 * The rule under test is small and absolute: **every three successful referrals give one permanent
 * extra alert slot**, written once per threshold, applied at most once, never revoked and never
 * counted twice — and the alert subsystem keeps enforcing everything it enforced before.
 */

interface Stack {
  config: AppConfigService;
  store: UserStore;
  alerts: AlertStore;
  service: ReferralService;
  capacity: AlertCapacityService;
  alertService: AlertService;
  userId: string;
  code: string;
  dispose: () => Promise<void>;
}

const createStack = async (env: EnvMap = {}): Promise<Stack> => {
  const directory = await mkdtemp(joinPath(tmpdir(), 'atabak-rewards-'));
  const config = createAppConfigService({
    USER_DATA_FILE: joinPath(directory, 'users.json'),
    ALERTS_DATA_FILE: joinPath(directory, 'alerts.json'),
    BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
    BALE_BOT_USERNAME: 'atabak_bot',
    ...env,
  });
  const store = new UserStore(config);
  await store.ensureLoaded();
  const alerts = new AlertStore(config);
  const capacity = new AlertCapacityService(config, store);
  const market = createMarketHarness({ ...env, BOT_POLLING_ENABLED: 'false' });
  await seedMarketState(market, { receivedAt: new Date() });

  const alertService = new AlertService(
    config,
    alerts,
    market.marketState,
    store,
    capacity,
  );
  const service = new ReferralService(config, store, capacity);
  const inviter = await store.upsertUser('inviter-1', 'bale', 'chat-inviter');
  const code = (await service.referralCodeFor(inviter.id)) ?? '';

  return {
    config,
    store,
    alerts,
    service,
    capacity,
    alertService,
    userId: inviter.id,
    code,
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** Bring exactly `count` *new* users in through the inviter's link. */
const bringInvitees = async (stack: Stack, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const result = await stack.service.handleStartReferral({
      platform: 'bale',
      platformUserId: `invitee-${index}`,
      chatId: `chat-invitee-${index}`,
      code: stack.code,
    });

    await stack.service.applyPendingRewards(
      result.outcome.kind === 'joined' ? stack.userId : '',
    );
  }
};

const capacityOf = (stack: Stack): EffectiveAlertCapacity =>
  stack.capacity.effectiveLimit(stack.userId);

describe('reward thresholds (§8.1, §8.2)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack();
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('grants nothing below the threshold', async () => {
    await bringInvitees(stack, 2);

    expect(stack.store.listRewards(stack.userId)).toHaveLength(0);
    expect(capacityOf(stack).limit).toBe(capacityOf(stack).baseLimit);
  });

  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 1],
    [6, 2],
    [8, 2],
    [9, 3],
    [12, 4],
  ])(
    'with %i successful referrals issues %i reward(s)',
    async (referrals, expected) => {
      const local = await createStack();
      await bringInvitees(local, referrals);

      const rewards = local.store.listRewards(local.userId);

      expect(rewards).toHaveLength(expected);
      // Thresholds are consecutive and never repeat.
      expect(rewards.map((reward) => reward.threshold)).toEqual(
        Array.from({ length: expected }, (_, index) => index + 1),
      );
      expect(new Set(rewards.map((reward) => reward.threshold)).size).toBe(
        expected,
      );

      await local.dispose();
    },
  );

  it('adds exactly one slot per reward and keeps the configured base intact', async () => {
    await bringInvitees(stack, 9);

    const capacity = capacityOf(stack);

    expect(capacity.baseLimit).toBe(stack.config.maxAlertsPerUser);
    expect(capacity.bonusSlots).toBe(3);
    expect(capacity.limit).toBe(capacity.baseLimit + 3);
  });

  it('never issues the same threshold twice, even after many more referrals', async () => {
    await bringInvitees(stack, 12);

    const thresholds = stack.store
      .listRewards(stack.userId)
      .map((reward) => reward.threshold);

    expect(thresholds).toEqual([1, 2, 3, 4]);
    expect(
      stack.store
        .listRewards(stack.userId)
        .filter((reward) => reward.status === 'GRANTED'),
    ).toHaveLength(4);
  });

  it('records the reward, applies it and reports it in the same arrival', async () => {
    await bringInvitees(stack, 2);

    const third = await stack.service.handleStartReferral({
      platform: 'bale',
      platformUserId: 'invitee-2',
      chatId: 'chat-invitee-2',
      code: stack.code,
    });

    expect(third.outcome.kind).toBe('joined');
    expect(
      third.outcome.kind === 'joined' && third.outcome.rewardsGranted,
    ).toHaveLength(1);

    const rewards = stack.store.listRewards(stack.userId);
    expect(rewards).toHaveLength(1);
    expect(rewards[0].status).toBe('GRANTED');
    expect(rewards[0].grantedAt).not.toBeNull();
    expect(capacityOf(stack).bonusSlots).toBe(1);

    // ...and a repeated application step stays a no-op (the ledger is the source of truth).
    expect(await stack.service.applyPendingRewards(stack.userId)).toHaveLength(
      0,
    );
  });

  it('leaves a reward pending when applying it fails, and recovers on the next attempt', async () => {
    // A ledger row that is pending (for example a crash between "earned" and "applied") is applied by
    // the next run instead of being lost.
    await bringInvitees(stack, 3);
    const reward = stack.store.listRewards(stack.userId)[0];
    await stack.store.transact((tx) => {
      tx.updateReward(stack.userId, reward.rewardType, reward.threshold, {
        status: 'PENDING',
        grantedAt: null,
      });
    });

    expect(capacityOf(stack).bonusSlots).toBe(0);

    const applied = await stack.service.applyPendingRewards(stack.userId);

    expect(applied).toHaveLength(1);
    expect(capacityOf(stack).bonusSlots).toBe(1);
  });

  it('re-applying an already applied reward is a no-op (effectively once, retry-safe)', async () => {
    await bringInvitees(stack, 3);

    const first = await stack.service.applyPendingRewards(stack.userId);
    const second = await stack.service.applyPendingRewards(stack.userId);
    const third = await stack.service.applyPendingRewards(stack.userId);

    expect(first).toHaveLength(0); // already applied by `bringInvitees`
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(capacityOf(stack).bonusSlots).toBe(1);
    expect(stack.store.listRewards(stack.userId)).toHaveLength(1);
  });

  it('keeps the grant after a restart and re-applies nothing', async () => {
    await bringInvitees(stack, 6);

    const reloadedStore = new UserStore(stack.config);
    await reloadedStore.ensureLoaded();
    const reloadedCapacity = new AlertCapacityService(
      stack.config,
      reloadedStore,
    );
    const reloadedService = new ReferralService(
      stack.config,
      reloadedStore,
      reloadedCapacity,
    );

    expect(reloadedCapacity.effectiveLimit(stack.userId).bonusSlots).toBe(2);
    expect(reloadedStore.listRewards(stack.userId)).toHaveLength(2);
    expect(
      await reloadedService.applyPendingRewards(stack.userId),
    ).toHaveLength(0);
  });

  it('never revokes a grant when the referred user becomes inactive', async () => {
    await bringInvitees(stack, 3);
    const before = capacityOf(stack).bonusSlots;

    // No interaction from the invitee at all — the activity metric stays at zero.
    const stats = stack.service.statsFor(stack.userId);

    expect(stats.activeReferrals).toBe(0);
    expect(capacityOf(stack).bonusSlots).toBe(before);
  });

  it('does not rewrite history when the thresholds change in configuration', async () => {
    await bringInvitees(stack, 3);

    // The rule is reconfigured to five referrals per reward *after* the fact.
    const reconfiguredConfig = createAppConfigService({
      USER_DATA_FILE: joinPath(dirnameOf(stack), 'users.json'),
      REFERRAL_REWARDS_PER_THRESHOLD: '5',
    });
    const reconfiguredStore = new UserStore(reconfiguredConfig);
    await reconfiguredStore.ensureLoaded();
    const reconfiguredCapacity = new AlertCapacityService(
      reconfiguredConfig,
      reconfiguredStore,
    );

    // The ledger that already exists keeps its meaning...
    expect(reconfiguredStore.listRewards(stack.userId)).toHaveLength(1);
    expect(reconfiguredCapacity.effectiveLimit(stack.userId).bonusSlots).toBe(
      1,
    );

    // ...and only the *next* threshold uses the new rule.
    const reconfiguredService = new ReferralService(
      reconfiguredConfig,
      reconfiguredStore,
      reconfiguredCapacity,
    );
    expect(reconfiguredService.referralsPerReward).toBe(5);
  });

  it('issues nothing while reward issuance is paused but keeps recording referrals', async () => {
    const paused = await createStack({ REFERRAL_REWARDS_ENABLED: 'false' });
    await bringInvitees(paused, 4);

    expect(paused.store.listRewards(paused.userId)).toHaveLength(0);
    expect(paused.store.listReferralsByInviter(paused.userId)).toHaveLength(4);

    // Switching issuance back on (a restart with the flag restored) catches the ledger up.
    const resumedConfig = createAppConfigService({
      USER_DATA_FILE: paused.config.userDataFile ?? '',
      BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
    });
    const resumedStore = new UserStore(resumedConfig);
    await resumedStore.ensureLoaded();
    const resumedCapacity = new AlertCapacityService(
      resumedConfig,
      resumedStore,
    );
    const resumed = new ReferralService(
      resumedConfig,
      resumedStore,
      resumedCapacity,
    );

    const caughtUp = await resumed.handleStartReferral({
      platform: 'bale',
      platformUserId: 'invitee-4',
      chatId: 'chat-4',
      code:
        (resumedStore.listReferralsByInviter(paused.userId).length > 0
          ? resumedStore.findUser(paused.userId)?.referralCode
          : null) ?? '',
    });

    expect(caughtUp.outcome.kind).toBe('joined');
    expect(resumedStore.listRewards(paused.userId).length).toBeGreaterThan(0);

    await paused.dispose();
  });

  it('never exceeds the documented bonus ceiling, whatever the configuration says', async () => {
    const capped = await createStack({
      REFERRAL_MAX_BONUS_SLOTS: '2',
      REFERRAL_REWARDS_PER_THRESHOLD: '1',
    });
    await bringInvitees(capped, 6);

    expect(capacityOf(capped).bonusSlots).toBeLessThanOrEqual(2);
    expect(capacityOf(capped).limit).toBeLessThanOrEqual(
      capped.config.maxAlertsPerUser + 2,
    );

    await capped.dispose();
  });

  it('keeps a reward pending (visible, recoverable) when the ceiling blocks it', async () => {
    const capped = await createStack({ REFERRAL_MAX_BONUS_SLOTS: '1' });
    await bringInvitees(capped, 6);

    const rewards = capped.store.listRewards(capped.userId);
    const pending = rewards.filter((reward) => reward.status === 'PENDING');

    expect(rewards.length).toBeGreaterThanOrEqual(2);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(
      pending.every(
        (reward) => reward.lastError === 'CAPACITY_CEILING_REACHED',
      ),
    ).toBe(true);
    expect(capacityOf(capped).bonusSlots).toBe(1);

    await capped.dispose();
  });
});

describe('reward integration with the alert subsystem (§8.3)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack({ MAX_ALERTS_PER_USER: '1' });
  });

  afterEach(async () => {
    await stack.dispose();
  });

  const createAlert = (symbol: string, targetPrice: number) =>
    stack.alertService.create(stack.userId, {
      type: 'PRICE_ABOVE',
      symbol,
      targetPrice,
    });

  it('allows the base number of alerts before any reward', async () => {
    const first = await createAlert('IR_GOLD_18K', 17_000_000);
    expect(first.ok).toBe(true);

    const second = await createAlert('IR_GOLD_24K', 22_000_000);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('LIMIT_REACHED');
      expect(second.limit).toBe(1);
    }
  });

  it('allows exactly one more alert after the first reward (base 1 + bonus 1)', async () => {
    await bringInvitees(stack, 3);

    expect(await createAlert('IR_GOLD_18K', 17_000_000)).toMatchObject({
      ok: true,
    });
    expect(await createAlert('IR_GOLD_24K', 22_000_000)).toMatchObject({
      ok: true,
    });

    // The third still fails: the bonus is one slot, not unlimited capacity.
    const third = await createAlert('IR_COIN_EMAMI', 90_000_000);
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe('LIMIT_REACHED');
      expect(third.limit).toBe(2);
    }
  });

  it('reports the effective limit in the limit-reached result (never the raw config value)', async () => {
    await bringInvitees(stack, 6);
    await createAlert('IR_GOLD_18K', 17_000_000);
    await createAlert('IR_GOLD_24K', 22_000_000);
    await createAlert('IR_COIN_EMAMI', 90_000_000);

    const blocked = await createAlert('IR_COIN_BAHAR', 84_000_000);

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.limit).toBe(3); // 1 configured + 2 earned
    }
    expect(stack.alertService.effectiveMaxAlerts(stack.userId)).toBe(3);
    expect(stack.alertService.maxAlerts).toBe(1);
  });

  it('keeps every existing alert rule intact (duplicates, ownership, validation)', async () => {
    await bringInvitees(stack, 3);

    expect(await createAlert('IR_GOLD_18K', 17_000_000)).toMatchObject({
      ok: true,
    });

    // Duplicate rejection is untouched by the bonus.
    const duplicate = await createAlert('IR_GOLD_18K', 17_000_000);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.reason).toBe('DUPLICATE');
    }

    // Unknown symbols are still refused.
    const unknown = await createAlert('NOT_A_SYMBOL', 1);
    expect(unknown.ok).toBe(false);

    // Another user never sees or uses this user's capacity.
    const other = await stack.store.upsertUser('other-1', 'bale', 'chat-other');
    const otherAlert = await stack.alertService.create(other.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 17_000_000,
    });
    expect(otherAlert.ok).toBe(true); // their own base slot, unaffected by this user's bonus
    expect(stack.alertService.effectiveMaxAlerts(other.id)).toBe(1);
  });

  it('counts only alerts that really exist, and keeps the effective limit available', async () => {
    await bringInvitees(stack, 3);

    expect(await createAlert('IR_GOLD_18K', 17_000_000)).toMatchObject({
      ok: true,
    });

    const blocked = await createAlert('IR_GOLD_24K', 22_000_000);
    expect(blocked.ok).toBe(true);

    // A third alert is refused, and the refusal is about the *effective* limit — the refused alert
    // itself never becomes part of the user's data.
    const refused = await createAlert('IR_GOLD_MELTED', 16_000_000);
    expect(refused.ok).toBe(false);
    expect(stack.alertService.listForUser(stack.userId)).toHaveLength(2);
    expect(stack.alertService.effectiveMaxAlerts(stack.userId)).toBe(2);
  });
});

/** Directory of the store's data file (used to reopen the same document with another config). */
function dirnameOf(stack: Stack): string {
  const file = stack.config.userDataFile ?? '';
  return file.slice(0, file.lastIndexOf('/'));
}

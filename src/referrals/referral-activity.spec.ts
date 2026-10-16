import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import { AlertCapacityService } from '../alerts/alert-capacity.service';
import { AppConfigService } from '../config/app-config.service';
import {
  createAppConfigService,
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../testing/test-doubles';
import { InboundMessage } from '../platform/platform.types';
import { UserStore } from '../users/user.store';
import { ReferralService } from './referral.service';

/**
 * Phase 7 §1.2, §7 — the *active referred member* metric and the referral statistics.
 *
 * The metric is deliberately boring: a referred user is "active" when the bot recorded a **real
 * user-initiated interaction** in the rolling window. Outbound deliveries, scheduled publications and
 * malformed updates must never move it, because the number is meant to describe people, not traffic.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Stack {
  config: AppConfigService;
  store: UserStore;
  service: ReferralService;
  inviterId: string;
  code: string;
  dispose: () => Promise<void>;
}

const createStack = async (env: EnvMap = {}): Promise<Stack> => {
  const directory = await mkdtemp(joinPath(tmpdir(), 'atabak-activity-'));
  const config = createAppConfigService({
    USER_DATA_FILE: joinPath(directory, 'users.json'),
    ...env,
  });
  const store = new UserStore(config);
  await store.ensureLoaded();
  const service = new ReferralService(
    config,
    store,
    new AlertCapacityService(config, store),
  );
  const inviter = await store.upsertUser('inviter-1', 'bale', 'chat-inviter');
  const code = (await service.referralCodeFor(inviter.id)) ?? '';

  return {
    config,
    store,
    service,
    inviterId: inviter.id,
    code,
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** Bring `count` invitees in and give every one of them a chosen interaction timestamp. */
const seedInvitees = async (
  stack: Stack,
  count: number,
  lastInteractionAt: (index: number) => string | null,
): Promise<string[]> => {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const result = await stack.service.handleStartReferral({
      platform: 'bale',
      platformUserId: `invitee-${index}`,
      chatId: `chat-${index}`,
      code: stack.code,
    });

    const inviteeId = result.user?.id ?? '';
    ids.push(inviteeId);

    const timestamp = lastInteractionAt(index);

    if (timestamp !== null) {
      await stack.store.touchInteraction(inviteeId, timestamp);
    }
  }

  return ids;
};

describe('active-referred-member metric (§1.2, §7.3)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack();
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('counts a referred user with a recent interaction', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 3, () =>
      new Date(now.getTime() - 2 * DAY).toISOString(),
    );

    const stats = stack.service.statsFor(stack.inviterId, now);

    expect(stats.successfulReferrals).toBe(3);
    expect(stats.activeReferrals).toBe(3);
  });

  it('treats a missing timestamp as inactive (absence is never read as "now")', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 2, () => null);

    const stats = stack.service.statsFor(stack.inviterId, now);

    expect(stats.successfulReferrals).toBe(2);
    expect(stats.activeReferrals).toBe(0);
  });

  it('keeps a user active exactly at the window boundary and inactive one millisecond later', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const window = stack.config.referralActiveWindowMs;

    const [exact, older] = await seedInvitees(stack, 2, (index) =>
      new Date(now.getTime() - window + (index === 0 ? 0 : -1)).toISOString(),
    );
    void exact;
    void older;

    const stats = stack.service.statsFor(stack.inviterId, now);

    expect(stats.activeReferrals).toBe(1);
  });

  it('counts unique referred users, never interactions', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const [inviteeId] = await seedInvitees(stack, 1, () => now.toISOString());

    // Twenty more interactions by the same person.
    for (let index = 0; index < 20; index += 1) {
      await stack.store.touchInteraction(inviteeId, now.toISOString());
    }

    expect(stack.service.statsFor(stack.inviterId, now).activeReferrals).toBe(
      1,
    );
  });

  it('ignores a timestamp that is not a valid date instead of counting it', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const [inviteeId] = await seedInvitees(stack, 1, () => null);

    // A corrupted value (hand-edited document) must not become "active".
    await stack.store.transact((tx) => {
      tx.touchInteraction(inviteeId, 'not-a-date');
    });

    expect(stack.service.statsFor(stack.inviterId, now).activeReferrals).toBe(
      0,
    );
  });

  it('is a reporting metric only: an inactive user keeps every earned reward', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 3, () => null);
    await stack.service.applyPendingRewards(stack.inviterId);

    const stats = stack.service.statsFor(stack.inviterId, now);

    expect(stats.activeReferrals).toBe(0);
    expect(stats.grantedRewards).toBe(1);
    expect(stats.effectiveAlertCapacity).toBe(stats.baseAlertCapacity + 1);
  });

  it('reports progress separately from what has been granted', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 2, () => now.toISOString());

    const stats = stack.service.statsFor(stack.inviterId, now);

    expect(stats.successfulReferrals).toBe(2);
    expect(stats.earnedThresholds).toBe(0);
    expect(stats.grantedRewards).toBe(0);
    expect(stats.pendingRewards).toBe(0);
    expect(stats.remainingForNextReward).toBe(1);
    expect(stats.referralsPerReward).toBe(3);
  });

  it('shows a pending reward as pending, never as granted', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 3, () => now.toISOString());

    // The arrival already applies what it earned...
    const appliedStats = stack.service.statsFor(stack.inviterId, now);
    expect(appliedStats.grantedRewards).toBe(1);
    expect(appliedStats.pendingRewards).toBe(0);
    expect(appliedStats.earnedThresholds).toBe(1);

    // ...but a row that is pending (a crash between earning and applying) is reported as pending,
    // never counted as granted, and is recovered by the application step.
    const reward = stack.store.listRewards(stack.inviterId)[0];
    await stack.store.transact((tx) => {
      tx.updateReward(stack.inviterId, reward.rewardType, reward.threshold, {
        status: 'PENDING',
        grantedAt: null,
      });
    });

    const pendingStats = stack.service.statsFor(stack.inviterId, now);
    expect(pendingStats.grantedRewards).toBe(0);
    expect(pendingStats.pendingRewards).toBe(1);
    expect(pendingStats.effectiveAlertCapacity).toBe(
      pendingStats.baseAlertCapacity,
    );

    await stack.service.applyPendingRewards(stack.inviterId);
    expect(stack.service.statsFor(stack.inviterId, now).grantedRewards).toBe(1);
  });

  it('counts only this user referrals (no cross-user leakage)', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    await seedInvitees(stack, 2, () => now.toISOString());
    const other = await stack.store.upsertUser('inviter-2', 'bale', 'chat-2');
    const otherCode = (await stack.service.referralCodeFor(other.id)) ?? '';

    await stack.service.handleStartReferral({
      platform: 'bale',
      platformUserId: 'other-invitee',
      chatId: 'chat-oi',
      code: otherCode,
    });

    expect(
      stack.service.statsFor(stack.inviterId, now).successfulReferrals,
    ).toBe(2);
    expect(stack.service.statsFor(other.id, now).successfulReferrals).toBe(1);
  });

  it('works the same way for a Telegram inviter (one implementation, both platforms)', async () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const tgInviter = await stack.store.upsertUser(
      'tg-1',
      'telegram',
      'tg-chat',
    );
    const tgCode = (await stack.service.referralCodeFor(tgInviter.id)) ?? '';

    const joined = await stack.service.handleStartReferral({
      platform: 'telegram',
      platformUserId: 'tg-invitee',
      chatId: 'tg-invitee-chat',
      code: tgCode,
    });
    await stack.store.touchInteraction(
      joined.user?.id ?? '',
      now.toISOString(),
    );

    const stats = stack.service.statsFor(tgInviter.id, now);
    expect(stats.successfulReferrals).toBe(1);
    expect(stats.activeReferrals).toBe(1);
  });
});

describe('interaction tracking through the real bot path (§1.2)', () => {
  let harness: UxHarness;

  const CHAT = 'chat-activity';
  const USER = 'activity-user';
  let updateId = 0;

  const message = (text: string): InboundMessage => ({
    kind: 'message',
    updateId: ++updateId,
    platform: 'bale',
    chatId: CHAT,
    platformUserId: USER,
    messageId: 800 + updateId,
    text,
  });

  beforeEach(async () => {
    harness = createUxHarness({ BALE_REFERRAL_BOT_USERNAME: 'atabak_bot' });
    await seedMarketState(harness.market, { receivedAt: new Date() });
  });

  it('records the timestamp of a real user-initiated interaction', async () => {
    await harness.botUx.handleUpdate(message('/start'));

    const user = harness.store.findUserByPlatform('bale', USER);
    expect(typeof user?.lastInteractionAt).toBe('string');
    expect(Number.isFinite(Date.parse(user?.lastInteractionAt ?? ''))).toBe(
      true,
    );
  });

  it('records the timestamp for a referral arrival as well', async () => {
    const inviter = await harness.users.resolveUser(
      'bale',
      'inviter-x',
      'chat-inviter',
    );
    const code = (await harness.growth.referralCodeFor(inviter.id)) ?? '';

    await harness.botUx.handleUpdate(message(`/start ref_${code}`));

    const invitee = harness.store.findUserByPlatform('bale', USER);
    expect(invitee).not.toBeNull();
    expect(typeof invitee?.lastInteractionAt).toBe('string');
  });

  it('does not move the timestamp for an outbound publication', async () => {
    await harness.botUx.handleUpdate(message('/start'));
    const before = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;

    // Outbound channel traffic (Phase 5 engine) never counts as user activity.
    await harness.channel.engine.publishDailyReport();

    const after = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;
    expect(after).toBe(before);
  });

  it('does not move the timestamp for an alert delivery', async () => {
    await harness.botUx.handleUpdate(message('/start'));
    const before = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;

    const user = harness.store.findUserByPlatform('bale', USER);
    const created = await harness.alerts.create(user?.id ?? '', {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 1_000_000,
    });
    expect(created.ok).toBe(true);
    await harness.notifications.drain();

    const after = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;
    expect(after).toBe(before);
  });

  it('does not move the timestamp for an update the router ignores', async () => {
    await harness.botUx.handleUpdate(message('/start'));
    const before = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;

    await harness.botUx.handleUpdate({
      kind: 'ignored',
      platform: 'bale',
      updateId: 9_999,
      reason: 'unsupported',
    });

    expect(
      harness.store.findUserByPlatform('bale', USER)?.lastInteractionAt,
    ).toBe(before);
  });

  it('throttles the write instead of persisting on every single message', async () => {
    await harness.botUx.handleUpdate(message('/start'));
    const first = harness.store.findUserByPlatform(
      'bale',
      USER,
    )?.lastInteractionAt;

    // Ten more interactions in the same minute: the stored value stays the first one (the metric has
    // a day granularity, so a write per button press would be pure overhead).
    for (let index = 0; index < 10; index += 1) {
      await harness.botUx.handleUpdate(message('/start'));
    }

    expect(
      harness.store.findUserByPlatform('bale', USER)?.lastInteractionAt,
    ).toBe(first);
  });
});

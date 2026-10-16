import {
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../platform/platform.types';
import { callbackDataForScreen } from '../bot/ux/callback-data';

/**
 * Phase 7 §7, §9, §10 — the referral experience through the **real bot**.
 *
 * Same harness as the Phase 6 deep-link suite: the actual router, the actual menu, the actual store and
 * the actual platform adapters (only the network is a double). What is verified here is what a user
 * sees and what the document contains afterwards — never an internal counter.
 */

const INVITER_USER = 'flow-inviter';
const INVITER_CHAT = 'chat-inviter';
const INVITEE_USER = 'flow-invitee';
const INVITEE_CHAT = 'chat-invitee';

let updateId = 0;

const message = (
  text: string,
  platformUserId: string,
  chatId: string,
): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId,
  platformUserId,
  messageId: 900 + updateId,
  text,
});

const callback = (
  data: string,
  platformUserId: string,
  chatId: string,
): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId,
  platformUserId,
  messageId: 900 + updateId,
  data,
  callbackId: `cb-${updateId}`,
});

describe('referral journey through the bot (§5, §7)', () => {
  let harness: UxHarness;
  let inviterId: string;
  let code: string;

  const create = async (env: EnvMap = {}): Promise<void> => {
    harness = createUxHarness({
      BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
      BALE_BOT_USERNAME: 'atabak_bot',
      ...env,
    });
    await seedMarketState(harness.market, { receivedAt: new Date() });

    const inviter = await harness.users.resolveUser(
      'bale',
      INVITER_USER,
      INVITER_CHAT,
    );
    inviterId = inviter.id;
    code = (await harness.growth.referralCodeFor(inviter.id)) ?? '';
  };

  const invite = async (
    platformUserId = INVITEE_USER,
    chatId = INVITEE_CHAT,
  ): Promise<void> => {
    await harness.botUx.handleUpdate(
      message(`/start ref_${code}`, platformUserId, chatId),
    );
  };

  const lastText = (): string => harness.last().text ?? '';
  const lastButtons = (): {
    text: string;
    url?: string;
    callbackData?: string;
  }[] => harness.buttons();
  const urls = (): (string | undefined)[] =>
    lastButtons().map((button) => button.url);

  beforeEach(async () => {
    await create();
  });

  it('registers the invited user, attributes the referral and shows the normal welcome', async () => {
    await invite();

    const invitee = harness.store.findUserByPlatform('bale', INVITEE_USER);
    expect(invitee).not.toBeNull();
    expect(harness.store.listReferralsByInviter(inviterId)).toHaveLength(1);
    expect(
      harness.store.listReferralsByInviter(inviterId)[0].inviteeUserId,
    ).toBe(invitee?.id);

    // The referral must never replace the normal start flow: the welcome screen and its menu remain.
    expect(lastText()).toContain('به بات');
    expect(lastButtons().map((button) => button.callbackData)).toContain(
      callbackDataForScreen('prices'),
    );
  });

  it('gives the invited user their own code, different from the inviter code', async () => {
    await invite();

    const invitee = harness.store.findUserByPlatform('bale', INVITEE_USER);
    expect(invitee?.referralCode).toBeDefined();
    expect(invitee?.referralCode).not.toBe(code);
  });

  it('never leaks an internal identifier into the screen the invited user sees', async () => {
    await invite();

    const visible = JSON.stringify({
      text: lastText(),
      buttons: lastButtons(),
    });
    expect(visible).not.toContain(inviterId);
    expect(visible).not.toContain('usr_');
  });

  it('tells an already-registered user that the code is for new users, without counting them', async () => {
    await harness.users.resolveUser('bale', 'existing-user', 'chat-existing');

    await invite('existing-user', 'chat-existing');

    expect(lastText()).toContain('حساب شما قبلاً ثبت شده');
    expect(harness.store.listReferralsByInviter(inviterId)).toHaveLength(0);
  });

  it('refuses a self-referral with a short explanation and no count', async () => {
    await harness.botUx.handleUpdate(
      message(`/start ref_${code}`, INVITER_USER, INVITER_CHAT),
    );

    expect(lastText()).toContain('لینک دعوت خودت');
    expect(harness.store.listReferralsByInviter(inviterId)).toHaveLength(0);
  });

  it('continues with the normal start flow for an unknown code (never blocks)', async () => {
    await harness.botUx.handleUpdate(
      message('/start ref_zzzz9999', INVITEE_USER, INVITEE_CHAT),
    );

    expect(lastText()).toContain('به بات');
    expect(harness.store.listReferralsByInviter(inviterId)).toHaveLength(0);
  });

  it('opens the referral screen from the menu with the link and the persisted numbers', async () => {
    await invite();

    await harness.botUx.handleUpdate(
      callback(callbackDataForScreen('referral'), INVITER_USER, INVITER_CHAT),
    );

    expect(lastText()).toContain('دعوت');
    expect(lastText()).toContain('دعوت‌های موفق شما');
    expect(urls()).toContain(`https://ble.ir/atabak_bot?start=ref_${code}`);
    expect(lastButtons().map((button) => button.callbackData)).toContain(
      'v1:home',
    );
  });

  it('shows the referral entry in the main menu only when the engine is enabled', async () => {
    await harness.botUx.handleUpdate(
      message('/start', INVITER_USER, INVITER_CHAT),
    );
    expect(lastButtons().map((button) => button.callbackData)).toContain(
      callbackDataForScreen('referral'),
    );

    const disabled = await create({ REFERRAL_ENABLED: 'false' });
    void disabled;
    await harness.botUx.handleUpdate(
      message('/start', INVITER_USER, INVITER_CHAT),
    );

    expect(lastButtons().map((button) => button.callbackData)).not.toContain(
      callbackDataForScreen('referral'),
    );
  });

  it('explains the missing link configuration instead of showing a dead button', async () => {
    await create({ BALE_REFERRAL_BOT_USERNAME: '' });

    await harness.botUx.handleUpdate(
      callback(callbackDataForScreen('referral'), INVITER_USER, INVITER_CHAT),
    );

    expect(lastText()).toContain('تنظیم نشده');
    expect(urls().every((url) => url === undefined)).toBe(true);
  });

  it('keeps the referral screen accurate after more arrivals and a granted reward', async () => {
    for (let index = 0; index < 3; index += 1) {
      await invite(`invitee-${index}`, `chat-${index}`);
    }
    // Three arrivals: the first two produce the welcome screens, the third also notifies the inviter.
    await harness.growth.applyPendingRewards(inviterId);

    await harness.botUx.handleUpdate(
      callback(callbackDataForScreen('referral'), INVITER_USER, INVITER_CHAT),
    );

    const text = lastText();
    expect(text).toContain('ظرفیت دائمی دریافت‌شده');
    expect(harness.growth.statsFor(inviterId).successfulReferrals).toBe(3);
    expect(harness.growth.statsFor(inviterId).grantedRewards).toBe(1);
  });
});

describe('reward notification (§8.4)', () => {
  let harness: UxHarness;
  let inviterId: string;
  let code: string;

  const create = async (env: EnvMap = {}): Promise<void> => {
    harness = createUxHarness({
      BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
      BALE_BOT_USERNAME: 'atabak_bot',
      ...env,
    });
    await seedMarketState(harness.market, { receivedAt: new Date() });
    const inviter = await harness.users.resolveUser(
      'bale',
      INVITER_USER,
      INVITER_CHAT,
    );
    inviterId = inviter.id;
    code = (await harness.growth.referralCodeFor(inviter.id)) ?? '';
  };

  const invite = (index: number): Promise<void> =>
    harness.botUx.handleUpdate(
      message(`/start ref_${code}`, `invitee-${index}`, `chat-${index}`),
    );

  beforeEach(async () => {
    await create();
  });

  it('notifies the inviter only after the third successful referral, with the real threshold', async () => {
    await invite(0);
    await invite(1);
    expect(harness.channel.publishes()).toHaveLength(0); // nothing is broadcast anywhere

    // Messages to the inviter before the threshold: none.
    const beforeCount = harness
      .rendered()
      .filter((call) => call.chatId === INVITER_CHAT).length;
    expect(beforeCount).toBe(0);

    await invite(2);

    const toInviter = harness
      .rendered()
      .filter((call) => call.chatId === INVITER_CHAT);
    expect(toInviter).toHaveLength(1);
    expect(toInviter[0].text ?? '').toContain('دعوت موفق');
    expect(toInviter[0].text ?? '').toContain('ظرفیت دائمی اضافه');
  });

  it('keeps the grant when the notification cannot be delivered', async () => {
    await invite(0);
    await invite(1);
    harness.platform.failSends(5);

    await invite(2);

    // The reward is persisted even though the message failed.
    const rewards = harness.store.listRewards(inviterId);
    expect(rewards).toHaveLength(1);
    expect(harness.growth.statsFor(inviterId).grantedRewards).toBe(1);
  });

  it('never sends the same congratulation twice for the same threshold', async () => {
    await invite(0);
    await invite(1);
    await invite(2);

    // A retry of the application step (for example after a restart) must not re-announce anything.
    await harness.growth.applyPendingRewards(inviterId);
    await harness.growth.applyPendingRewards(inviterId);

    const notices = harness
      .rendered()
      .filter(
        (call) =>
          call.chatId === INVITER_CHAT &&
          (call.text ?? '').includes('ظرفیت دائمی اضافه'),
      );

    expect(notices).toHaveLength(1);
  });
});

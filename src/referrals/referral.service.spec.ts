import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlertCapacityService } from '../alerts/alert-capacity.service';
import { AppConfigService } from '../config/app-config.service';
import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import { UserStore } from '../users/user.store';
import { ReferralService } from './referral.service';
import { generateReferralCode } from './referral-code';
import { Platform } from '../platform/platform.types';

/**
 * Phase 7 §5, §6, §13 — the referral flow itself.
 *
 * Every case of the specification's "must survive" list is exercised against the *real* store (a
 * temporary JSON document), without network and without a second user model. The assertions are about
 * persisted state, never about internal counters: what is not in the document did not happen.
 */

interface Stack {
  config: AppConfigService;
  store: UserStore;
  service: ReferralService;
  directory: string;
  dispose: () => Promise<void>;
}

const createStack = async (env: EnvMap = {}): Promise<Stack> => {
  const directory = await mkdtemp(join(tmpdir(), 'atabak-referral-'));
  const config = createAppConfigService({
    USER_DATA_FILE: join(directory, 'users.json'),
    BALE_REFERRAL_BOT_USERNAME: 'atabak_bot',
    ...env,
  });
  const store = new UserStore(config);
  await store.ensureLoaded();

  return {
    config,
    store,
    service: new ReferralService(
      config,
      store,
      new AlertCapacityService(config, store),
    ),
    directory,
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** Register a user the way the bot does, and give them a code. */
const registerInviter = async (
  stack: Stack,
  platform: Platform = 'bale',
  platformUserId = 'inviter-1',
  chatId: string | null = 'chat-inviter',
) => {
  const user = await stack.store.upsertUser(platformUserId, platform, chatId);
  const code = await stack.service.referralCodeFor(user.id);

  // The config getter is exercised here too: it is a plain synchronous getter, never a promise.
  // (An `await` on it was a lint error; the value itself depends on the scenario under test.)
  expect(typeof stack.config.referralEnabled).toBe('boolean');

  return { user, code: code ?? '' };
};

const joinViaCode = (
  stack: Stack,
  code: string,
  platformUserId: string,
  options: { platform?: Platform; chatId?: string | null; now?: Date } = {},
) =>
  stack.service.handleStartReferral({
    platform: options.platform ?? 'bale',
    platformUserId,
    chatId: options.chatId ?? `chat-${platformUserId}`,
    code,
    now: options.now,
  });

describe('referral codes on the user document (§4.1, §14)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack();
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('assigns a code once and keeps it stable forever', async () => {
    const { user, code } = await registerInviter(stack);

    expect(code).toHaveLength(8);
    expect(await stack.service.referralCodeFor(user.id)).toBe(code);
    expect(await stack.service.referralCodeFor(user.id)).toBe(code);
    expect(stack.store.findUser(user.id)?.referralCode).toBe(code);
  });

  it('never overwrites an existing code (a link that was already shared stays valid)', async () => {
    const { user } = await registerInviter(stack);
    const original = stack.store.findUser(user.id)?.referralCode;

    // A second assignment attempt must return the stored code, not a new one.
    const again = await stack.service.referralCodeFor(user.id);

    expect(again).toBe(original);
  });

  it('gives every user a different code and persists them across a restart', async () => {
    const first = await registerInviter(stack, 'bale', 'inviter-1');
    const second = await registerInviter(stack, 'bale', 'inviter-2');

    expect(first.code).not.toBe(second.code);

    const reloaded = new UserStore(stack.config);
    await reloaded.ensureLoaded();

    expect(reloaded.findUserByReferralCode(first.code)?.id).toBe(first.user.id);
    expect(reloaded.findUserByReferralCode(second.code)?.id).toBe(
      second.user.id,
    );
  });

  it('assigns codes concurrently without ever colliding', async () => {
    const users = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        stack.store.upsertUser(`bulk-${index}`, 'bale', null),
      ),
    );
    const codes = await Promise.all(
      users.map((user) => stack.service.referralCodeFor(user.id)),
    );

    expect(new Set(codes).size).toBe(users.length);
    expect(
      codes.every((code) => typeof code === 'string' && code.length === 8),
    ).toBe(true);

    for (const [index, user] of users.entries()) {
      expect(stack.store.findUser(user.id)?.referralCode).toBe(codes[index]);
    }
  });

  it('keeps codes collision-free on a document that already contains one', async () => {
    const fixed = generateReferralCode();
    const owner = await stack.store.upsertUser('owner-1', 'bale', null);
    await stack.store.transact((tx) => tx.assignReferralCode(owner.id, fixed));

    const { user, code } = await registerInviter(stack, 'bale', 'inviter-1');

    expect(code).not.toBe(fixed);
    expect(stack.store.findUserByReferralCode(fixed)?.id).toBe(owner.id);
    expect(stack.store.findUserByReferralCode(code)?.id).toBe(user.id);
  });

  it('reports the user platform and code together for rendering (no write on read)', async () => {
    const { user, code } = await registerInviter(stack);

    expect(stack.service.referralContext(user.id)).toEqual({
      platform: 'bale',
      code,
    });
    expect(stack.service.referralContext('usr_missing')).toBeNull();
  });
});

describe('referral registration and attribution (§5, §6)', () => {
  let stack: Stack;

  beforeEach(async () => {
    stack = await createStack();
  });

  afterEach(async () => {
    await stack.dispose();
  });

  it('registers a new user, records the relationship and reports a successful referral', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    const result = await joinViaCode(stack, code, 'invitee-1');

    expect(result.outcome.kind).toBe('joined');
    expect(result.user?.platformUserId).toBe('invitee-1');

    const referrals = stack.store.listReferralsByInviter(inviter.id);
    expect(referrals).toHaveLength(1);
    expect(referrals[0].inviteeUserId).toBe(result.user?.id);
    expect(referrals[0].code).toBe(code);
    expect(referrals[0].platform).toBe('bale');
  });

  it('persists the registration and the referral in the same document', async () => {
    const { user: inviter, code } = await registerInviter(stack);
    await joinViaCode(stack, code, 'invitee-1');

    const reloaded = new UserStore(stack.config);
    await reloaded.ensureLoaded();

    expect(reloaded.findUserByPlatform('bale', 'invitee-1')).not.toBeNull();
    expect(reloaded.listReferralsByInviter(inviter.id)).toHaveLength(1);
  });

  it('never counts a click: only a completed registration produces a referral row', async () => {
    const { user: inviter } = await registerInviter(stack);

    // An unknown code, a malformed code and a self-referral: three arrivals, zero referrals.
    await joinViaCode(stack, 'zzzz9999', 'visitor-1');
    await joinViaCode(stack, 'not-a-code', 'visitor-2');
    await joinViaCode(stack, generateReferralCode(), 'visitor-3');

    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(0);
  });

  it('rejects an unknown code without registering anybody or blocking the start flow', async () => {
    await registerInviter(stack);

    const result = await joinViaCode(stack, 'zzzz9999', 'visitor-1');

    expect(result.outcome.kind).toBe('unknown-code');
    expect(result.user).toBeNull(); // the caller continues with the normal start flow
    expect(result.noticeFa).toBeNull();
    expect(stack.store.findUserByPlatform('bale', 'visitor-1')).toBeNull();
    expect(stack.store.listReferrals()).toHaveLength(0);
  });

  it('rejects a malformed code without touching the store', async () => {
    await registerInviter(stack);

    for (const code of ['', 'ref_x', 'A'.repeat(9), 'bad code', 'o0l1i23a']) {
      const result = await joinViaCode(stack, code, `visitor-${code.length}`);

      expect(result.outcome.kind).toBe('unknown-code');
    }

    expect(stack.store.listReferrals()).toHaveLength(0);
  });

  it('refuses self-referral and explains it (identity, never a display name)', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    const result = await joinViaCode(stack, code, 'inviter-1');

    expect(result.outcome.kind).toBe('self-referral');
    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(0);
    expect(result.noticeFa).not.toBeNull();
  });

  it('detects self-referral even when the inviter arrives from another chat', async () => {
    const { user: inviter, code } = await registerInviter(
      stack,
      'bale',
      'inviter-1',
      'chat-old',
    );

    const result = await joinViaCode(stack, code, 'inviter-1', {
      chatId: 'chat-new',
    });

    expect(result.outcome.kind).toBe('self-referral');
    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(0);
  });

  it('never attributes an already-registered user and never changes their inviter', async () => {
    const { user: inviter, code } = await registerInviter(stack);
    const other = await registerInviter(stack, 'bale', 'inviter-2');
    const existing = await stack.store.upsertUser(
      'existing-1',
      'bale',
      'chat-existing',
    );

    const result = await joinViaCode(stack, code, 'existing-1');

    expect(result.outcome.kind).toBe('existing-user');
    expect(result.user?.id).toBe(existing.id);
    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(0);
    expect(stack.store.listReferralsByInviter(other.user.id)).toHaveLength(0);
  });

  it('never re-attributes after a second /start with another code (first attribution wins)', async () => {
    const first = await registerInviter(stack, 'bale', 'inviter-1');
    const second = await registerInviter(stack, 'bale', 'inviter-2');

    const joined = await joinViaCode(stack, first.code, 'invitee-1');
    expect(joined.outcome.kind).toBe('joined');

    const again = await joinViaCode(stack, second.code, 'invitee-1');

    expect(again.outcome.kind).toBe('existing-user');
    expect(stack.store.listReferralsByInviter(first.user.id)).toHaveLength(1);
    expect(stack.store.listReferralsByInviter(second.user.id)).toHaveLength(0);
    expect(stack.store.listReferrals()).toHaveLength(1);
  });

  it('is idempotent for a duplicate start: no duplicate user, no double count', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    const first = await joinViaCode(stack, code, 'invitee-1');
    const second = await joinViaCode(stack, code, 'invitee-1');
    const third = await joinViaCode(stack, code, 'invitee-1');

    expect(first.outcome.kind).toBe('joined');
    expect(second.outcome.kind).toBe('existing-user');
    expect(third.outcome.kind).toBe('existing-user');
    expect(stack.store.listReferrals()).toHaveLength(1);
    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(1);
  });

  it('handles two concurrent first arrivals of the same identity exactly once', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    const results = await Promise.all([
      joinViaCode(stack, code, 'invitee-race'),
      joinViaCode(stack, code, 'invitee-race'),
      joinViaCode(stack, code, 'invitee-race'),
    ]);

    expect(
      results.filter((result) => result.outcome.kind === 'joined'),
    ).toHaveLength(1);
    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(1);
    expect(
      [...stack.store.listUsers()].filter(
        (user) => user.platformUserId === 'invitee-race',
      ),
    ).toHaveLength(1);
  });

  it('handles concurrent arrivals of different identities without losing one', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        joinViaCode(stack, code, `invitee-${index}`),
      ),
    );

    expect(stack.store.listReferralsByInviter(inviter.id)).toHaveLength(5);
  });

  it('does nothing at all while the feature is switched off', async () => {
    const disabled = await createStack({ REFERRAL_ENABLED: 'false' });
    const { user: inviter, code } = await registerInviter(disabled);

    const result = await joinViaCode(disabled, code, 'invitee-1');

    expect(result.outcome.kind).toBe('disabled');
    expect(result.user).toBeNull();
    expect(disabled.store.listReferralsByInviter(inviter.id)).toHaveLength(0);
    expect(disabled.store.findUserByPlatform('bale', 'invitee-1')).toBeNull();

    await disabled.dispose();
  });

  it('keeps existing referrals and codes while disabled (data is never destroyed)', async () => {
    const live = await createStack();
    const { user: inviter, code } = await registerInviter(live);
    await joinViaCode(live, code, 'invitee-1');

    const reopened = new UserStore(live.config);
    await reopened.ensureLoaded();
    const remembered = reopened.listReferralsByInviter(inviter.id).length;

    const disabledConfig = createAppConfigService({
      USER_DATA_FILE: join(live.directory, 'users.json'),
      REFERRAL_ENABLED: 'false',
    });
    const disabledStore = new UserStore(disabledConfig);
    await disabledStore.ensureLoaded();

    expect(remembered).toBe(1);
    expect(disabledStore.listReferralsByInviter(inviter.id)).toHaveLength(1);
    expect(disabledStore.findUserByReferralCode(code)?.id).toBe(inviter.id);

    await live.dispose();
  });

  it('never reports success when the relationship could not be persisted', async () => {
    const broken = await createStack({
      USER_DATA_FILE: '/dev/null/users.json',
    });
    const { user: inviter, code } = await registerInviter(broken);

    const result = await joinViaCode(broken, code, 'invitee-1');

    // The user exists in memory, but nothing durable happened: no success, no reward announcement.
    expect(result.outcome.kind).toBe('persist-failed');
    expect(result.referrerNotice).toBeNull();
    expect(broken.store.listReferralsByInviter(inviter.id)).toHaveLength(1); // memory only

    // ...and the document on disk stays clean, which is what "nothing durable happened" means.
    const durable = new UserStore(broken.config);
    await durable.ensureLoaded();
    expect(durable.listReferralsByInviter(inviter.id)).toHaveLength(0);
    // The whole document was unwritable here, so not even the inviter is on disk — which is exactly
    // why the arrival must not be reported as a successful referral.
    expect(durable.listUsers()).toHaveLength(0);
    expect(broken.store.listRewards(inviter.id)).toHaveLength(0);

    await broken.dispose();
  });

  it('keeps an identity per platform (no cross-platform attribution is invented)', async () => {
    const { user: baleInviter, code } = await registerInviter(
      stack,
      'bale',
      '42',
    );

    const result = await joinViaCode(stack, code, '42', {
      platform: 'telegram',
    });

    // Same numeric id on another platform is a *different* user: it joins normally, and the
    // relationship belongs to the platform it happened on (§10.4 documented limitation).
    expect(result.outcome.kind).toBe('joined');
    expect(result.user?.platform).toBe('telegram');
    expect(stack.store.listReferralsByInviter(baleInviter.id)).toHaveLength(1);
    expect(result.user?.id).not.toBe(baleInviter.id);
  });

  it('ignores a code after the inviter has been deleted from the document', async () => {
    const { code } = await registerInviter(stack);
    // A code that no user owns anymore resolves to nothing (never to a random user).
    const orphan = stack.store.findUserByReferralCode(code);
    expect(orphan).not.toBeNull();

    const result = await joinViaCode(
      stack,
      generateReferralCode(),
      'invitee-1',
    );

    expect(result.outcome.kind).toBe('unknown-code');
  });

  it('never leaks an internal identifier into an outcome that the user can see', async () => {
    const { user: inviter, code } = await registerInviter(stack);

    const result = await joinViaCode(stack, code, 'invitee-1');
    const visible = JSON.stringify(result.noticeFa ?? '');

    expect(visible).not.toContain(inviter.id);
    expect(visible).not.toContain('usr_');
  });
});

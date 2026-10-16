import {
  createAdminHarness,
  createAppConfigService,
  EnvMap,
} from '../testing/test-doubles';
import { UserStore } from '../users/user.store';
import { AdminStore } from './admin.store';
import { AdminBroadcastService } from './admin-broadcast.service';
import { BroadcastAudience, BroadcastRecipient } from './admin.types';

/**
 * Phase 10 — broadcast (§11). The single most dangerous capability in the system, so the suite is
 * written around what must *not* happen: nothing is sent before the final confirmation, a rate limit
 * never burns an attempt, an unanswered request is never re-sent, a cancelled job sends nothing, and
 * every number in the final report is read back from durable per-recipient records.
 *
 * Only the platform transport is doubled — eligibility, authorization, persistence and reporting are
 * the real implementations.
 */

const OWNER = { key: 'bale:900', role: 'OWNER' as const };

const BASE_ENV: EnvMap = {
  ADMIN_DATA_FILE: '',
  ADMIN_OWNER_IDS: 'bale:900',
  ADMIN_USER_IDS: '',
  ADMIN_BROADCAST_ENABLED: 'true',
  ADMIN_BROADCAST_MIN_INTERVAL_MS: '0',
  ADMIN_BROADCAST_BACKOFF_MS: '1000',
  ADMIN_BROADCAST_MAX_ATTEMPTS: '2',
  ADMIN_BROADCAST_MAX_MANUAL_RETRIES: '1',
  ADMIN_BROADCAST_MAX_RECIPIENTS: '500',
  ADMIN_BROADCAST_MAX_LENGTH: '3000',
  BOT_POLLING_ENABLED: 'false',
};

interface Stack {
  harness: ReturnType<typeof createAdminHarness>;
  users: UserStore;
  broadcast: AdminBroadcastService;
  store: AdminStore;
  sends: () => { chatId: string; text: string }[];
}

const audience = (
  kind: BroadcastAudience['kind'],
  extra: Partial<BroadcastAudience> = {},
): BroadcastAudience => ({
  kind,
  platform: extra.platform ?? null,
  days: extra.days ?? null,
});

const build = async (
  env: EnvMap = {},
  people: {
    id: string;
    platform?: 'bale' | 'telegram';
    chatId?: string | null;
  }[] = [],
): Promise<Stack> => {
  const merged = { ...BASE_ENV, ...env };
  const config = createAppConfigService(merged);
  const users = new UserStore(config);
  const harness = createAdminHarness(merged, { config, userStore: users });

  for (const person of people) {
    await users.upsertUser(
      person.id,
      person.platform ?? 'bale',
      person.chatId === undefined
        ? `90000${person.id}`.replace(/\D/gu, '9')
        : person.chatId,
    );
  }

  await harness.load();

  return {
    harness,
    users,
    broadcast: harness.broadcast,
    store: harness.store,
    sends: () =>
      harness.platform.calls
        .filter((call) => call.kind === 'send')
        .map((call) => ({ chatId: call.chatId, text: call.text ?? '' })),
  };
};

const recipientsOf = (
  stack: Stack,
  reference: string,
): BroadcastRecipient[] => {
  const job = stack.broadcast
    .list(10)
    .find((row) => row.reference === reference);

  return job ? stack.store.listRecipients(job.broadcastId) : [];
};

describe('phase 10 — broadcast eligibility is one rule for the preview and the send (§11.1)', () => {
  it('is switched off unless the deployment enables it, and says so instead of pretending', async () => {
    const stack = await build({ ADMIN_BROADCAST_ENABLED: 'false' }, [
      { id: '1' },
    ]);

    expect(stack.broadcast.enabled).toBe(false);

    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    expect(prepared).toMatchObject({ ok: false, code: 'DISABLED' });
    expect(stack.store.listBroadcasts()).toHaveLength(0);
    expect(stack.sends()).toHaveLength(0);
  });

  it('counts only identities that can actually receive a message', async () => {
    const stack = await build({}, [
      { id: '1' },
      { id: '2', platform: 'telegram' },
      { id: '3', chatId: null },
    ]);

    const preview = stack.broadcast.resolveAudience(audience('ALL'));

    expect(preview.recipients).toHaveLength(2);
    expect(preview.excluded.map((row) => row.reason).join(' ')).toContain(
      'بدون chatId',
    );
  });

  it('filters by platform', async () => {
    const stack = await build({}, [
      { id: '1' },
      { id: '2', platform: 'telegram' },
    ]);

    expect(
      stack.broadcast.resolveAudience(
        audience('PLATFORM', { platform: 'bale' }),
      ).recipients,
    ).toHaveLength(1);
    expect(
      stack.broadcast.resolveAudience(
        audience('PLATFORM', { platform: 'telegram' }),
      ).recipients,
    ).toHaveLength(1);
  });

  it('uses recorded interaction days for active/inactive, and never guesses for identities without data', async () => {
    const stack = await build({}, [
      { id: 'active' },
      { id: 'silent-old' },
      { id: 'never' },
    ]);

    await stack.harness.activity.recordUserAction({
      platform: 'bale',
      platformUserId: 'active',
      userId: stack.users.findUserByPlatform('bale', 'active')!.id,
    });

    // “Actively silent”: the identity has activity data, but not inside the window.
    const old = stack.users.findUserByPlatform('bale', 'silent-old')!;
    await stack.harness.activity.recordUserAction(
      {
        platform: 'bale',
        platformUserId: 'silent-old',
        userId: old.id,
      },
      new Date(Date.now() - 40 * 24 * 60 * 60_000),
    );

    const active = stack.broadcast.resolveAudience(
      audience('ACTIVE_LAST_DAYS', { days: 1 }),
    );
    const inactive = stack.broadcast.resolveAudience(
      audience('INACTIVE_LAST_DAYS', { days: 30 }),
    );

    expect(active.recipients.map((row) => row.identityKey)).toEqual([
      'bale:active',
    ]);
    expect(inactive.recipients.map((row) => row.identityKey)).toEqual([
      'bale:silent-old',
    ]);
    // The identity that never interacted is *not* silently treated as inactive (§11.1).
    expect(inactive.excluded.map((row) => row.reason).join(' ')).toContain(
      'بدون دادهٔ فعالیت',
    );
  });

  it('refuses an audience token it cannot parse', async () => {
    const stack = await build({}, [{ id: '1' }]);

    expect(stack.broadcast.parseAudience('EVERYONE')).toBeNull();
    expect(
      stack.broadcast.parseAudience('PLATFORM', { platform: 'whatsapp' }),
    ).toBeNull();
    expect(
      stack.broadcast.parseAudience('ACTIVE_LAST_DAYS', { days: '0' }),
    ).toBeNull();
    expect(
      stack.broadcast.parseAudience('ACTIVE_LAST_DAYS', { days: '400' }),
    ).toBeNull();
    expect(
      stack.broadcast.parseAudience('ACTIVE_LAST_DAYS', { days: '7' }),
    ).toEqual({
      kind: 'ACTIVE_LAST_DAYS',
      platform: null,
      days: 7,
    });
  });

  it('honours an opt-out and never sends to that identity', async () => {
    const stack = await build({}, [{ id: '1' }, { id: '2' }]);
    const optedOut = stack.users.findUserByPlatform('bale', '2')!;

    stack.users.hydrateUser({ ...optedOut, broadcastOptOut: true } as never);

    const preview = stack.broadcast.resolveAudience(audience('ALL'));

    expect(preview.recipients.map((row) => row.identityKey)).toEqual([
      'bale:1',
    ]);
    expect(preview.excluded.map((row) => row.reason).join(' ')).toContain(
      'opt-out',
    );
  });

  it('refuses an audience larger than the configured cap instead of sending anyway', async () => {
    const stack = await build({ ADMIN_BROADCAST_MAX_RECIPIENTS: '1' }, [
      { id: '1' },
      { id: '2' },
    ]);

    const preview = stack.broadcast.resolveAudience(audience('ALL'));

    expect(preview.limitExceeded).toBe(true);

    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    expect(prepared).toMatchObject({ ok: false, code: 'LIMIT_EXCEEDED' });
    expect(stack.store.listBroadcasts()).toHaveLength(0);
  });
});

describe('phase 10 — nothing is sent before the explicit confirmation (§11.2, §11.3)', () => {
  it('rejects an empty or over-long text', async () => {
    const stack = await build({ ADMIN_BROADCAST_MAX_LENGTH: '20' }, [
      { id: '1' },
    ]);

    expect(
      await stack.broadcast.prepare({
        actor: OWNER,
        text: '   ',
        audience: audience('ALL'),
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });

    expect(
      await stack.broadcast.prepare({
        actor: OWNER,
        text: 'x'.repeat(21),
        audience: audience('ALL'),
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('refuses an audience with no eligible recipient', async () => {
    const stack = await build({}, [{ id: '1', chatId: null }]);

    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    expect(prepared).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('persists the job as PREPARED with PENDING recipients and audits the preparation', async () => {
    const stack = await build({}, [{ id: '1' }, { id: '2' }]);

    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام به همه',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    expect(prepared.value.status).toBe('PREPARED');
    expect(prepared.value.totalRecipients).toBe(2);
    expect(recipientsOf(stack, prepared.value.reference)).toHaveLength(2);
    expect(
      recipientsOf(stack, prepared.value.reference).every(
        (row) => row.status === 'PENDING',
      ),
    ).toBe(true);
    expect(stack.harness.audit.list()[0]).toMatchObject({
      action: 'BROADCAST_PREPARED',
      result: 'OK',
      toState: 'PREPARED',
    });
    expect(stack.sends()).toHaveLength(0);
  });

  it('does nothing at all while the job is only prepared', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    const tick = await stack.broadcast.processTick();

    expect(tick.processed).toBe(0);
    expect(stack.sends()).toHaveLength(0);
  });

  it('starts only on the confirmation and records the transition', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    const confirmed = await stack.broadcast.confirm(
      prepared.value.reference,
      OWNER,
    );

    expect(confirmed.ok && confirmed.value.status).toBe('RUNNING');

    const tick = await stack.broadcast.processTick();

    expect(tick.sent).toBe(1);
    expect(stack.sends()).toHaveLength(1);
    expect(stack.sends()[0]?.text).toBe('سلام');

    const job = stack.broadcast.list(1)[0];

    expect(job?.status).toBe('COMPLETED');

    const actions = stack.harness.audit
      .list()
      .map((row) => `${row.action}:${row.result}`);

    expect(actions).toContain('BROADCAST_CONFIRMED:OK');
    expect(actions).toContain('BROADCAST_STARTED:OK');
    expect(actions).toContain('BROADCAST_COMPLETED:OK');
  });

  it('is idempotent: a double-tapped confirmation neither restarts nor duplicates a recipient', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    await stack.broadcast.processTick();
    await stack.broadcast.processTick();

    expect(stack.store.listRecipients(prepared.value.broadcastId)).toHaveLength(
      1,
    );
    expect(stack.sends()).toHaveLength(1);
  });
});

describe('phase 10 — bounded, rate-limit-aware sending with per-recipient idempotency (§11.4)', () => {
  it('processes only one batch per tick', async () => {
    const stack = await build({ ADMIN_BROADCAST_BATCH_SIZE: '1' }, [
      { id: '1' },
      { id: '2' },
    ]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);

    const first = await stack.broadcast.processTick();

    expect(first.processed).toBe(1);
    expect(first.jobCompleted).toBeNull();
    expect(stack.sends()).toHaveLength(1);

    const second = await stack.broadcast.processTick();

    expect(second.processed).toBe(1);
    expect(second.jobCompleted).toBe(prepared.value.reference);
    expect(stack.sends()).toHaveLength(2);
  });

  it('assigns every recipient a unique identity key, so a redelivery cannot double-send', async () => {
    const stack = await build({}, [{ id: '1' }, { id: '2' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    const keys = recipientsOf(stack, prepared.value.reference).map(
      (row) => row.identityKey,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(
      recipientsOf(stack, prepared.value.reference).every(
        (row) => row.broadcastId === prepared.value.broadcastId,
      ),
    ).toBe(true);
  });

  it('treats a rate limit as “slow down”: no attempt is burned and the recipient stays pending', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    stack.harness.platform.client.sendMessage.mockResolvedValueOnce({
      platform: 'bale',
      chatId: 'chat-1',
      success: false,
      messageId: null,
      error: '429 Too Many Requests: retry after 3',
    });

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    const tick = await stack.broadcast.processTick();

    expect(tick.rateLimited).toBe(true);

    const [recipient] = recipientsOf(stack, prepared.value.reference);

    expect(recipient?.status).toBe('PENDING');
    expect(recipient?.attemptCount).toBe(0);
    expect(stack.broadcast.list(1)[0]?.status).toBe('RUNNING');

    // A later tick (after the back-off) delivers normally.
    stack.harness.platform.client.sendMessage.mockClear();

    const retryTick = await stack.broadcast.processTick(
      new Date(Date.now() + 60_000),
    );

    expect(retryTick.sent).toBe(1);
    expect(recipientsOf(stack, prepared.value.reference)[0]?.status).toBe(
      'SENT',
    );
  });

  it('schedules a retry for a transient failure, then delivers within the attempt budget', async () => {
    const stack = await build({ ADMIN_BROADCAST_MAX_ATTEMPTS: '2' }, [
      { id: '1' },
    ]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    stack.harness.platform.failSends(1);

    const first = await stack.broadcast.processTick();

    expect(first.retryScheduled).toBe(1);

    const second = await stack.broadcast.processTick(
      new Date(Date.now() + 5_000),
    );

    expect(second.sent).toBe(1);
    expect(recipientsOf(stack, prepared.value.reference)[0]?.attemptCount).toBe(
      2,
    );
  });

  it('gives up after the configured attempts and reports the failure truthfully', async () => {
    const stack = await build({ ADMIN_BROADCAST_MAX_ATTEMPTS: '1' }, [
      { id: '1' },
    ]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    stack.harness.platform.failSends(1);

    const tick = await stack.broadcast.processTick();

    expect(tick.failed).toBe(1);

    const report = stack.broadcast.report(prepared.value.reference);

    expect(report?.totals.FAILED).toBe(1);
    expect(report?.totals.SENT).toBe(0);
    // Nothing was accepted: the job is closed as FAILED — never as a successful broadcast.
    expect(stack.broadcast.list(1)[0]?.status).toBe('FAILED');
    expect(stack.broadcast.list(1)[0]?.completedAt).toBeTruthy();
  });

  it('records an unanswered request as UNKNOWN and never retries it automatically', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    stack.harness.platform.throwSends(1);

    const tick = await stack.broadcast.processTick();

    expect(tick.unknown).toBe(1);
    expect(recipientsOf(stack, prepared.value.reference)[0]?.status).toBe(
      'UNKNOWN',
    );

    await stack.broadcast.processTick(new Date(Date.now() + 120_000));

    expect(
      stack.harness.platform.calls.filter((call) => call.kind === 'send'),
    ).toHaveLength(1);
    expect(
      stack.broadcast.report(prepared.value.reference)?.notes.join(' '),
    ).toContain('UNKNOWN یعنی');
  });

  it('re-sends only the terminally failed recipients, bounded by the manual retry budget', async () => {
    const stack = await build(
      {
        ADMIN_BROADCAST_MAX_ATTEMPTS: '1',
        ADMIN_BROADCAST_MAX_MANUAL_RETRIES: '1',
      },
      [{ id: '1' }, { id: '2' }],
    );
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    stack.harness.platform.failSends(1);

    await stack.broadcast.processTick();

    const [first, second] = recipientsOf(stack, prepared.value.reference);

    expect([first?.status, second?.status].sort()).toEqual(['FAILED', 'SENT']);

    const retried = await stack.broadcast.retry(
      prepared.value.reference,
      OWNER,
    );

    expect(retried.ok && retried.value.requeued).toBe(1);
    expect(stack.broadcast.list(1)[0]?.status).toBe('RUNNING');

    await stack.broadcast.processTick(new Date(Date.now() + 5_000));

    const afterRetry = recipientsOf(stack, prepared.value.reference);

    expect(afterRetry.filter((row) => row.status === 'SENT')).toHaveLength(2);

    const exhausted = await stack.broadcast.retry(
      prepared.value.reference,
      OWNER,
    );

    expect(exhausted).toMatchObject({ ok: false, code: 'LIMIT_EXCEEDED' });
  });

  it('refuses to retry a broadcast that is still running', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);

    expect(
      await stack.broadcast.retry(prepared.value.reference, OWNER),
    ).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    });
  });

  it('reports an unknown reference instead of inventing a report', async () => {
    const stack = await build({}, [{ id: '1' }]);

    expect(stack.broadcast.report('BR-000000')).toBeNull();
    expect(await stack.broadcast.confirm('BR-000000', OWNER)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await stack.broadcast.cancel('BR-000000', OWNER)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  });
});

describe('phase 10 — cancellation prevents the remaining sends (§11.5)', () => {
  it('skips every pending recipient and sends nothing', async () => {
    const stack = await build({}, [{ id: '1' }, { id: '2' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    const cancelled = await stack.broadcast.cancel(
      prepared.value.reference,
      OWNER,
    );

    expect(cancelled.ok && cancelled.value.skipped).toBe(2);
    expect(stack.broadcast.list(1)[0]?.status).toBe('CANCELLED');
    expect(stack.sends()).toHaveLength(0);

    const tick = await stack.broadcast.processTick();

    expect(tick.processed).toBe(0);
    expect(stack.sends()).toHaveLength(0);
    expect(
      stack.broadcast.report(prepared.value.reference)?.notes.join(' '),
    ).toContain('لغو');
  });

  it('stops a running broadcast and leaves the already-sent recipients untouched', async () => {
    const stack = await build({ ADMIN_BROADCAST_BATCH_SIZE: '1' }, [
      { id: '1' },
      { id: '2' },
    ]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    await stack.broadcast.processTick();

    const cancelled = await stack.broadcast.cancel(
      prepared.value.reference,
      OWNER,
    );
    const report = stack.broadcast.report(prepared.value.reference);

    expect(cancelled.ok && cancelled.value.skipped).toBe(1);
    expect(report?.totals.SENT).toBe(1);
    expect(report?.totals.SKIPPED).toBe(1);
    expect(stack.sends()).toHaveLength(1);
  });

  it('refuses to cancel a finished broadcast', async () => {
    const stack = await build({}, [{ id: '1' }]);
    const prepared = await stack.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await stack.broadcast.confirm(prepared.value.reference, OWNER);
    await stack.broadcast.processTick();

    expect(
      await stack.broadcast.cancel(prepared.value.reference, OWNER),
    ).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    });
  });
});

describe('phase 10 — the broadcast record survives a restart (§11.6, §15)', () => {
  it('keeps the job, its recipients and their outcomes on disk and resumes only what is pending', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/admin-broadcast-${Date.now()}`;

    const first = await build(
      { ADMIN_DATA_FILE: `${dir}/admin.json`, ADMIN_BROADCAST_BATCH_SIZE: '1' },
      [{ id: '1' }, { id: '2' }],
    );
    const prepared = await first.broadcast.prepare({
      actor: OWNER,
      text: 'سلام',
      audience: audience('ALL'),
    });

    if (!prepared.ok) {
      throw new Error(prepared.message);
    }

    await first.broadcast.confirm(prepared.value.reference, OWNER);
    await first.broadcast.processTick();

    expect(first.sends()).toHaveLength(1);

    // A brand-new stack reading the same document = a process restart.
    const restarted = await build({ ADMIN_DATA_FILE: `${dir}/admin.json` }, []);

    expect(restarted.broadcast.list(1)[0]?.status).toBe('RUNNING');
    expect(
      recipientsOf(restarted, prepared.value.reference).filter(
        (row) => row.status === 'SENT',
      ),
    ).toHaveLength(1);

    const tick = await restarted.broadcast.processTick(
      new Date(Date.now() + 5_000),
    );

    expect(tick.sent + tick.failed + tick.unknown).toBe(1);
    expect(restarted.sends()).toHaveLength(1);
    expect(restarted.broadcast.list(1)[0]?.status).toBe('COMPLETED');
    expect(
      recipientsOf(restarted, prepared.value.reference).filter(
        (row) => row.status === 'SENT',
      ),
    ).toHaveLength(2);
  });
});

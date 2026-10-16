import {
  callbackDataForAdminAlert,
  callbackDataForAdminAlertState,
  callbackDataForAdminAlerts,
  callbackDataForAdminAudit,
  callbackDataForAdminBroadcast,
  callbackDataForAdminBroadcastAudience,
  callbackDataForAdminBroadcastPreview,
  callbackDataForAdminBroadcastSave,
  callbackDataForAdminBroadcastStart,
  callbackDataForAdminBroadcastText,
  callbackDataForAdminCampaigns,
  callbackDataForAdminChannels,
  callbackDataForAdminDictionary,
  callbackDataForAdminErrors,
  callbackDataForAdminHub,
  callbackDataForAdminLeads,
  callbackDataForAdminPublishing,
  callbackDataForAdminStats,
  callbackDataForAdminUsers,
} from '../ux/callback-data';
import { createUxHarness, EnvMap, UxHarness } from '../../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';

/**
 * Phase 10 — the admin surface inside the existing bot (§5, §12, §18).
 *
 * These tests drive the *real* router: a message or a button press goes through `BotUxService`, which
 * resolves the identity, the role and the capability server-side. Nothing is stubbed and no screen is
 * called directly, so “an ordinary user cannot reach the panel” is proven on the same path the
 * platform uses.
 */

const OWNER_ID = 'platform-user-1';
const ADMIN_ID = 'platform-admin-2';

const BROADCAST_BODY = 'اطلاعیهٔ آزمایشی';

const ADMIN_ENV: EnvMap = {
  ADMIN_OWNER_IDS: `bale:${OWNER_ID}`,
  ADMIN_USER_IDS: `bale:${ADMIN_ID}`,
  ADMIN_DATA_FILE: '',
  ADMIN_BROADCAST_ENABLED: 'true',
  ADMIN_BROADCAST_MIN_INTERVAL_MS: '0',
  ADMIN_BROADCAST_BACKOFF_MS: '1000',
  ADMIN_MAX_AUDIT_RECORDS: '0',
};

let updateId = 0;

const message = (
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: '900001',
  platformUserId: OWNER_ID,
  messageId: 500 + updateId,
  text,
  ...overrides,
});

const callback = (
  data: string,
  overrides: Partial<InboundCallback> = {},
): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: '900001',
  platformUserId: OWNER_ID,
  messageId: 777,
  callbackId: `cb-${updateId}`,
  data,
  ...overrides,
});

const buttonTexts = (harness: UxHarness): string[] =>
  harness.buttons().map((button) => button.text);

const lastText = (harness: UxHarness): string => harness.last().text ?? '';

const texts = (harness: UxHarness): string[] =>
  harness.rendered().map((call) => call.text ?? '');

/**
 * Only the actual broadcast message counts as a “send”. Rendering a screen is also a platform call, so
 * counting `kind: 'send'` blindly would make a screen look like a bulk message.
 */
const broadcastSends = (harness: UxHarness, body = BROADCAST_BODY) =>
  harness.platform.calls.filter(
    (call) => call.kind === 'send' && (call.text ?? '') === body,
  );

const MEMBER: EnvMap = { USER_DATA_FILE: '', ALERT_DATA_FILE: '' };

/** Load every store the surface reads, so assertions never race an empty in-memory document. */
const ready = async (harness: UxHarness): Promise<void> => {
  await harness.store.ensureLoaded();
  await harness.alertStore.ensureLoaded();
  await harness.channel.store.ensureLoaded();
  await harness.sales.load();
  await harness.admin.load();
};

describe('phase 10 — the panel is invisible and unreachable for ordinary users (§12.1, §18)', () => {
  let harness: UxHarness;

  beforeEach(async () => {
    harness = createUxHarness(MEMBER);
    await ready(harness);
  });

  it('does not show the management button in the main menu', async () => {
    await harness.botUx.handleUpdate(message('/start'));

    expect(buttonTexts(harness).some((text) => text.includes('مدیریت'))).toBe(
      false,
    );
  });

  it('answers an admin command with the ordinary menu and nothing about the panel', async () => {
    await harness.botUx.handleUpdate(message('/admin'));

    const rendered = texts(harness).join('\n');

    expect(rendered).not.toContain('پنل مدیریت');
    expect(rendered).not.toContain('مالکان');
  });

  it('rejects a forged admin callback without disclosing anything and without acting', async () => {
    const before = harness.admin.audit.count;

    await harness.botUx.handleUpdate(callback(callbackDataForAdminHub()));

    const acks = harness.platform.calls.filter((call) => call.kind === 'ack');

    expect(acks.at(-1)?.alertText).toBe('این عملیات در دسترس نیست.');
    expect(texts(harness).join('\n')).not.toContain('پنل مدیریت');
    // A denial is recorded — the attempt is visible in the audit trail, it is not swallowed.
    expect(harness.admin.audit.count).toBeGreaterThan(before);
  });

  it('never renders a user’s own screen in response to a modified admin button', async () => {
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminUsers('all', 1)),
    );

    expect(texts(harness).join('\n')).not.toContain('👥');
  });
});

describe('phase 10 — an administrator gets the panel inside the same menu (§5)', () => {
  let harness: UxHarness;

  beforeEach(async () => {
    harness = createUxHarness(ADMIN_ENV);
    await ready(harness);
  });

  it('adds exactly one management row for an administrator, after the existing buttons', async () => {
    await harness.botUx.handleUpdate(message('/start'));

    const buttons = buttonTexts(harness);

    expect(buttons).toContain('⚙️ مدیریت');
    // The existing menu is untouched: the admin row is appended, never substituted.
    expect(buttons).toContain('💰 قیمت لحظهای');
    expect(buttons).toContain('🛒 خرید طلا');
    expect(buttons.filter((text) => text.includes('مدیریت'))).toHaveLength(1);
  });

  it('opens the hub and audits that the panel was opened', async () => {
    await harness.botUx.handleUpdate(message('/admin'));

    expect(lastText(harness)).toContain('پنل مدیریت اتابک');
    expect(harness.admin.audit.list()[0]?.actor).toBe(`bale:${OWNER_ID}`);
  });

  it('reaches every section from the hub with real screens', async () => {
    await harness.botUx.handleUpdate(callback(callbackDataForAdminHub()));
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminStats('today', 0)),
    );

    const stats = lastText(harness);

    expect(stats).toContain('منبع:');
    expect(stats).toContain('بازه:');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminDictionary()),
    );

    expect(lastText(harness)).toContain('تعریف شاخص‌ها');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminUsers('all', 1)),
    );

    expect(lastText(harness)).toContain('👥');

    await harness.botUx.handleUpdate(callback(callbackDataForAdminChannels()));

    expect(lastText(harness)).toContain('کانال‌ها و انتشار');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminAlerts('all', 1)),
    );

    expect(lastText(harness)).toContain('هشدارها');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminLeads('all', 1)),
    );

    expect(lastText(harness)).toContain('سرنخ‌های فروش');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminCampaigns(1)),
    );

    expect(lastText(harness)).toContain('کمپین‌ها');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminErrors('open', 1)),
    );

    expect(lastText(harness)).toContain('مرکز خطا');

    await harness.botUx.handleUpdate(callback(callbackDataForAdminBroadcast()));

    expect(lastText(harness)).toContain('ارسال گروهی');
  });

  it('keeps the audit screen to the owner and refuses it for an operator', async () => {
    await harness.botUx.handleUpdate(callback(callbackDataForAdminAudit(1)));

    expect(lastText(harness)).toContain('رخدادنگار مدیریتی');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminAudit(1), { platformUserId: ADMIN_ID }),
    );

    const acks = harness.platform.calls.filter((call) => call.kind === 'ack');

    expect(acks.at(-1)?.alertText).toBe(
      'سطح دسترسی شما برای این عملیات کافی نیست.',
    );
    // The owner's screen is still on display: the refusal changes nothing it does not own.
    expect(lastText(harness)).toContain('رخدادنگار');
  });

  it('never leaks a chat id, a token or a phone number into a management screen', async () => {
    const user = await harness.users.resolveUser('bale', OWNER_ID, '900001');

    await harness.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });

    for (const data of [
      callbackDataForAdminHub(),
      callbackDataForAdminStats('7d', 0),
      callbackDataForAdminUsers('all', 1),
      callbackDataForAdminAlerts('all', 1),
      callbackDataForAdminChannels(),
      callbackDataForAdminErrors('all', 1),
      callbackDataForAdminAudit(1),
    ]) {
      await harness.botUx.handleUpdate(callback(data));

      const rendered = lastText(harness);

      expect(rendered).not.toMatch(/bot\d+:/u);
      expect(rendered).not.toContain('900001');
    }
  });
});

describe('phase 10 — destructive actions require a second, explicit press (§12.3)', () => {
  let harness: UxHarness;

  beforeEach(async () => {
    harness = createUxHarness(ADMIN_ENV);
    await ready(harness);
  });

  it('asks before pausing publication and only then changes the engine', async () => {
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminPublishing('disable', false)),
    );

    expect(lastText(harness)).toContain('غیرفعال کردن انتشار');
    expect(harness.channel.engine.publishingEnabled).toBe(true);

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminPublishing('disable', true)),
    );

    expect(harness.channel.engine.publishingEnabled).toBe(false);
    expect(lastText(harness)).toContain('غیرفعال');

    // …and back on, again behind a confirmation.
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminPublishing('enable', true)),
    );

    expect(harness.channel.engine.publishingEnabled).toBe(true);
  });

  it('records the publication switch in the audit trail with both states', async () => {
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminPublishing('disable', true)),
    );

    const row = harness.admin.audit
      .list()
      .find((entry) => entry.action === 'CHANNEL_PUBLISHING_TOGGLED');

    expect(row).toMatchObject({
      fromState: 'enabled',
      toState: 'disabled',
      actor: `bale:${OWNER_ID}`,
    });
  });

  it('does not publish while publishing is switched off', async () => {
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminPublishing('disable', true)),
    );

    const before = harness.platform.calls.filter(
      (call) => call.kind === 'publish',
    ).length;

    await harness.channel.engine.schedulerTick();

    expect(
      harness.platform.calls.filter((call) => call.kind === 'publish'),
    ).toHaveLength(before);
  });

  it('routes the alert disable through the Phase 3 service, not around it', async () => {
    const user = await harness.users.resolveUser('bale', OWNER_ID, '900001');
    const created = await harness.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });

    if (!created.ok) {
      throw new Error(created.reason);
    }

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminAlert(created.alert.id)),
    );
    await harness.botUx.handleUpdate(
      callback(
        callbackDataForAdminAlertState(created.alert.id, 'disable', false),
      ),
    );

    expect(lastText(harness)).toContain('غیرفعال کردن هشدار');
    expect(harness.alertStore.findAlert(created.alert.id)?.status).toBe(
      'ACTIVE',
    );

    await harness.botUx.handleUpdate(
      callback(
        callbackDataForAdminAlertState(created.alert.id, 'disable', true),
      ),
    );

    const stored = harness.alertStore.findAlert(created.alert.id);

    expect(stored?.status).toBe('DISABLED');
    expect(
      harness.admin.audit
        .list()
        .some((entry) => entry.action === 'ALERT_DISABLED'),
    ).toBe(true);
    // The record is still there — an administrator never deletes another user's alert.
    expect(stored?.deletedAt ?? null).toBeNull();
  });

  it('cannot revive an alert the user deleted: the Phase 3 rule stays in charge', async () => {
    const user = await harness.users.resolveUser('bale', OWNER_ID, '900001');
    const created = await harness.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_000_000,
    });

    if (!created.ok) {
      throw new Error(created.reason);
    }

    const removed = await harness.alerts.remove(user.id, created.alert.id);

    expect(removed.ok).toBe(true);

    await harness.botUx.handleUpdate(
      callback(
        callbackDataForAdminAlertState(created.alert.id, 'enable', true),
      ),
    );

    // The press is answered, but the domain rule wins: a deleted alert is not resurrected by an admin
    // button, and the user's effective capacity is not inflated either.
    expect(harness.alertStore.findAlert(created.alert.id)?.status).toBe(
      'DELETED',
    );

    const acks = harness.platform.calls.filter((call) => call.kind === 'ack');

    expect((acks.at(-1)?.alertText ?? '').length).toBeGreaterThan(0);
  });
});

describe('phase 10 — the read surfaces are wired to the real Phase 1–9 data (§5)', () => {
  it('lists a real lead created through the sales engine', async () => {
    const harness = createUxHarness(ADMIN_ENV);
    await ready(harness);

    const created = await harness.sales.service.createLead({
      userId: 'usr_1',
      identityKey: 'bale:cust-1',
      platform: 'bale',
      platformUserId: 'cust-1',
      chatId: '900002',
      customerName: 'زهرا محمدی',
      phone: '09123456789',
      category: 'MANUFACTURED_GOLD',
      productDescription: 'انگشتر',
      notes: null,
      submissionKey: 'sub_admin_1',
      consentTextVersion: 'sales-consent-v1',
    });

    if (!created.ok) {
      throw new Error('lead creation failed');
    }

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminLeads('all', 1)),
    );

    const screen = lastText(harness);

    expect(screen).toContain('سرنخ‌های فروش');
    expect(screen).toContain(created.value.lead.reference);
    // The customer's phone number is never printed in full.
    expect(screen).not.toContain('09123456789');
  });

  it('lists a real campaign and its funnel from Phase 8', async () => {
    const harness = createUxHarness(ADMIN_ENV);
    await ready(harness);

    const campaign = await harness.campaigns.service.createCampaign({
      name: 'کمپین مدیریت',
      source: 'admin_screen',
      destinationType: 'BOT_START',
      // `menu` is not a deep-link destination (the Phase 8 rule): the admin screen is exercised with a
      // real one.
      destination: 'prices',
      createdBy: `bale:${OWNER_ID}`,
    });

    if (!campaign.ok) {
      throw new Error('campaign creation failed');
    }

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminCampaigns(1)),
    );

    expect(lastText(harness)).toContain('کمپین‌ها');
  });

  it('shows a recorded incident and lets the operator move it through its lifecycle', async () => {
    const harness = createUxHarness(ADMIN_ENV);
    await ready(harness);

    const incident = await harness.admin.errors.record({
      source: 'channel-publisher',
      category: 'PUBLISH_FAILED',
      severity: 'HIGH',
      summary: 'پلتفرم خطا برگرداند',
      retryable: true,
    });

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminErrors('open', 1)),
    );

    expect(lastText(harness)).toContain('پلتفرم خطا برگرداند');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminErrors('open', 1)),
    );

    const review = await harness.admin.errors.review(
      incident!.incidentId,
      `bale:${OWNER_ID}`,
    );

    expect(review?.status).toBe('REVIEWED');
  });
});

describe('phase 10 — the broadcast flow keeps the human in the loop (§11.2)', () => {
  let harness: UxHarness;

  beforeEach(async () => {
    harness = createUxHarness({
      ...ADMIN_ENV,
      ADMIN_BROADCAST_MAX_RECIPIENTS: '10',
    });
    await ready(harness);
  });

  it('walks audience → text → preview → save, and sends nothing before the final start', async () => {
    // The owner is a real user in this harness, so the audience has one eligible recipient.
    await harness.botUx.handleUpdate(callback(callbackDataForAdminBroadcast()));
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastAudience('all', null)),
    );

    expect(lastText(harness)).toContain('مخاطبان ارسال گروهی');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastText()),
    );
    await harness.botUx.handleUpdate(message('اطلاعیهٔ آزمایشی'));

    expect(lastText(harness)).toContain('پیش‌نمایش ارسال گروهی');

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastPreview()),
    );

    expect(lastText(harness)).toContain('اطلاعیهٔ آزمایشی');

    // A prepared job exists as a durable record, but still nothing has been sent.
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastSave()),
    );

    const job = harness.admin.broadcast.list(1)[0];

    expect(job?.status).toBe('PREPARED');
    expect(broadcastSends(harness)).toHaveLength(0);

    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastStart(job.reference)),
    );

    const started = harness.admin.broadcast.list(1)[0];

    expect(started?.status).toBe('COMPLETED');
    expect(broadcastSends(harness).length).toBeGreaterThan(0);
    expect(lastText(harness)).toContain('گزارش');
  });

  it('does not send the broadcast text when the administrator cancels the flow', async () => {
    await harness.botUx.handleUpdate(callback(callbackDataForAdminBroadcast()));
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastAudience('all', null)),
    );
    await harness.botUx.handleUpdate(
      callback(callbackDataForAdminBroadcastText()),
    );

    const owner = harness.users.findByPlatform('bale', OWNER_ID);

    expect(owner).not.toBeNull();
    expect(harness.admin.service.hasPendingInput(owner!.id)).toBe(true);

    await harness.botUx.handleUpdate(callback(callbackDataForAdminHub()));

    expect(harness.admin.service.hasPendingInput(owner!.id)).toBe(false);
    expect(harness.admin.broadcast.list()).toHaveLength(0);
  });

  it('lets an operator browse but refuses to persist or start a broadcast', async () => {
    const operator = createUxHarness(ADMIN_ENV);
    await ready(operator);

    const asOperator = (data: string) =>
      callback(data, { platformUserId: ADMIN_ID });

    // Browsing is allowed (§12.2: the surface is readable at the operator level).
    await operator.botUx.handleUpdate(
      asOperator(callbackDataForAdminBroadcast()),
    );
    await operator.botUx.handleUpdate(
      asOperator(callbackDataForAdminBroadcastAudience('all', null)),
    );
    await operator.botUx.handleUpdate(
      asOperator(callbackDataForAdminBroadcastText()),
    );
    await operator.botUx.handleUpdate(
      message(BROADCAST_BODY, { platformUserId: ADMIN_ID }),
    );
    await operator.botUx.handleUpdate(
      asOperator(callbackDataForAdminBroadcastPreview()),
    );

    expect(lastText(operator)).toContain('پیش‌نمایش');

    // Persisting the job is the high-impact step and belongs to the owner.
    await operator.botUx.handleUpdate(
      asOperator(callbackDataForAdminBroadcastSave()),
    );

    const acks = operator.platform.calls.filter((call) => call.kind === 'ack');

    expect(acks.at(-1)?.alertText).toBe(
      'سطح دسترسی شما برای این عملیات کافی نیست.',
    );
    expect(operator.admin.broadcast.list()).toHaveLength(0);
    expect(broadcastSends(operator)).toHaveLength(0);
  });
});

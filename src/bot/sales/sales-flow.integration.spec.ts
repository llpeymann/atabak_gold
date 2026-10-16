import { InboundCallback, InboundMessage } from '../../platform/platform.types';
import {
  createUxHarness,
  EnvMap,
  keyboardButtons,
  UxHarness,
} from '../../testing/test-doubles';
import { callbackDataForScreen } from '../ux/callback-data';

/**
 * Phase 9 — the whole purchase + follow-up journey through the real router (§17 integration).
 *
 * The keyboard, the form, the validation, the durable store, the notification outbox, the admin
 * surface and the Phase 8 conversion rows all run for real; only the platform transport is doubled.
 * The two properties that make the sales numbers trustworthy are asserted on every write path:
 * a request is reported as registered **only** after it was persisted, and a repeated press never
 * becomes a second lead / second message.
 */

const CUSTOMER = 'cust-bale-1';
const CUSTOMER_CHAT = 'chat-cust-1';
const ADMIN = 'admin-bale-1';
const ADMIN_CHAT = 'chat-admin-1';

const ENV: EnvMap = {
  SALES_ENGINE_ENABLED: 'true',
  SALES_DATA_FILE: '',
  SALES_NOTIFICATION_MAX_ATTEMPTS: '2',
  SALES_NOTIFICATION_RETRY_DELAY_MS: '0',
  SALES_MAX_OPEN_LEADS_PER_IDENTITY: '5',
  SALES_ADMIN_USER_IDS: `bale:${ADMIN}`,
  CHANNEL_ADMIN_USER_IDS: `bale:${ADMIN}`,
  BOT_POLLING_ENABLED: 'false',
};

let updateId = 0;

const message = (
  text: string,
  platformUserId = CUSTOMER,
  chatId = CUSTOMER_CHAT,
): InboundMessage => ({
  kind: 'message',
  updateId: (updateId += 1),
  platform: 'bale',
  chatId,
  platformUserId,
  messageId: 5_000 + updateId,
  text,
});

const callbackFor = (
  data: string,
  platformUserId = CUSTOMER,
  chatId = CUSTOMER_CHAT,
): InboundCallback => ({
  kind: 'callback',
  updateId: (updateId += 1),
  platform: 'bale',
  chatId,
  platformUserId,
  messageId: 7_000 + updateId,
  callbackId: `cb-${updateId}`,
  data,
});

describe('sales flow (integration)', () => {
  let harness: UxHarness;

  const build = async (env: EnvMap = {}): Promise<void> => {
    harness = createUxHarness({ ...ENV, ...env });
    await harness.sales.load();
  };

  beforeEach(async () => {
    await build();
  });

  const send = async (
    text: string,
    platformUserId = CUSTOMER,
    chatId = CUSTOMER_CHAT,
  ): Promise<void> => {
    await harness.botUx.handleUpdate(message(text, platformUserId, chatId));
  };

  const press = async (
    data: string,
    platformUserId = CUSTOMER,
    chatId = CUSTOMER_CHAT,
  ): Promise<void> => {
    await harness.botUx.handleUpdate(callbackFor(data, platformUserId, chatId));
  };

  /** Buttons of the newest rendered message that carries a keyboard. */
  const buttons = (): { text: string; callbackData?: string }[] => {
    const withKeyboard = harness
      .rendered()
      .filter((call) => keyboardButtons(call).length > 0);
    const last = withKeyboard.at(-1);

    return last ? keyboardButtons(last) : [];
  };

  const textOf = (label: string | null = null): string => {
    if (label === null) {
      return harness.last().text ?? '';
    }

    const match = harness
      .rendered()
      .find((call) => (call.text ?? '').includes(label));

    return match?.text ?? '';
  };

  const allTexts = (): string =>
    harness
      .rendered()
      .map((call) => call.text ?? '')
      .join('\n---\n');

  const buttonData = (label: string): string => {
    const button = buttons().find((candidate) =>
      candidate.text.includes(label),
    );

    if (!button?.callbackData) {
      throw new Error(`no button matching "${label}" in the newest keyboard`);
    }

    return button.callbackData;
  };

  const leads = () => harness.sales.store.listLeads();
  const sendCount = () =>
    harness.platform.calls.filter((call) => call.kind === 'send').length;

  /** Walk the whole form and stop on the confirmation screen. */
  const fillForm = async (
    options: { name?: string; phone?: string } = {},
  ): Promise<void> => {
    await send(options.name ?? 'زهرا محمدی');
    await send(options.phone ?? '۰۹۱۲۳۴۵۶۷۸۹');
    await send('انگشتر طلا سایز ۵۲');
    await send('بعد از ساعت ۱۷ تماس بگیرید');
  };

  // --- entry point --------------------------------------------------------------------------

  it('shows the purchase entry in the main menu without dropping any existing item', async () => {
    await send('/start');
    // The menu screen (`🏠 منوی اصلی`) is where the entries live.
    await press('v1:home');

    const labels = buttons().map((button) => button.text);

    expect(labels).toContain('🛒 خرید طلا');
    expect(textOf()).toContain('🛒 خرید طلا');
    // Phase 2/4/6/7 entries are untouched.
    // Substrings avoid the invisible-character traps of Persian composite words on purpose.
    expect(labels.some((label) => label.includes('قیمت لحظ'))).toBe(true);
    expect(labels.some((label) => label.includes('سکه'))).toBe(true);
    expect(labels.some((label) => label.includes('کانال'))).toBe(true);
    expect(labels.some((label) => label.includes('دعوت از دوستان'))).toBe(true);
  });

  it('opens the category list with the market reference price of the validated state', async () => {
    await send('/start');
    await press(callbackDataForScreen('sales'));

    const hub = textOf();

    expect(hub).toContain('استعلام قیمت');
    // The flow states explicitly that a request is not an order or a reservation.
    expect(hub).toContain('سفارش یا رزرو نیست');
    expect(buttons().map((button) => button.text)).toEqual(
      expect.arrayContaining(['🥇 طلای ساخته', '🟡 طلای آب‌شده', '🪙 سکه']),
    );

    await press(buttonData('🥇 طلای ساخته'));

    const category = textOf();

    expect(category).toContain('قیمت مرجع');
    expect(category).toContain('قیمت نهایی');
  });

  // --- the form -----------------------------------------------------------------------------

  it('registers the request only after the confirmation, and reports the stored code', async () => {
    await send('/buy');
    await press(buttonData('🪙 سکه'));
    await fillForm();

    // Nothing is stored while the form is open.
    expect(leads()).toHaveLength(0);

    const review = textOf();

    expect(review).toContain('زهرا محمدی');
    expect(review).toContain('۰۹۱۲');
    expect(review).toContain('با زدن دکمهٔ «تأیید و ثبت درخواست»');

    await press(buttonData('✅ تأیید و ثبت درخواست'));
    // Delivery is dispatched in the background on purpose (a slow platform must never delay the
    // customer's answer), so the test waits for it exactly like shutdown does.
    await harness.sales.notifications.drain();

    expect(leads()).toHaveLength(1);
    const lead = leads()[0];

    // The phone is stored in one canonical form, and the record never claims verification.
    expect(lead.phone).toBe('+989123456789');
    expect(lead.phoneVerified).toBe(false);
    expect(lead.consentTextVersion).toBe('sales-consent-v1');
    expect(lead.consentedAt).not.toBeNull();

    // The customer gets the confirmation with the *stored* tracking code…
    expect(allTexts()).toContain(lead.reference);
    expect(allTexts()).toContain('کارشناسان طلای اتابک');

    // …and the authorized administrator gets the notification with the request data.
    const adminText = harness
      .rendered()
      .map((call) => call.text ?? '')
      .find((text) => text.includes('درخواست استعلام جدید'));

    expect(adminText).toBeDefined();
    expect(adminText).toContain(lead.reference);
    expect(adminText).toContain('🪙 سکه');
  });

  it('never creates a second lead when the confirmation is pressed twice', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await fillForm();

    const confirm = buttonData('✅ تأیید و ثبت درخواست');
    const before = sendCount();

    await press(confirm);
    await press(confirm);

    expect(leads()).toHaveLength(1);

    // The second press resolves to the same stored request: no second confirmation message either.
    const afterFirst = before;
    const confirmations = harness
      .rendered()
      .map((call) => call.text ?? '')
      .filter((text) => text.includes('درخواست شما با کد پیگیری'));

    expect(confirmations).toHaveLength(1);
    expect(sendCount()).toBeGreaterThan(afterFirst);
  });

  it('treats a stale confirmation button as expired and stores nothing', async () => {
    await send('/start');
    await press(callbackDataForScreen('sales'));
    await press('v1:sales:confirm');

    expect(leads()).toHaveLength(0);
    expect(textOf()).toContain('این فرم دیگر فعال نیست');
  });

  it('abandons the form when the customer cancels or sends a command', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await send('زهرا محمدی');

    await press(buttonData('❌ لغو درخواست'));

    expect(leads()).toHaveLength(0);
    expect(textOf()).toContain('لغو شد');

    // Starting again works, and a command in the middle of a form leaves no half-finished state.
    await press(buttonData('🥇 طلای ساخته'));
    await send('/start');
    await press('v1:sales:confirm');

    expect(leads()).toHaveLength(0);
  });

  it('refuses an impossible phone number instead of storing it', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await send('زهرا محمدی');
    await send('۱۲۳۴۵');

    expect(textOf()).toContain('شماره تماس باید ۱۰ رقم');
    expect(leads()).toHaveLength(0);

    await send('۰۹۱۲۳۴۵۶۷۸۹');
    await send('بدون توضیح');
    await send('-'); // an optional note that is only a dash is still a valid answer
    await press(buttonData('✅ تأیید و ثبت درخواست'));

    expect(leads()).toHaveLength(1);
    expect(leads()[0].phone).toBe('+989123456789');
  });

  it('keeps the request when the confirmation message cannot be delivered', async () => {
    await send('/buy');
    await press(buttonData('🟡 طلای آب‌شده'));
    await fillForm({ name: 'مریم رضایی' });

    // The next send fails: that is the confirmation message of the stored request.
    harness.platform.failSends(1);
    await press(buttonData('✅ تأیید و ثبت درخواست'));
    await harness.sales.notifications.drain();

    // The lead is stored…
    expect(leads()).toHaveLength(1);

    // …and the undelivered message is retried inside the attempt budget, with one row per recipient.
    const rows = harness.sales.notifications.listNotifications();

    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.attemptCount > 1)).toBe(true);
  });

  it('answers the tracking screen with the customer’s own requests only', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await fillForm();
    await press(buttonData('✅ تأیید و ثبت درخواست'));
    await harness.sales.notifications.drain();

    const reference = leads()[0].reference;

    await send('/buy');
    await press(buttonData('🔎 پیگیری درخواست‌های من'));

    const tracking = textOf();

    expect(tracking).toContain(reference);
    // Another identity never sees this request.
    await send('/buy', 'cust-bale-2', 'chat-cust-2');
    await press(
      buttonData('🔎 پیگیری درخواست‌های من'),
      'cust-bale-2',
      'chat-cust-2',
    );

    expect(textOf()).toContain('هنوز درخواستی ثبت نکرده‌اید');
  });

  // --- operator surface ---------------------------------------------------------------------

  it('does not disclose the lead surface to a non-admin', async () => {
    await send('/sales');

    // The non-admin gets the ordinary menu and no lead data.
    expect(textOf()).toContain('منوی اصلی');
    expect(allTexts()).not.toContain('درخواست‌های استعلام');
  });

  it('lets an authorized operator work a lead end to end', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await fillForm();
    await press(buttonData('✅ تأیید و ثبت درخواست'));
    await harness.sales.notifications.drain();

    const lead = leads()[0];

    await send('/sales', ADMIN, ADMIN_CHAT);

    expect(textOf()).toContain('درخواست‌های استعلام');
    expect(textOf()).toContain(lead.reference);

    await press(buttonData(lead.reference), ADMIN, ADMIN_CHAT);

    const detail = textOf();

    expect(detail).toContain(lead.customerName);
    expect(detail).toContain('نامشخص'); // no campaign: reported as unknown, never invented

    // Contact attempt, note, assignment and the status machine.
    await press(buttonData('📞 ثبت تماس'), ADMIN, ADMIN_CHAT);
    expect(harness.sales.service.findLead(lead.leadId)?.contactAttempts).toBe(
      1,
    );

    await press(buttonData('🗒 یادداشت'), ADMIN, ADMIN_CHAT);
    await send('مشتری در سفر است', ADMIN, ADMIN_CHAT);
    expect(
      harness.sales.service
        .listActivities(lead.leadId)
        .some((row) => row.action === 'NOTE_ADDED'),
    ).toBe(true);

    await press(buttonData('👤 واگذاری'), ADMIN, ADMIN_CHAT);
    await press(buttonData(ADMIN), ADMIN, ADMIN_CHAT);
    expect(harness.sales.service.findLead(lead.leadId)?.assignedTo).toBe(
      `bale:${ADMIN}`,
    );

    await press(buttonData('➡️ تماس گرفته‌شده'), ADMIN, ADMIN_CHAT);
    expect(harness.sales.service.findLead(lead.leadId)?.status).toBe(
      'CONTACTED',
    );

    await press(buttonData('➡️ بررسی‌شده'), ADMIN, ADMIN_CHAT);
    await press(buttonData('✅ تبدیل به مشتری'), ADMIN, ADMIN_CHAT);
    await press(buttonData('✅ بله، مشتری شد'), ADMIN, ADMIN_CHAT);

    expect(harness.sales.service.findLead(lead.leadId)?.status).toBe(
      'CONVERTED',
    );
    expect(
      harness.campaigns.conversions
        .listConversions({})
        .filter((row) => row.type === 'CUSTOMER'),
    ).toHaveLength(1);

    // A sale is recorded by an explicit operator action, with an explicit unit.
    await press(buttonData('🛒 ثبت فروش بدون مبلغ'), ADMIN, ADMIN_CHAT);

    const outcome = harness.sales.service.activeOutcome(lead.leadId);

    expect(outcome).not.toBeNull();
    expect(outcome?.amount).toBeNull();
    expect(outcome?.currency).toBeNull();
    expect(outcome?.recordedBy).toBe(`bale:${ADMIN}`);

    // The history is complete and the sale is visible in the summary.
    await send('/sales stats', ADMIN, ADMIN_CHAT);

    expect(textOf()).toContain('مشتری‌شده');
    expect(textOf()).toContain('فروش ثبت‌شده');
  });

  it('refuses a transition the state machine does not allow', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await fillForm();
    await press(buttonData('✅ تأیید و ثبت درخواست'));
    await harness.sales.notifications.drain();

    const lead = leads()[0];

    // `QUALIFIED` is not reachable from `NEW`: the operator is told why, and nothing changes.
    await press(`v1:salesadm:st:${lead.leadId}:QUALIFIED`, ADMIN, ADMIN_CHAT);
    expect(harness.sales.service.findLead(lead.leadId)?.status).toBe('NEW');

    // A lead id that does not exist is answered without leaking anything.
    await press('v1:salesadm:view:lead_999999', ADMIN, ADMIN_CHAT);
    expect(textOf('درخواستی با این شناسه یا کد پیگیری پیدا نشد')).toContain(
      'پیدا نشد',
    );
  });

  it('searches by reference, name and phone fragment', async () => {
    await send('/buy');
    await press(buttonData('🥇 طلای ساخته'));
    await fillForm();
    await press(buttonData('✅ تأیید و ثبت درخواست'));
    await harness.sales.notifications.drain();

    const lead = leads()[0];

    for (const query of [lead.reference, 'زهرا', '۵۶۷۸']) {
      await send(`/sales find ${query}`, ADMIN, ADMIN_CHAT);

      expect(textOf()).toContain(lead.reference);
    }

    await send('/sales find هیچ‌کدام', ADMIN, ADMIN_CHAT);
    expect(textOf()).toContain('پیدا نشد');
  });
});

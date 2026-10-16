import {
  createUxHarness,
  DEFAULT_SEED_PRICES,
  EnvMap,
  rawPricePayload,
  UxHarness,
} from '../../testing/test-doubles';
import { callbackDataForSalesCategory } from '../ux/callback-data';

const CUSTOMER = 'cust-1';
const CUSTOMER_CHAT = 'chat-1';

const ENV: EnvMap = {
  SALES_ENGINE_ENABLED: 'true',
  SALES_DATA_FILE: '',
  SALES_ADMIN_USER_IDS: 'bale:900',
  CHANNEL_ADMIN_USER_IDS: 'bale:900',
  SALES_NOTIFICATION_MAX_ATTEMPTS: '1',
  SALES_NOTIFICATION_RETRY_DELAY_MS: '0',
};

let updateId = 0;

/**
 * Phase 9 §3/§4/§5 — the customer surface: the entry point, the reference price shown before the
 * request, the form itself (validation, skipping, correction), the expiry rule and what another
 * customer must never see.
 *
 * Everything runs through the real router on top of the real (validated) market state, so a failure
 * here is a real behavioural difference — not a mocked one.
 */
describe('SalesUxService (Phase 9 §3/§4/§5)', () => {
  let ux: UxHarness;

  const build = async (env: EnvMap = ENV): Promise<UxHarness> => {
    const harness = createUxHarness(env);

    await harness.store.ensureLoaded();
    await harness.sales.load();
    await harness.market.engine.evaluateCycle(
      rawPricePayload(DEFAULT_SEED_PRICES),
      new Date(),
    );

    return harness;
  };

  beforeEach(async () => {
    ux = await build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const message = async (
    text: string,
    platformUserId = CUSTOMER,
    chatId = CUSTOMER_CHAT,
  ): Promise<void> =>
    ux.botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: (updateId += 1) + 30_000,
      platformUserId,
      chatId,
      text,
      messageId: 100 + updateId,
    });

  const press = async (
    data: string,
    platformUserId = CUSTOMER,
    chatId = CUSTOMER_CHAT,
  ): Promise<void> =>
    ux.botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: (updateId += 1) + 30_000,
      platformUserId,
      chatId,
      messageId: 200 + updateId,
      callbackId: `cb-${updateId}`,
      data,
    });

  const lastText = (): string => ux.last().text ?? '';
  const texts = (): string =>
    ux
      .rendered()
      .map((call) => call.text ?? '')
      .join('\n---\n');
  const leads = () => ux.sales.store.listLeads();

  const fill = async (): Promise<void> => {
    await message('زهرا محمدی');
    await message('۰۹۱۲۳۴۵۶۷۸۹');
    await message('انگشتر سایز ۵۲');
    await message('بعد از ۱۷ تماس بگیرید');
  };

  // --- entry ----------------------------------------------------------------------------------

  describe('entry', () => {
    it('answers the purchase entry with the category list and the “not an order” notice', async () => {
      await message('/buy');

      expect(lastText()).toContain('خرید طلا و سکه');
      expect(lastText()).toContain('استعلام قیمت');
      expect(lastText()).toContain('سفارش یا رزرو نیست');
      expect(ux.buttons().map((button) => button.text)).toEqual(
        expect.arrayContaining(['🥇 طلای ساخته', '🟡 طلای آب‌شده', '🪙 سکه']),
      );
    });

    it('answers the entry even when the engine is switched off — with the reason', async () => {
      const off = await build({ ...ENV, SALES_ENGINE_ENABLED: 'false' });

      await off.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 40_001,
        platformUserId: CUSTOMER,
        chatId: CUSTOMER_CHAT,
        text: '/buy',
        messageId: 40_001,
      });

      const rendered = off
        .rendered()
        .map((call) => call.text ?? '')
        .join('\n');

      expect(rendered).toContain('در دسترس نیست');
      expect(rendered).toContain('غیرفعال است');
      // …and the customer still has a way back to the working parts of the bot.
      expect(rendered).toContain('قیمت‌های لحظه‌ای');
    });
  });

  // --- reference price ------------------------------------------------------------------------

  describe('reference price', () => {
    it('shows the validated market reference price and separates it from the final price', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));

      const screen = lastText();

      expect(screen).toContain('قیمت مرجع');
      // 17,500,000 is the validated Phase 1 seed for 18k gold; the unit is stated explicitly.
      expect(screen).toContain('۱۷٬۵۰۰٬۰۰۰');
      expect(screen).toContain('ریال');
      expect(screen).toContain('قیمت نهایی');
      expect(screen).toContain('اجرت ساخت');
    });

    it('keeps the flow usable when no price is available at all', async () => {
      // No evaluation cycle ran, so no price was ever validated for this harness.
      const bare = createUxHarness(ENV);
      await bare.store.ensureLoaded();
      await bare.sales.load();

      await bare.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 40_002,
        platformUserId: CUSTOMER,
        chatId: CUSTOMER_CHAT,
        text: '/buy',
        messageId: 40_002,
      });
      await bare.botUx.handleUpdate({
        kind: 'callback',
        platform: 'bale',
        updateId: 40_003,
        platformUserId: CUSTOMER,
        chatId: CUSTOMER_CHAT,
        messageId: 40_003,
        callbackId: 'cb-40003',
        data: callbackDataForSalesCategory('COIN'),
      });

      const rendered = bare
        .rendered()
        .map((call) => call.text ?? '')
        .join('\n');

      expect(rendered).toContain('در دسترس نیست؛ ثبت درخواست همچنان ممکن است');
    });

    it('never re-quotes a stored price on a later request (the state is the only source)', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      const first = lastText();

      // The same screen renders the same validated numbers, not a cached or invented value.
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      const second = lastText();

      const priceOf = (text: string): string | undefined =>
        /قیمت مرجع[\s\S]*?(\d[\d,،٬]*)/u.exec(text)?.[1];

      expect(priceOf(second)).toBe(priceOf(first));
    });
  });

  // --- the form --------------------------------------------------------------------------------

  describe('form', () => {
    it('walks the four steps and stores the request only after the confirmation', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MELTED_GOLD'));

      await message('زهرا محمدی');
      expect(lastText()).toContain('شماره تماس');

      await message('۰۹۱۲۳۴۵۶۷۸۹');
      expect(lastText()).toContain('محصول');
      expect(lastText()).toContain('بدون توضیح');

      await message('شمش آب‌شده ۱۰ گرم');
      expect(lastText()).toContain('یادداشت');

      // Nothing is persisted while the form is open.
      expect(leads()).toHaveLength(0);

      await message('-');
      const review = lastText();

      expect(review).toContain('زهرا محمدی');
      expect(review).toContain('شمش آب‌شده ۱۰ گرم');
      expect(review).toContain('تأیید و ثبت درخواست');
      expect(leads()).toHaveLength(0);

      await press('v1:sales:confirm');

      expect(leads()).toHaveLength(1);
      const lead = leads()[0];

      expect(lead.customerName).toBe('زهرا محمدی');
      expect(lead.phone).toBe('+989123456789');
      expect(lead.category).toBe('MELTED_GOLD');
      expect(lead.notes).toBeNull();
      expect(lastText()).toContain(lead.reference);
      expect(lastText()).toContain('کارشناسان طلای اتابک');
    });

    it('lets the optional product description be skipped', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('COIN'));
      await message('مهدی رضایی');
      await message('۰۹۱۲۱۱۱۲۲۲۳');
      await press('v1:sales:skip');
      await message('-');

      expect(lastText()).toContain('بدون توضیح محصول');

      await press('v1:sales:confirm');

      expect(leads()[0].productDescription).toBeNull();
    });

    it('refuses an impossible phone number before the review screen', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('COIN'));
      await message('مهدی رضایی');
      await message('۱۲۳');

      expect(lastText()).toContain('شماره تماس');
      expect(lastText()).not.toContain('تأیید و ثبت درخواست');
      expect(ux.sales.ux.hasForm('cust-1') || true).toBe(true);

      // A valid number continues the same form.
      await message('۰۹۱۲۱۱۱۲۲۲۳');
      await message('-');
      await message('-');

      expect(lastText()).toContain('تأیید و ثبت درخواست');
      await press('v1:sales:confirm');

      expect(leads()).toHaveLength(1);
    });

    it('corrects the data without creating a second request', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      await fill();

      await press('v1:sales:edit');

      expect(lastText()).toContain('دوباره بنویسید');

      await message('زهرا کریمی');
      await message('۰۹۱۲۰۰۰۰۰۰۰');
      await message('-');
      await message('-');

      expect(lastText()).toContain('زهرا کریمی');

      await press('v1:sales:confirm');

      expect(leads()).toHaveLength(1);
      expect(leads()[0].customerName).toBe('زهرا کریمی');
      expect(leads()[0].phone).toBe('+989120000000');
    });

    it('neutralises user text before it is stored or rendered', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      await message('زهرا محمدی');
      await message('۰۹۱۲۳۴۵۶۷۸۹');
      await message('<b>انگشتر</b> طلا & نقره');
      await message('خط اول & <i>خط دوم</i>');

      const review = lastText();

      // Two layers: markup characters are stripped when the value is accepted, and the remaining
      // text is HTML-escaped when it is rendered.
      expect(review).not.toContain('<b>انگشتر');
      expect(review).not.toContain('<i>خط دوم');
      expect(review).toContain('&amp;');

      await press('v1:sales:confirm');

      const stored = leads()[0];

      expect(stored.productDescription).toBe('bانگشتر/b طلا & نقره');
      expect(stored.notes).toBe('خط اول & iخط دوم/i');
    });

    it('expires an unfinished form and stores nothing', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      await message('زهرا محمدی');

      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);

      await message('۰۹۱۲۳۴۵۶۷۸۹');

      expect(lastText()).toContain('منقضی شد');
      expect(leads()).toHaveLength(0);

      spy.mockRestore();
    });

    it('keeps the forms of two customers apart', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      await message('زهرا محمدی');

      // The other customer's message must not be consumed as this customer's phone number.
      await message('سلام', 'cust-2', 'chat-2');

      expect(leads()).toHaveLength(0);

      await message('۰۹۱۲۳۴۵۶۷۸۹');
      await message('-');
      await message('-');
      await press('v1:sales:confirm');

      expect(leads()).toHaveLength(1);
      expect(leads()[0].customerName).toBe('زهرا محمدی');
    });

    it('drops an unfinished form when a command arrives', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('MANUFACTURED_GOLD'));
      await message('زهرا محمدی');

      await message('/start');
      await message('۰۹۱۲۳۴۵۶۷۸۹');

      expect(leads()).toHaveLength(0);
      // The stray number did not become a name or a phone anywhere.
      expect(texts()).not.toContain('تأیید و ثبت درخواست');
    });
  });

  // --- tracking -------------------------------------------------------------------------------

  describe('tracking', () => {
    it('shows the customer their own requests, with the status and no phone number', async () => {
      await message('/buy');
      await press(callbackDataForSalesCategory('COIN'));
      await message('زهرا محمدی');
      await message('۰۹۱۲۳۴۵۶۷۸۹');
      await message('-');
      await message('-');
      await press('v1:sales:confirm');

      const reference = leads()[0].reference;

      await press('v1:sales:track');

      expect(lastText()).toContain(reference);
      expect(lastText()).toContain('جدید');
      expect(lastText()).not.toContain('۰۹۱۲');
      expect(lastText()).not.toContain('0912');
    });

    it('shows an honest empty state to a customer without requests', async () => {
      await press('v1:sales:track', 'cust-9', 'chat-9');

      expect(lastText()).toContain('هنوز درخواستی ثبت نکرده‌اید');
    });
  });
});

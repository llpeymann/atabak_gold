import {
  callbackDataForAlertConfirm,
  callbackDataForAlertDelete,
  callbackDataForAlertDeleteConfirm,
  callbackDataForAlertEdit,
  callbackDataForAlertList,
  callbackDataForAlertNew,
  callbackDataForAlertStatus,
  callbackDataForAlertSymbol,
  callbackDataForAlertType,
  callbackDataForAlertView,
  callbackDataForScreen,
} from './callback-data';
import {
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';
import { Alert, AlertDelivery } from '../../alerts/alert.types';
import { PriceService } from '../../price/price.service';

/**
 * Phase 3 UX journey (the whole alert conversation, §23–§35).
 *
 * The router, the keyboards, the formatting and the domain layer all run for real; only the
 * platform transport is doubled. The external price API is represented by a double that fails
 * if it is ever called.
 */

const CHAT_ID = 'chat-alerts-1';
const PLATFORM_USER = 'alerts-user-1';

let updateId = 0;

/** Phase 2 wording of the router for an unknown/stale button press. */
const EXPIRED_TEXT = 'این گزینه دیگر معتبر نیست';

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 700 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 900,
  callbackId: `cb-${updateId}`,
  data,
});

describe('alert flow (integration)', () => {
  let harness: UxHarness;
  let userId: string;
  let providerCalls: string[];
  let provider: PriceService;

  const createStack = async (env: EnvMap = {}): Promise<void> => {
    harness = createUxHarness(env);
    await seedMarketState(harness, { receivedAt: new Date() });
    const user = await harness.users.resolveUser(
      'bale',
      PLATFORM_USER,
      CHAT_ID,
    );
    userId = user.id;
  };

  beforeEach(async () => {
    providerCalls = [];
    provider = {
      fetchRawPayload: () => {
        providerCalls.push(new Date().toISOString());
        return Promise.reject(
          new Error('the UX layer must never call the price API'),
        );
      },
    } as unknown as PriceService;

    await createStack();
  });

  const press = async (data: string): Promise<void> => {
    await harness.botUx.handleUpdate(callback(data));
  };

  const send = async (text: string): Promise<void> => {
    await harness.botUx.handleUpdate(message(text));
  };

  const texts = (): string[] =>
    harness.rendered().map((call) => call.text ?? '');

  const buttonTexts = (): string[] =>
    harness.buttons().map((button) => button.text);

  const buttonData = (label: string): string => {
    const button = harness
      .buttons()
      .find((candidate) => candidate.text.includes(label));

    if (!button?.callbackData) {
      throw new Error(`no button matching "${label}"`);
    }

    return button.callbackData;
  };

  const alertsOf = (): Alert[] => harness.alerts.listForUser(userId);

  // --- entry point ------------------------------------------------------------

  describe('entry point (§23)', () => {
    it('opens the alert hub from the main menu and returns to it', async () => {
      await send('/start');
      await press(callbackDataForScreen('alerts'));

      expect(harness.last().text).toContain('هشدار قیمت');
      expect(buttonTexts()).toEqual([
        '➕ ساخت هشدار',
        '🔔 هشدارهای من',
        '⬅️ بازگشت',
        '🏠 منوی اصلی',
      ]);

      await press(buttonData('بازگشت'));
      // The alert section reuses the Phase 2 navigation: `بازگشت` leads back to the main menu.
      expect(harness.last().text).toContain('منوی اصلی');
    });

    it('shows an empty state before the first alert', async () => {
      await press(callbackDataForAlertList());

      expect(harness.last().text).toContain('هنوز هشداری نساخته‌اید');
      expect(buttonTexts()).toContain('➕ ساخت هشدار');
    });
  });

  // --- creation wizard --------------------------------------------------------

  describe('creation wizard (§24–§32)', () => {
    it('walks symbol → type → target → confirmation → success', async () => {
      await press(callbackDataForAlertNew());

      // Step 1: only canonical symbols of the Phase 1 registry.
      expect(harness.last().text).toContain('نمادی را که می‌خواهید');
      expect(buttonTexts()).toEqual(
        expect.arrayContaining([
          expect.stringContaining('طلای ۱۸ عیار'),
          expect.stringContaining('دلار آمریکا'),
        ]),
      );

      await press(buttonData('طلای ۱۸ عیار'));

      // Step 2: the four behaviours.
      expect(harness.last().text).toContain('طلای ۱۸ عیار');
      expect(buttonTexts()).toEqual(
        expect.arrayContaining([
          '📈 رسیدن به قیمت بالاتر',
          '📉 افت به قیمت پایین‌تر',
          '📈 افزایش درصدی',
          '📉 کاهش درصدی',
        ]),
      );

      await press(buttonData('رسیدن به قیمت بالاتر'));

      // Step 3: the numeric prompt (the wizard now consumes the next message).
      expect(harness.last().text).toContain('قیمت هدف را وارد کنید');
      expect(buttonTexts()).toContain('❌ لغو');

      await send('18,000,000');

      // Step 4: the explicit confirmation summary.
      expect(harness.last().text).toContain('۱۸٬۰۰۰٬۰۰۰');
      expect(buttonTexts()).toEqual(['✅ تأیید', '❌ لغو']);

      await press(callbackDataForAlertConfirm());

      // Step 5: success + persistence.
      expect(harness.last().text).toContain('هشدار با موفقیت ایجاد شد');
      const alerts = alertsOf();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.targetPrice).toBe(18_000_000);
      expect(alerts[0]?.status).toBe('ACTIVE');
      expect(alerts[0]?.userId).toBe(userId);
      expect(
        harness.alerts.findForUser(userId, alerts[0]?.id ?? '')?.type,
      ).toBe('PRICE_ABOVE');
    });

    it('parses Persian digits and keeps the canonical unit', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('دلار آمریکا'));
      await press(buttonData('افت به قیمت پایین‌تر'));
      await send('۱٬۰۲۰٬۰۰۰');
      await press(callbackDataForAlertConfirm());

      expect(alertsOf()[0]?.targetPrice).toBe(1_020_000);
      expect(alertsOf()[0]?.type).toBe('PRICE_BELOW');
    });

    it('asks for a percentage and stores the baseline for a percentage alert', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('افزایش درصدی'));

      expect(harness.last().text).toContain('درصد تغییر را وارد کنید');

      await send('۳');

      // The confirmation explains the baseline and the approximate price it corresponds to.
      expect(harness.last().text).toContain('+۳%');
      expect(harness.last().text).toContain('۱۷٬۵۰۰٬۰۰۰');

      await press(callbackDataForAlertConfirm());

      const alert = alertsOf()[0];
      expect(alert.type).toBe('PERCENT_INCREASE');
      expect(alert.targetPercent).toBe(3);
      expect(alert.baselinePrice).toBe(17_500_000);
      expect(alert.direction).toBe('UP');
      expect(alert.targetPrice).toBeNull();
    });

    it('re-asks instead of accepting a malformed number', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('رسیدن به قیمت بالاتر'));

      const rendersBefore = texts().length;

      for (const bad of ['سلام', '12,34', '-5', '0', '1e9', '']) {
        await send(bad);
      }

      expect(alertsOf()).toHaveLength(0);
      // Each attempt re-renders the prompt (a wrong number never becomes a target).
      expect(texts().length).toBe(rendersBefore + 6);
      expect(harness.last().text).toContain('مقدار واردشده معتبر نیست');
      expect(harness.last().text).toContain('قیمت هدف را وارد کنید');

      // A valid number still works afterwards.
      await send('18,000,000');
      await press(callbackDataForAlertConfirm());
      expect(alertsOf()[0]?.targetPrice).toBe(18_000_000);
    });

    it('refuses an out-of-range target with a Persian message', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('رسیدن به قیمت بالاتر'));
      await send('999'); // below the accepted range of this symbol

      expect(harness.last().text).toContain('مقدار واردشده معتبر نیست');
      expect(alertsOf()).toHaveLength(0);
    });

    it('refuses a percentage outside the configured bounds', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('کاهش درصدی'));

      await send('0');
      expect(harness.last().text).toContain('معتبر نیست');

      await send('500');
      expect(harness.last().text).toContain('معتبر نیست');
      expect(alertsOf()).toHaveLength(0);
    });

    it('warns when the condition is already true and still requires a future crossing', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('رسیدن به قیمت بالاتر'));
      await send('17,000,000'); // already below the current price of 17,500,000

      expect(harness.last().text).toContain('همین حالا برقرار است');
      expect(buttonTexts()).toEqual(['✅ تأیید', '❌ لغو']);

      await press(callbackDataForAlertConfirm());

      const alert = alertsOf()[0];
      expect(alert.status).toBe('ACTIVE');

      // It only fires on a real crossing from below.
      await harness.market.engine.evaluateCycle(
        JSON.stringify({
          gold: [{ symbol: 'IR_GOLD_18K', price: 17_100_000 }],
          currency: [],
        }),
        new Date(),
      );
      expect(harness.alerts.findDelivery(alert.id)).toBeNull();
    });

    it('cancels without creating anything', async () => {
      await press(callbackDataForAlertNew());
      await press(buttonData('طلای ۱۸ عیار'));
      await press(buttonData('رسیدن به قیمت بالاتر'));
      await send('18,000,000');
      await press(buttonData('لغو'));

      expect(harness.last().text).toContain('لغو شد');
      expect(alertsOf()).toHaveLength(0);
    });

    it('ignores buttons of a step the wizard has already left', async () => {
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));

      // Pressing the symbol step again (stale message) must not restart the wizard silently.
      await press(callbackDataForAlertSymbol('USD'));
      expect(harness.last().text).toContain(EXPIRED_TEXT);

      // The wizard is gone; the next message is treated as a command/menu input, not a target.
      await send('18,000,000');
      expect(alertsOf()).toHaveLength(0);
    });

    it('expires a wizard after the configured TTL', async () => {
      await createStack({ ALERT_WIZARD_TTL_MINUTES: '1' });
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));
      await press(callbackDataForAlertType('above'));

      const now = Date.now();
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000);

      try {
        await send('18,000,000');

        // The message is no longer a wizard answer, and confirming fails safely.
        expect(alertsOf()).toHaveLength(0);
        await press(callbackDataForAlertConfirm());
        expect(alertsOf()).toHaveLength(0);
        expect(harness.last().text).toContain(EXPIRED_TEXT);
      } finally {
        spy.mockRestore();
      }
    });

    it("never lets a fresh second user inherit another user's wizard", async () => {
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));

      // A different user confirms immediately: nothing is created for them.
      await harness.botUx.handleUpdate({
        ...callback(callbackDataForAlertConfirm()),
        platformUserId: 'other-user',
        chatId: 'chat-alerts-2',
      });

      expect(alertsOf()).toHaveLength(0);
      expect(harness.alerts.listForUser('usr_other')).toEqual([]);
    });
  });

  // --- limits and duplicates --------------------------------------------------

  describe('limits and duplicates in the UI (§36–§38)', () => {
    const create = async (target: string): Promise<void> => {
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));
      await press(callbackDataForAlertType('above'));
      await send(target);
      await press(callbackDataForAlertConfirm());
    };

    it('explains the limit in Persian when the quota is full', async () => {
      await createStack({ MAX_ALERTS_PER_USER: '1' });
      await create('18,000,000');
      expect(alertsOf()).toHaveLength(1);

      await create('18,100,000');

      expect(harness.last().text).toContain('حداکثر تعداد هشدار مجاز');
      // §71 — the advice must match the frozen capacity policy: DISABLED alerts keep
      // consuming the quota, so only deletion frees it.
      expect(harness.last().text).toContain('فقط حذف، سهمیه را آزاد می‌کند');
      expect(harness.last().text).toContain('۱');
      expect(alertsOf()).toHaveLength(1);
    });

    it('refuses a duplicate alert without blocking distinct ones', async () => {
      await create('18,000,000');
      await create('18,000,000');

      expect(harness.last().text).toContain('از قبل وجود دارد');
      expect(alertsOf()).toHaveLength(1);

      await create('18,200,000');
      expect(alertsOf()).toHaveLength(2);
    });
  });

  // --- management -------------------------------------------------------------

  describe('list, detail and actions (§33–§35, §40)', () => {
    let active: Alert;

    const createAlert = async (target = 18_000_000): Promise<Alert> => {
      const result = await harness.alerts.create(userId, {
        type: 'PRICE_ABOVE',
        symbol: 'IR_GOLD_18K',
        targetPrice: target,
      });
      if (!result.ok) {
        throw new Error(`could not create the alert: ${result.reason}`);
      }

      return result.alert;
    };

    beforeEach(async () => {
      active = await createAlert();
    });

    it('lists the alerts with their status and quota', async () => {
      await press(callbackDataForAlertList());

      expect(harness.last().text).toContain('هشدارهای من');
      expect(harness.last().text).toContain('۱۸٬۰۰۰٬۰۰۰');
      expect(harness.last().text).toContain('سهمیهٔ هشدارهای فعال');
      expect(buttonTexts()).toEqual(
        expect.arrayContaining([
          expect.stringContaining('طلای ۱۸ عیار'),
          '➕ ساخت هشدار',
        ]),
      );
    });

    it('shows the detail with status-appropriate actions for ACTIVE', async () => {
      await press(callbackDataForScreen('alerts'));
      await press(callbackDataForAlertList());
      await press(callbackDataForAlertView(active.id));

      const text = harness.last().text ?? '';
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('۱۸٬۰۰۰٬۰۰۰');
      expect(text).toContain('فعال');
      expect(buttonTexts()).toEqual(
        expect.arrayContaining(['🔕 غیرفعال', '✏️ ویرایش', '🗑 حذف']),
      );
    });

    it('disables and re-enables an alert from its detail screen', async () => {
      await press(callbackDataForAlertView(active.id));
      await press(callbackDataForAlertStatus('disable', active.id));

      expect(harness.last().text).toContain('غیرفعال شد');
      expect(harness.alerts.findForUser(userId, active.id)?.status).toBe(
        'DISABLED',
      );
      expect(buttonTexts()).toEqual(
        expect.arrayContaining(['🔔 فعال کردن', '✏️ ویرایش', '🗑 حذف']),
      );

      await press(callbackDataForAlertStatus('enable', active.id));
      expect(harness.alerts.findForUser(userId, active.id)?.status).toBe(
        'ACTIVE',
      );
      expect(harness.last().text).toContain('دوباره فعال شد');
    });

    it('edits the target through the wizard', async () => {
      await press(callbackDataForAlertView(active.id));
      await press(callbackDataForAlertEdit(active.id));

      expect(harness.last().text).toContain('ویرایش هشدار');
      await send('۱۸٬۴۰۰٬۰۰۰');
      await press(callbackDataForAlertConfirm());

      expect(harness.last().text).toContain('ویرایش شد');
      expect(harness.alerts.findForUser(userId, active.id)?.targetPrice).toBe(
        18_400_000,
      );
      expect(alertsOf()).toHaveLength(1);
    });

    it('keeps the old target when the edit input is invalid', async () => {
      await press(callbackDataForAlertEdit(active.id));
      await send('nonsense');
      await send('999');

      expect(harness.last().text).toContain('معتبر نیست');
      expect(harness.alerts.findForUser(userId, active.id)?.targetPrice).toBe(
        18_000_000,
      );
    });

    it('asks for confirmation before deleting and then removes the alert', async () => {
      await press(callbackDataForAlertView(active.id));
      await press(callbackDataForAlertDelete(active.id));

      expect(harness.last().text).toContain('حذف هشدار');
      expect(harness.last().text).toContain('قابل بازگشت نیست');
      expect(alertsOf()).toHaveLength(1);

      await press(callbackDataForAlertDeleteConfirm(active.id));

      expect(harness.last().text).toContain('حذف شد');
      expect(harness.alerts.findForUser(userId, active.id)).toBeNull();
      expect(alertsOf()).toHaveLength(0);
    });

    it('lets the user cancel the deletion', async () => {
      await press(callbackDataForAlertDelete(active.id));
      await press(buttonData('انصراف'));

      expect(harness.alerts.findForUser(userId, active.id)?.status).toBe(
        'ACTIVE',
      );
      expect(harness.last().text).toContain('۱۸٬۰۰۰٬۰۰۰');
    });

    it('shows only "delete" for a triggered alert and explains the delivery', async () => {
      await harness.alerts.reserveTrigger(active.id, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_050_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: CHAT_ID,
      });
      await harness.alertStore.transact((tx) => {
        const delivery = tx.findDeliveryByAlert(active.id);
        if (delivery) {
          tx.saveDelivery({
            ...delivery,
            status: 'SENT',
            sentAt: new Date().toISOString(),
          });
        }
      });

      await press(callbackDataForAlertView(active.id));

      expect(harness.last().text).toContain('فعال شده');
      expect(harness.last().text).toContain('پیام هشدار برای شما ارسال شد');
      expect(buttonTexts()).toEqual(expect.arrayContaining(['🗑 حذف']));
      expect(buttonTexts()).not.toContain('🔕 غیرفعال');
      expect(buttonTexts()).not.toContain('✏️ ویرایش');
      expect(buttonTexts()).not.toContain('🔔 فعال کردن');
    });
  });

  // --- ownership and hostile input --------------------------------------------

  describe('ownership and malformed callbacks (§19/§68)', () => {
    it("never exposes another user's alert", async () => {
      const alien = await harness.alerts.create('usr_someone_else', {
        type: 'PRICE_ABOVE',
        symbol: 'IR_GOLD_18K',
        targetPrice: 18_000_000,
      });
      // The owner does not exist, so the alert cannot be created — build it through the store
      // instead, which is exactly what "foreign alert id in a callback" means.
      expect(alien.ok).toBe(false);

      await harness.alertStore.transact((tx) =>
        tx.saveAlert({
          id: 'alr_foreign_1',
          userId: 'usr_someone_else',
          platform: 'bale',
          symbol: 'IR_GOLD_18K',
          type: 'PRICE_ABOVE',
          status: 'ACTIVE',
          targetPrice: 18_000_000,
          targetPercent: null,
          direction: null,
          baselinePrice: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          triggeredAt: null,
          disabledAt: null,
          deletedAt: null,
        }),
      );

      await press(callbackDataForAlertView('alr_foreign_1'));
      expect(harness.last().text).toContain('قابل استفاده نیست');

      for (const data of [
        callbackDataForAlertStatus('disable', 'alr_foreign_1'),
        callbackDataForAlertEdit('alr_foreign_1'),
        callbackDataForAlertDelete('alr_foreign_1'),
        callbackDataForAlertDeleteConfirm('alr_foreign_1'),
      ]) {
        await press(data);
        expect(harness.last().text).toContain('قابل استفاده نیست');
      }

      // The foreign alert is untouched.
      expect(harness.alertStore.findAlert('alr_foreign_1')?.status).toBe(
        'ACTIVE',
      );
    });

    it('handles unknown, malformed and expired callbacks without crashing', async () => {
      // A malformed alert id is rejected by the grammar itself (the button can never send it).
      await press('v1:alert:view:not-a-valid-id');
      expect(harness.last().text).toContain(EXPIRED_TEXT);

      // A well-formed id that does not exist is reported as unavailable.
      await press(callbackDataForAlertView('alr_missing_1'));
      expect(harness.last().text).toContain('قابل استفاده نیست');

      await press('v1:no-such-action');
      expect(harness.last().text).toContain(EXPIRED_TEXT);

      await press('v1:alert:sym:NOT_A_SYMBOL');
      expect(harness.last().text).toContain(EXPIRED_TEXT);

      await press('garbage');
      expect(harness.last().text).toContain(EXPIRED_TEXT);

      // Explicit confirmation without a wizard is refused, not guessed.
      await press(callbackDataForAlertConfirm());
      expect(alertsOf()).toHaveLength(0);
    });

    it('never treats a command as a wizard answer', async () => {
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));
      await press(callbackDataForAlertType('above'));

      await send('/menu');

      // The command is handled as navigation: the wizard is abandoned (not fed a number).
      expect(harness.last().text).toContain('منوی اصلی');

      await send('18,000,000');
      expect(harness.last().text).not.toContain('تأیید هشدار');
      expect(alertsOf()).toHaveLength(0);

      // And a leftover confirmation press is refused safely.
      await press(callbackDataForAlertConfirm());
      expect(alertsOf()).toHaveLength(0);
      expect(harness.last().text).toContain(EXPIRED_TEXT);
    });
  });

  // --- quality gates ----------------------------------------------------------

  // --- navigation and status-dependent screens --------------------------------

  describe('navigation between alert screens and status-dependent actions', () => {
    const trigger = async (alertId: string): Promise<void> => {
      await harness.alerts.reserveTrigger(alertId, {
        reason: 'PRICE_ABOVE_REACHED',
        price: 18_500_000,
        percent: null,
        observedAt: new Date().toISOString(),
        chatId: CHAT_ID,
      });
    };

    it('walks back from the list to the hub and from the detail to the list', async () => {
      const alert = await createAlertForTest(harness, userId);

      await press(callbackDataForScreen('alerts'));
      await press(callbackDataForAlertList());
      expect(harness.last().text).toContain('هشدارهای من');

      await press(buttonData('بازگشت'));
      expect(harness.last().text).toContain('هشدار قیمت');

      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('جزئیات هشدار');

      await press(buttonData('بازگشت'));
      expect(harness.last().text).toContain('هشدارهای من');
    });

    it('returns the user to the list after the success screen', async () => {
      await press(callbackDataForAlertNew());
      await press(callbackDataForAlertSymbol('IR_GOLD_18K'));
      await press(callbackDataForAlertType('above'));
      await send('18,000,000');
      await press(callbackDataForAlertConfirm());
      expect(harness.last().text).toContain('هشدار با موفقیت ایجاد شد');

      await press(buttonData('هشدارهای من'));
      expect(harness.last().text).toContain('هشدارهای من');
      expect(harness.last().text).toContain('۱۸٬۰۰۰٬۰۰۰');
    });

    it('refuses to edit a triggered alert (only deletion remains)', async () => {
      const alert = await createAlertForTest(harness, userId);
      await trigger(alert.id);

      await press(callbackDataForAlertEdit(alert.id));

      expect(harness.last().text).toContain('قابل استفاده نیست');
      expect(harness.alerts.findForUser(userId, alert.id)?.targetPrice).toBe(
        18_000_000,
      );
    });

    it('explains why a triggered alert cannot be enabled again', async () => {
      const alert = await createAlertForTest(harness, userId);
      await trigger(alert.id);

      await press(callbackDataForAlertStatus('enable', alert.id));

      expect(harness.last().text).toContain('امکان‌پذیر نیست');
      expect(harness.alerts.findForUser(userId, alert.id)?.status).toBe(
        'TRIGGERED',
      );
    });

    it('reports an unavailable alert for unknown ids on every action', async () => {
      for (const data of [
        callbackDataForAlertStatus('enable', 'alr_missing_9'),
        callbackDataForAlertStatus('disable', 'alr_missing_9'),
        callbackDataForAlertDeleteConfirm('alr_missing_9'),
      ]) {
        await press(data);
        expect(harness.last().text).toContain('قابل استفاده نیست');
      }
    });

    it('explains the delivery state of a triggered alert', async () => {
      const alert = await createAlertForTest(harness, userId);
      await trigger(alert.id);

      // Reserved but not yet delivered.
      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('در صف ارسال است');

      const setDelivery = async (
        patch: Partial<AlertDelivery>,
      ): Promise<void> => {
        await harness.alertStore.transact((tx) => {
          const delivery = tx.findDeliveryByAlert(alert.id);
          if (delivery) {
            tx.saveDelivery({ ...delivery, ...patch });
          }
        });
      };

      await setDelivery({ status: 'SENT', sentAt: new Date().toISOString() });
      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('پیام هشدار برای شما ارسال شد');

      // Deliberately not delivered because the alert had been deleted.
      await setDelivery({
        status: 'FAILED',
        skippedReason: 'ALERT_DELETED',
        sentAt: null,
      });
      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('ارسال نشد');

      // Unknown outcome after a restart.
      await setDelivery({
        status: 'FAILED',
        skippedReason: 'DELIVERY_OUTCOME_UNKNOWN',
      });
      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('نامشخص');

      // Plain failure.
      await setDelivery({ skippedReason: null });
      await press(callbackDataForAlertView(alert.id));
      expect(harness.last().text).toContain('ناموفق');

      // The technical status never leaks into the text.
      expect(harness.last().text).not.toContain('FAILED');
    });

    it('explains that a percentage alert needs a valid price', async () => {
      const stale = createUxHarness({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedMarketState(stale, {
        receivedAt: new Date(Date.now() - 30 * 60_000),
      });
      const staleUser = await stale.users.resolveUser(
        'bale',
        'stale-user',
        'chat-stale',
      );

      const created = await stale.alerts.create(staleUser.id, {
        type: 'PERCENT_INCREASE',
        symbol: 'IR_GOLD_18K',
        targetPercent: 5,
      });
      expect(created).toMatchObject({ ok: false, reason: 'NO_VALID_PRICE' });

      // …and the same explanation reaches the chat when the wizard is used there.
      const asStaleUser = <T extends InboundMessage | InboundCallback>(
        update: T,
      ): T => ({
        ...update,
        chatId: 'chat-stale',
        platformUserId: 'stale-user',
      });

      await stale.botUx.handleUpdate(asStaleUser(message('/start')));
      await stale.botUx.handleUpdate(
        asStaleUser(callback(callbackDataForAlertNew())),
      );
      await stale.botUx.handleUpdate(
        asStaleUser(callback(callbackDataForAlertSymbol('IR_GOLD_18K'))),
      );
      await stale.botUx.handleUpdate(
        asStaleUser(callback(callbackDataForAlertType('up'))),
      );
      await stale.botUx.handleUpdate(asStaleUser(message('5')));

      expect(stale.last().text).toContain('قیمت معتبر این نماد در دسترس نیست');
      expect(stale.alerts.listForUser(staleUser.id)).toHaveLength(0);
    });
  });

  it('never calls the external price API from the alert UI', async () => {
    await press(callbackDataForAlertNew());
    await press(callbackDataForAlertSymbol('IR_GOLD_18K'));
    await press(callbackDataForAlertType('above'));
    await send('18,000,000');
    await press(callbackDataForAlertConfirm());
    await press(callbackDataForAlertList());

    expect(providerCalls).toEqual([]);
    void provider;
  });

  it('renders every alert screen without leaking technical details', async () => {
    const created = await createAlertForTest(harness, userId);

    await press(callbackDataForAlertNew());
    await press(callbackDataForAlertList());
    await press(callbackDataForAlertView(created.id));
    await press(callbackDataForAlertDelete(created.id));

    for (const text of texts()) {
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('null');
      expect(text).not.toContain('Error');
      expect(text).not.toContain('ECONNREFUSED');
    }
  });
});

async function createAlertForTest(
  harness: UxHarness,
  userId: string,
): Promise<Alert> {
  const result = await harness.alerts.create(userId, {
    type: 'PRICE_ABOVE',
    symbol: 'IR_GOLD_18K',
    targetPrice: 18_000_000,
  });

  if (!result.ok) {
    throw new Error(`could not create the alert: ${result.reason}`);
  }

  return result.alert;
}

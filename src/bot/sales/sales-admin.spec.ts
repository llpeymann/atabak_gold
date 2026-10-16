import {
  createUxHarness,
  EnvMap,
  PlatformCall,
  UxHarness,
} from '../../testing/test-doubles';
import { formatPhoneFa } from '../../sales/phone';
import { LeadRecord } from '../../sales/sales.types';
import {
  callbackDataForSalesLeadNote,
  callbackDataForSalesLeadSale,
} from '../ux/callback-data';
import { parseSaleInput, parseSalesCommand } from './sales-admin.service';

const ADMIN_ID = '900';
const ADMIN_KEY = `bale:${ADMIN_ID}`;
const OTHER_ID = '901';
const REFERENCE = 'SL-ABCDEFGH';

const ENV: EnvMap = {
  SALES_ENGINE_ENABLED: 'true',
  SALES_DATA_FILE: '',
  SALES_ADMIN_USER_IDS: ADMIN_KEY,
  SALES_NOTIFICATION_MAX_ATTEMPTS: '1',
  SALES_NOTIFICATION_RETRY_DELAY_MS: '0',
  CHANNEL_ADMIN_USER_IDS: ADMIN_KEY,
};

let updateId = 0;

/**
 * Phase 9 §10/§14/§15 — the operator surface: what an authorized operator can do, what a non-admin
 * cannot even see, and what happens when a write does not reach the disk.
 *
 * The surface is exercised through the real router (authorization lives there as well), so a
 * failure here means the bot really would behave differently in production.
 */
describe('SalesAdminService (Phase 9 §10/§14)', () => {
  let ux: UxHarness;

  beforeEach(async () => {
    ux = createUxHarness(ENV);
    await ux.store.ensureLoaded();
    await ux.sales.load();
  });

  const message = async (
    text: string,
    platformUserId = ADMIN_ID,
  ): Promise<void> =>
    ux.botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: (updateId += 1) + 10_000,
      platformUserId,
      chatId: platformUserId,
      text,
      messageId: 100 + updateId,
    });

  const press = async (
    data: string,
    platformUserId = ADMIN_ID,
  ): Promise<void> =>
    ux.botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: (updateId += 1) + 10_000,
      platformUserId,
      chatId: platformUserId,
      messageId: 200 + updateId,
      callbackId: `cb-${updateId}`,
      data,
    });

  const texts = (): string =>
    ux
      .rendered()
      .map((call) => call.text ?? '')
      .join('\n---\n');
  const lastText = (): string => ux.last().text ?? '';

  const createLead = async (
    name = 'مهدی کریمی',
    platformUserId = '500',
  ): Promise<LeadRecord> => {
    const result = await ux.sales.service.createLead({
      userId: `usr-${platformUserId}`,
      identityKey: `bale:${platformUserId}`,
      platform: 'bale',
      platformUserId,
      chatId: platformUserId,
      customerName: name,
      phone: '۰۹۱۲۱۱۱۲۲۲۳',
      category: 'MANUFACTURED_GOLD',
      productDescription: 'دستبند ۱۸ عیار',
      notes: 'تماس بعد از ۱۸',
      submissionKey: `sub_${platformUserId}_${name}`,
      consentTextVersion: 'sales-consent-v1',
    });

    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }

    return result.value.lead;
  };

  const toCustomer = async (lead: LeadRecord): Promise<void> => {
    // Domain signature: (reference, status, actor).
    await ux.sales.service.changeStatus(lead.leadId, 'CONTACTED', ADMIN_KEY);
    await ux.sales.service.changeStatus(lead.leadId, 'QUALIFIED', ADMIN_KEY);
    await press(`v1:salesadm:convyes:${lead.leadId}`);
  };

  const statusOf = (lead: LeadRecord): string | undefined =>
    ux.sales.service.findLead(lead.leadId)?.status;

  // --- parser -------------------------------------------------------------------------------

  describe('command parser', () => {
    it('parses the documented forms and rejects anything malformed', () => {
      expect(parseSalesCommand('/sales')).toEqual({ action: 'list', page: 1 });
      expect(parseSalesCommand('/sales list 3')).toEqual({
        action: 'list',
        page: 3,
      });
      expect(parseSalesCommand('/sales list x')).toEqual({ action: 'invalid' });
      expect(parseSalesCommand('/sales list 0')).toEqual({ action: 'invalid' });
      expect(parseSalesCommand('/sales help')).toEqual({ action: 'help' });
      expect(parseSalesCommand('/sales find علی رضا')).toEqual({
        action: 'find',
        query: 'علی رضا',
      });
      expect(parseSalesCommand('/sales find')).toEqual({ action: 'invalid' });
      expect(parseSalesCommand('/sales filter status:NEW cat:COIN')).toEqual({
        action: 'filter',
        filters: { status: 'NEW', category: 'COIN' },
      });
      expect(parseSalesCommand('/sales filter nothing:1')).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand('/sales filter clear')).toEqual({
        action: 'filter',
        clearFilters: true,
      });

      expect(parseSalesCommand(`/sales show ${REFERENCE}`)).toEqual({
        action: 'show',
        reference: REFERENCE,
      });
      expect(parseSalesCommand(`/sales show ${REFERENCE} extra`)).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand('/sales show')).toEqual({ action: 'invalid' });
      expect(parseSalesCommand(`/sales history ${REFERENCE}`)).toEqual({
        action: 'history',
        reference: REFERENCE,
      });
      expect(
        parseSalesCommand(`/sales contact ${REFERENCE} تماس گرفتم`),
      ).toEqual({
        action: 'contact',
        reference: REFERENCE,
        note: 'تماس گرفتم',
      });
      expect(
        parseSalesCommand(`/sales note ${REFERENCE} یادداشت کوتاه`),
      ).toEqual({
        action: 'note',
        reference: REFERENCE,
        note: 'یادداشت کوتاه',
      });
      expect(parseSalesCommand(`/sales note ${REFERENCE}`)).toEqual({
        action: 'invalid',
      });
      expect(
        parseSalesCommand(`/sales assign ${REFERENCE} ${ADMIN_ID}`),
      ).toEqual({
        action: 'assign',
        reference: REFERENCE,
        assignee: ADMIN_ID,
      });
      expect(parseSalesCommand(`/sales assign ${REFERENCE}`)).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand(`/sales status ${REFERENCE} qualified`)).toEqual(
        {
          action: 'status',
          reference: REFERENCE,
          status: 'QUALIFIED',
        },
      );
      expect(parseSalesCommand(`/sales status ${REFERENCE}`)).toEqual({
        action: 'invalid',
      });
      expect(
        parseSalesCommand(`/sales lost ${REFERENCE} PRICE گران بود`),
      ).toEqual({
        action: 'lost',
        reference: REFERENCE,
        reason: 'PRICE',
        note: 'گران بود',
      });
      expect(parseSalesCommand(`/sales lost ${REFERENCE}`)).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand(`/sales sale ${REFERENCE}`)).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand(`/sales sale ${REFERENCE} -`)).toEqual({
        action: 'sale',
        reference: REFERENCE,
        amount: '-',
        note: undefined,
      });
      expect(
        parseSalesCommand(`/sales sale ${REFERENCE} 120000000 TOMAN فروش نقدی`),
      ).toEqual({
        action: 'sale',
        reference: REFERENCE,
        amount: '120000000',
        currency: 'TOMAN',
        note: 'فروش نقدی',
      });
      expect(parseSalesCommand('/sales frobnicate')).toEqual({
        action: 'invalid',
      });
      expect(parseSalesCommand('/start')).toEqual({ action: 'invalid' });
    });

    it('requires an explicit currency and never guesses one', () => {
      expect(parseSaleInput('-')).toEqual({
        ok: true,
        amount: null,
        currency: null,
      });
      expect(parseSaleInput('۱۲۰,۰۰۰,۰۰۰ toman')).toEqual({
        ok: true,
        amount: 120_000_000,
        currency: 'TOMAN',
      });
      expect(parseSaleInput('2500 EUR')).toEqual({
        ok: false,
        message: 'واحد پول فقط TOMAN یا RIAL می‌تواند باشد.',
      });
      expect(parseSaleInput('120000000')).toMatchObject({ ok: false });
      expect(parseSaleInput('0 TOMAN')).toMatchObject({ ok: false });
      expect(parseSaleInput('-5 TOMAN')).toMatchObject({ ok: false });
      expect(parseSaleInput('12.5 TOMAN')).toMatchObject({ ok: false });
      expect(parseSaleInput('100 TOMAN extra')).toMatchObject({ ok: false });
      expect(parseSaleInput('')).toMatchObject({ ok: false });
    });
  });

  // --- authorization ------------------------------------------------------------------------

  describe('authorization', () => {
    it('shows a non-admin the ordinary menu and no lead data at all', async () => {
      const lead = await createLead();

      await message('/sales', OTHER_ID);

      expect(texts()).not.toContain(lead.reference);
      expect(texts()).toContain('منوی اصلی');
    });

    it('declines an unauthorized callback without changing anything', async () => {
      const lead = await createLead();

      await press(`v1:salesadm:st:${lead.leadId}:CONTACTED`, OTHER_ID);

      expect(statusOf(lead)).toBe('NEW');
      expect(texts()).not.toContain(lead.reference);
      expect(
        ux.platform.calls.some((call) => call.alertText === 'دسترسی ندارید'),
      ).toBe(true);
    });

    it('keeps the platform inside the identity of an administrator', async () => {
      const lead = await createLead();

      expect(ux.sales.admin.isAdmin('telegram', ADMIN_ID)).toBe(false);
      expect(ux.sales.admin.isAdmin('bale', ADMIN_ID)).toBe(true);

      await ux.botUx.handleUpdate({
        kind: 'message',
        platform: 'telegram',
        updateId: 20_001,
        platformUserId: ADMIN_ID,
        chatId: ADMIN_ID,
        text: '/sales',
        messageId: 20_001,
      });

      expect(texts()).not.toContain(lead.reference);
    });

    it('leaks nothing when no administrator is configured', async () => {
      const bare = createUxHarness({
        ...ENV,
        SALES_ADMIN_USER_IDS: '',
        CHANNEL_ADMIN_USER_IDS: '',
      });
      await bare.store.ensureLoaded();
      await bare.sales.load();

      expect(bare.sales.admin.enabled).toBe(false);

      await bare.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 20_002,
        platformUserId: '777',
        chatId: '777',
        text: '/sales',
        messageId: 20_002,
      });

      const rendered = bare
        .rendered()
        .map((call: PlatformCall) => call.text ?? '')
        .join('\n');

      expect(rendered).not.toContain('درخواست‌های استعلام');
      expect(rendered).toContain('منوی اصلی');
    });

    it('explains that the engine is off instead of pretending to work', async () => {
      const off = createUxHarness({ ...ENV, SALES_ENGINE_ENABLED: 'false' });
      await off.store.ensureLoaded();
      await off.sales.load();

      expect(off.sales.admin.engineEnabled).toBe(false);

      await off.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 20_003,
        platformUserId: ADMIN_ID,
        chatId: ADMIN_ID,
        text: '/sales',
        messageId: 20_003,
      });

      const rendered = off
        .rendered()
        .map((call: PlatformCall) => call.text ?? '')
        .join('\n');

      expect(rendered).toContain('فعال نیست');
      expect(rendered).toContain('SALES_ENGINE_ENABLED');
    });
  });

  // --- list / detail / search ---------------------------------------------------------------

  describe('listing, detail and search', () => {
    it('lists the newest requests first, paginates them, and clamps a page beyond the end', async () => {
      const leads: LeadRecord[] = [];

      for (let index = 0; index < 7; index += 1) {
        leads.push(await createLead(`مشتری شماره ${index}`, `60${index}`));
      }

      await message('/sales');

      // Page size 5, newest first, and the list never dumps a contact number.
      expect(lastText()).toContain(leads[6].reference);
      expect(lastText()).toContain(leads[2].reference);
      expect(lastText()).not.toContain(leads[1].reference);
      expect(lastText()).not.toContain('تماس:');
      expect(lastText()).toContain('مجموع: ۷ درخواست');

      await message('/sales list 2');

      expect(lastText()).toContain(leads[1].reference);
      expect(lastText()).toContain(leads[0].reference);
      expect(lastText()).not.toContain(leads[6].reference);

      // A page beyond the end is clamped to the last page instead of rendering an empty screen.
      await message('/sales list 99');
      expect(lastText()).toContain(leads[0].reference);
      expect(lastText()).not.toContain(leads[6].reference);
    });

    it('finds a request by reference, name or a phone fragment in Persian digits', async () => {
      const lead = await createLead('نگار احمدی');

      await message(`/sales find ${lead.reference}`);
      expect(lastText()).toContain(lead.reference);

      await message('/sales find نگار');
      expect(lastText()).toContain(lead.reference);

      await message('/sales find 1112223');
      expect(lastText()).toContain(lead.reference);

      await message('/sales find ۱۱۱۲۲۲۳');
      expect(lastText()).toContain(lead.reference);

      await message('/sales find هیچ‌کس');
      expect(lastText()).toContain('پیدا نشد');
    });

    it('filters by status, category and a Tehran date range, and clears the filter', async () => {
      const lead = await createLead('سارا نیکی');

      await message('/sales filter status:CONTACTED');

      expect(lastText()).toContain('مجموع: ۰ درخواست');

      await message(`/sales filter status:NEW cat:MANUFACTURED_GOLD`);

      expect(lastText()).toContain(lead.reference);

      await message('/sales filter cat:COIN');

      expect(lastText()).toContain('مجموع: ۰ درخواست');

      await message('/sales filter clear');

      expect(lastText()).toContain(lead.reference);

      // A date outside the range excludes the lead; a valid Tehran date keeps it.
      await message('/sales filter from:2026-01-01 to:2026-01-02');
      expect(lastText()).toContain('مجموع: ۰ درخواست');

      // An unknown status is not silently applied: the operator sees that it was ignored.
      await message('/sales filter clear');
      await message('/sales filter status:NOT_A_STATUS');
      expect(lastText()).toContain('شناخته نشد و نادیده گرفته شد');
      expect(lastText()).toContain(lead.reference);
      expect(ux.sales.service.findLead(lead.leadId)?.status).toBe('NEW');
    });

    it('shows the detail with the contact, the operator facts and the attribution state', async () => {
      const lead = await createLead();

      await message(`/sales show ${lead.reference}`);

      const detail = lastText();

      expect(detail).toContain(lead.reference);
      expect(detail).toContain('مهدی کریمی');
      // The authorized operator is the person who has to call the customer: they see the number.
      expect(detail).toContain(formatPhoneFa(lead.phone));
      // No campaign → an explicit unknown, never an invented one.
      expect(detail).toContain('📣 کمپین: نامشخص');
      expect(detail).toContain('وضعیت: 🆕 جدید');
      // The Phase 8 link is reported as a fact, including the case “recorded without a campaign”.
      expect(detail).toContain('🔗 فاز ۸: سرنخ: RECORDED');
      // No internal lead id is exposed, only the customer-safe reference.
      expect(detail).not.toContain(lead.leadId);
    });

    it('answers a missing request without inventing one', async () => {
      await message('/sales show SL-ZZZZZZZZ');

      expect(lastText()).toContain('پیدا نشد');
    });
  });

  // --- mutations ----------------------------------------------------------------------------

  describe('mutations', () => {
    it('records a status change with the actor and refuses an impossible one', async () => {
      const lead = await createLead();

      await message(`/sales status ${lead.reference} CONTACTED`);

      expect(statusOf(lead)).toBe('CONTACTED');
      expect(
        ux.sales.service
          .listActivities(lead.leadId)
          .some(
            (row) =>
              row.action === 'STATUS_CHANGED' &&
              row.actor === ADMIN_KEY &&
              row.toStatus === 'CONTACTED',
          ),
      ).toBe(true);

      await message(`/sales status ${lead.reference} CONVERTED`);

      expect(statusOf(lead)).toBe('CONTACTED');
      // Converting needs the explicit conversion command (and its confirmation button).
      expect(lastText()).toContain('تبدیل به مشتری');
    });

    it('requires a documented loss reason and keeps the note', async () => {
      const lead = await createLead();

      await message(`/sales lost ${lead.reference} PRICE گران بود`);

      const stored = ux.sales.service.findLead(lead.leadId);

      expect(stored?.status).toBe('LOST');
      expect(stored?.lossReason).toBe('PRICE');
      expect(stored?.lossNote).toBe('گران بود');

      await message(`/sales lost ${lead.reference} BECAUSE_I_SAID_SO`);

      expect(statusOf(lead)).toBe('LOST');
      expect(lastText()).toContain('معتبر نیست');
    });

    it('reports a failed write as a failure and leaves the stored state unchanged', async () => {
      const lead = await createLead();
      const spy = jest
        .spyOn(ux.sales.store, 'transact')
        .mockRejectedValueOnce(new Error('disk full'));

      await message(`/sales status ${lead.reference} CONTACTED`);

      expect(statusOf(lead)).toBe('NEW');
      expect(lastText()).toContain('انجام نشد');

      spy.mockRestore();

      // Recording attempts are closed, so the log line does not claim a success either.
      expect(
        ux.sales.service
          .listActivities(lead.leadId)
          .some((row) => row.action === 'STATUS_CHANGED'),
      ).toBe(false);

      await message(`/sales status ${lead.reference} CONTACTED`);
      expect(statusOf(lead)).toBe('CONTACTED');
    });

    it('collects a note as a separate message and never swallows a command as note text', async () => {
      const lead = await createLead();

      await press(callbackDataForSalesLeadNote(lead.leadId), ADMIN_ID);
      await message('با مشتری صحبت شد', ADMIN_ID);

      expect(
        ux.sales.service
          .listActivities(lead.leadId)
          .some(
            (row) => row.action === 'NOTE_ADDED' && row.actor === ADMIN_KEY,
          ),
      ).toBe(true);

      // A command ends the pending state: it must not be stored as a note.
      await press(callbackDataForSalesLeadNote(lead.leadId), ADMIN_ID);
      await message('/sales');

      expect(
        ux.sales.service
          .listActivities(lead.leadId)
          .filter((row) => row.action === 'NOTE_ADDED'),
      ).toHaveLength(1);
      expect(ux.sales.admin.hasPendingInput('usr-500')).toBe(false);
    });

    it('converts a customer only through the explicit confirmation button', async () => {
      const lead = await createLead();

      await message(`/sales status ${lead.reference} CONTACTED`);
      await message(`/sales status ${lead.reference} QUALIFIED`);

      // The button shows a confirmation screen first: no customer is created by one press.
      await press(`v1:salesadm:conv:${lead.leadId}`);
      expect(statusOf(lead)).toBe('QUALIFIED');

      await press(`v1:salesadm:convyes:${lead.leadId}`);

      expect(statusOf(lead)).toBe('CONVERTED');
      expect(
        ux.sales.service
          .listActivities(lead.leadId)
          .some(
            (row) =>
              row.action === 'CUSTOMER_CONVERTED' && row.actor === ADMIN_KEY,
          ),
      ).toBe(true);
    });

    it('records a sale with an explicit unit, and a missing amount is not a zero', async () => {
      const lead = await createLead();
      await toCustomer(lead);

      await press(callbackDataForSalesLeadSale(lead.leadId), ADMIN_ID);
      await message('-', ADMIN_ID);

      const withoutAmount = ux.sales.service.activeOutcome(lead.leadId);

      expect(withoutAmount?.amount).toBeNull();
      expect(withoutAmount?.currency).toBeNull();
      expect(withoutAmount?.recordedBy).toBe(ADMIN_KEY);

      await message(`/sales sale ${lead.reference} 250,000,000 TOMAN`);

      const corrected = ux.sales.service.activeOutcome(lead.leadId);

      expect(corrected?.amount).toBe(250_000_000);
      expect(corrected?.currency).toBe('TOMAN');

      // The earlier row is superseded, never overwritten: the correction stays auditable.
      const all = ux.sales.service.listOutcomes(lead.leadId);

      expect(all).toHaveLength(2);
      expect(all.filter((row) => row.status === 'CORRECTED')).toHaveLength(1);
    });

    it('assigns an operator from the configured allow-list only', async () => {
      const lead = await createLead();

      await message(`/sales assign ${lead.reference} ${ADMIN_ID}`);

      expect(ux.sales.service.findLead(lead.leadId)?.assignedTo).toBe(
        ADMIN_KEY,
      );

      await message(`/sales assign ${lead.reference} 123456`);

      expect(ux.sales.service.findLead(lead.leadId)?.assignedTo).toBe(
        ADMIN_KEY,
      );
      expect(lastText()).toContain('کارشناسان مجاز');

      await message(`/sales assign ${lead.reference} none`);

      expect(ux.sales.service.findLead(lead.leadId)?.assignedTo).toBeNull();
    });

    it('shows the history with the audit trail and the Phase 8 state', async () => {
      const lead = await createLead();

      await message(`/sales status ${lead.reference} CONTACTED`);
      await message(`/sales history ${lead.reference}`);

      const history = lastText();

      // Every row carries the timestamp, the human summary and the actor.
      expect(history).toContain('وضعیت: NEW → CONTACTED');
      expect(history).toContain('درخواست استعلام ثبت شد.');
      expect(history).toContain(`<code>${ADMIN_KEY}</code>`);
      expect(history).toContain('<code>usr-500</code>');
    });

    it('retries the integration links and reports what really happened', async () => {
      const lead = await createLead();

      await message('/sales retry');

      const retry = lastText();

      expect(retry).toContain('بازبینی‌شده');
      expect(retry).toContain('اطلاع‌رسانی‌های در انتظار');
      // The link that was already recorded is not recorded twice, and the report says so.
      expect(ux.sales.service.findLead(lead.leadId)?.phase8.status).toBe(
        'RECORDED',
      );
      // …and no second Phase 8 row was written for the same identity.
      expect(
        ux.campaigns.store
          .listConversions()
          .filter((row) => row.type === 'LEAD'),
      ).toHaveLength(1);
    });
  });

  // --- statistics ---------------------------------------------------------------------------

  describe('statistics', () => {
    it('separates requests, customers and recorded sales, and never invents revenue', async () => {
      const first = await createLead('مشتری یک', '701');
      await createLead('مشتری دو', '702');
      await createLead('مشتری سه', '703');

      await toCustomer(first);
      await message(`/sales sale ${first.reference} -`);

      await message('/sales stats');

      const stats = lastText();

      expect(stats).toContain('🆕 جدید: ۲');
      expect(stats).toContain('✅ مشتری‌شده: ۱');
      expect(stats).toContain('🛒 فروش ثبت‌شده (ردیف فعال): ۱');
      expect(stats).toContain('مبلغ تأییدشده‌ای ثبت نشده است.');
      // Leads are reported per campaign label, and unattributed leads are named as such.
      expect(stats).toContain('بدون انتساب');
      expect(stats).toContain(
        'شناسه‌های یک پلتفرم با پلتفرم دیگر ادغام نمی‌شوند',
      );
    });
  });
});

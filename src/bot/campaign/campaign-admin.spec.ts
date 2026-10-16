import { createUxHarness, UxHarness } from '../../testing/test-doubles';
import { parseCampaignCommand } from './campaign-admin.service';

const ADMIN_ENV = {
  CHANNEL_ADMIN_USER_IDS: 'bale:1000',
  CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
  BALE_BOT_USERNAME: 'atabak_bot',
  TELEGRAM_BOT_USERNAME: 'atabak_tg_bot',
};

/**
 * Phase 8 §9/§14/§15 — the admin-only campaign dashboard inside the bot.
 *
 * The parser is tested directly (a malformed command must never reach the domain layer) and the
 * surface is exercised through the real router, because authorization lives there too.
 */
describe('CampaignAdminService (Phase 8 §9/§14)', () => {
  let ux: UxHarness;

  beforeEach(async () => {
    ux = createUxHarness(ADMIN_ENV);
    await ux.store.ensureLoaded();
  });

  const asAdmin = async (text: string) =>
    ux.botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: 1,
      platformUserId: '1000',
      chatId: '1000',
      text,
      messageId: 1,
    });

  const asUser = async (text: string, id = '2000') =>
    ux.botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: 2,
      platformUserId: id,
      chatId: id,
      text,
      messageId: 2,
    });

  describe('command parser', () => {
    it('parses the documented forms and rejects anything malformed', () => {
      expect(parseCampaignCommand('/campaign')).toEqual({
        action: 'list',
        page: 1,
      });
      expect(parseCampaignCommand('/campaign list 3')).toEqual({
        action: 'list',
        page: 3,
      });
      expect(parseCampaignCommand('/campaign list x')).toEqual({
        action: 'invalid',
      });
      expect(
        parseCampaignCommand(
          '/campaign new telegram_ad BOT_START alert کمپین تازه',
        ),
      ).toEqual({
        action: 'new',
        source: 'telegram_ad',
        destinationType: 'BOT_START',
        destination: 'alert',
        name: 'کمپین تازه',
      });
      expect(
        parseCampaignCommand('/campaign new telegram_ad OPEN_REDIRECT alert x'),
      ).toEqual({
        action: 'invalid',
      });
      expect(parseCampaignCommand('/campaign cost cmp_1 100 EUR')).toEqual({
        action: 'cost',
        id: 'cmp_1',
        amount: '100',
        currency: 'EUR',
      });
      expect(
        parseCampaignCommand(
          '/campaign import cmp_1 telegram_ads IMPRESSION 500 2026-10-01 2026-10-01 --replace',
        ),
      ).toMatchObject({
        action: 'import',
        replace: true,
        metric: 'IMPRESSION',
      });
      expect(
        parseCampaignCommand(
          '/campaign lead bale:1234 2026-10-05 12:30 یادداشت',
        ),
      ).toMatchObject({
        action: 'lead',
        userReference: 'bale:1234',
        time: '2026-10-05',
        note: '12:30 یادداشت',
      });
      expect(parseCampaignCommand('/campaign correct cnv_1')).toMatchObject({
        action: 'correct',
        id: 'cnv_1',
      });
      expect(parseCampaignCommand('/campaign nonsense')).toEqual({
        action: 'invalid',
      });
    });

    it('rejects a forged or oversized campaign id inside a callback payload', () => {
      expect(parseCampaignCommand('/campaign show ../../etc/passwd')).toEqual({
        action: 'show',
        id: '../../etc/passwd',
      });
      // The parser is permissive about the *token* it forwards…
      const forged = parseCampaignCommand('/campaign show https://evil.test');
      expect(forged.action).toBe('show');
      // …but the domain layer answers with “not found” — nothing is fetched or redirected.
    });
  });

  describe('authorization (§14)', () => {
    it('never discloses the surface to a non-admin and changes nothing', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین مدیر');

      await asUser('/campaign');
      await asUser('/campaign new instagram BOT_START prices کمپین نفوذی');
      await asUser('/campaign lead bale:2000 now');

      expect(ux.campaigns.store.campaignCount).toBe(1);
      expect(ux.campaigns.store.listConversions()).toHaveLength(0);
      // The ordinary menu was served instead of the dashboard.
      expect(ux.last().text).toContain('منوی اصلی');
    });

    it('refuses a campaign button pressed by a non-admin', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین مدیر');

      await ux.botUx.handleUpdate({
        kind: 'callback',
        platform: 'bale',
        updateId: 3,
        platformUserId: '2000',
        chatId: '2000',
        callbackId: 'cb-1',
        data: 'v1:camp:act:cmp_1',
        messageId: 2,
      });

      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ACTIVE');
      const acknowledgements = ux.platform.calls.filter(
        (call) => call.kind === 'ack',
      );
      expect(acknowledgements.length).toBeGreaterThan(0);
      expect(acknowledgements[0]?.alertText).toBe('این بخش در دسترس نیست.');
    });

    it('rejects a malformed campaign callback payload before it reaches the surface', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین مدیر');

      await ux.botUx.handleUpdate({
        kind: 'callback',
        platform: 'bale',
        updateId: 4,
        platformUserId: '1000',
        chatId: '1000',
        callbackId: 'cb-2',
        // Not a `cmp_<n>` id: the router treats it as an unknown action.
        data: 'v1:camp:end:../../etc',
        messageId: 3,
      });

      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ACTIVE');
    });
  });

  describe('dashboard screens (§9.1)', () => {
    it('creates a campaign and shows its tracked links', async () => {
      await asAdmin(
        '/campaign new instagram BOT_START prices کمپین اینستاگرام',
      );
      expect(ux.campaigns.store.campaignCount).toBe(1);

      await asAdmin('/campaign links cmp_1');
      const text = ux.last().text ?? '';

      expect(text).toContain('track.example.test/c/');
      expect(text).toContain('?p=telegram');
      expect(text).toContain('کلیک');
    });

    it('renders every metric with its counting kind and prints N/A instead of a number', async () => {
      await asAdmin(
        '/campaign new instagram BOT_START prices کمپین اینستاگرام',
      );
      await asAdmin('/campaign stats cmp_1 30');

      const text = ux.last().text ?? '';

      expect(text).toContain('کاربر یکتا');
      expect(text).toContain('کل رویدادها');
      expect(text).toContain('داده واردشده (تجمیعی)');
      expect(text).toContain('در دسترس نیست');
      expect(text).toContain('تعریف‌نشده');
      expect(text).not.toContain('Infinity');
      expect(text).not.toContain('NaN');
    });

    it('lists campaigns with pagination and answers the aggregate report', async () => {
      for (let index = 0; index < 3; index += 1) {
        await asAdmin(
          `/campaign new instagram BOT_START prices کمپین ${index}`,
        );
      }

      await asAdmin('/campaign list 1');
      expect(ux.last().text).toContain('صفحه');

      await asAdmin('/campaign report 30');
      const report = ux.last().text ?? '';

      expect(report).toContain('جمع کل');
      expect(report).toContain('رتبه‌بندی کمپین‌ها');
      expect(report).toContain('منابع موجود');

      await asAdmin('/campaign compare 7');
      expect(ux.last().text).toContain('مقایسه بازه');
    });

    it('registers a lead and a customer for an attributed user, and corrects it', async () => {
      await asAdmin(
        '/campaign new instagram BOT_START prices کمپین اینستاگرام',
      );

      // Simulate the campaign start of a real user (the funnel is described in its own suite).
      const campaign = ux.campaigns.store.listCampaigns()[0];

      if (!campaign) {
        throw new Error('campaign missing');
      }

      await ux.campaigns.tracking.recordStart({
        platform: 'bale',
        platformUserId: '3000',
        payload: `c_${campaign.trackingToken}`,
        occurredAt: new Date(Date.now() - 60 * 60_000),
      });

      await asAdmin('/campaign lead bale:3000 now تماس اول');
      expect(ux.last().text).toContain('سرنخ ثبت شد');

      await asAdmin('/campaign customer bale:3000 now خرید');
      expect(ux.last().text).toContain('مشتری ثبت شد');

      const lead = ux.campaigns.store
        .listConversions()
        .find((row) => row.type === 'LEAD');

      await asAdmin(`/campaign correct ${lead?.conversionId ?? 'cnv_1'}`);
      expect(ux.last().text).toContain('اصلاح ثبت شد');
    });

    it('imports an aggregate and refuses a bare duplicate', async () => {
      await asAdmin(
        '/campaign new instagram BOT_START prices کمپین اینستاگرام',
      );

      await asAdmin(
        '/campaign import cmp_1 telegram_ads IMPRESSION 1000 2026-10-05 2026-10-05',
      );
      expect(ux.last().text).toContain('داده تجمیعی ثبت شد');

      await asAdmin(
        '/campaign import cmp_1 telegram_ads IMPRESSION 1000 2026-10-05 2026-10-05',
      );
      expect(ux.last().text).toContain('❌');
    });

    it('changes status, cost and date range through the surface', async () => {
      await asAdmin(
        '/campaign new instagram BOT_START prices کمپین اینستاگرام',
      );

      await asAdmin('/campaign pause cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('PAUSED');

      await asAdmin('/campaign activate cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ACTIVE');

      await asAdmin('/campaign cost cmp_1 120 eur');
      expect(ux.campaigns.store.listCampaigns()[0]?.costCurrency).toBe('EUR');

      await asAdmin('/campaign range cmp_1 2026-10-01 2026-10-31');
      const ranged = ux.campaigns.store.listCampaigns()[0];
      expect(ranged?.startAt).toBe('2026-09-30T20:30:00.000Z');
      expect(ranged?.endAt).toBe('2026-10-31T20:29:00.000Z');

      await asAdmin('/campaign end cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ENDED');
    });

    it('explains an invalid command instead of guessing', async () => {
      await asAdmin('/campaign cost cmp_1 100');
      expect(ux.last().text).toContain('واحد پول');

      await asAdmin('/campaign range cmp_1 10/01/2026 2026-10-31');
      expect(ux.last().text).toContain('YYYY-MM-DD');
    });

    it('hides the surface entirely while tracking is disabled but keeps the data readable', async () => {
      const disabled = createUxHarness({
        ...ADMIN_ENV,
        CAMPAIGN_TRACKING_ENABLED: 'false',
      });
      await disabled.store.ensureLoaded();

      await disabled.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 1,
        platformUserId: '1000',
        chatId: '1000',
        text: '/campaign',
        messageId: 1,
      });

      expect(disabled.last().text).toContain('ردیابی کمپین فعال نیست');
      expect(disabled.campaigns.store.campaignCount).toBe(0);
    });
  });
  describe('admin buttons (§6.3/§9)', () => {
    const press = async (data: string, id = '1000') =>
      ux.botUx.handleUpdate({
        kind: 'callback',
        platform: 'bale',
        updateId: 11,
        platformUserId: id,
        chatId: id,
        callbackId: 'cb-btn',
        data,
        messageId: 5,
      });

    const lastAck = () =>
      ux.platform.calls.filter((call) => call.kind === 'ack').at(-1);

    it('pauses and re-activates a campaign through its real buttons', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین دکمه‌ای');

      await press('v1:camp:pause:cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('PAUSED');
      expect(lastAck()?.alertText).toBe('وضعیت: متوقف');

      await press('v1:camp:act:cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ACTIVE');
      expect(lastAck()?.alertText).toBe('وضعیت: فعال');
    });

    it('ends a campaign from a button and refuses to change it afterwards', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین پایانی');

      await press('v1:camp:end:cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ENDED');

      await press('v1:camp:act:cmp_1');
      expect(ux.campaigns.store.listCampaigns()[0]?.status).toBe('ENDED');
      expect(ux.last().text).toContain('وضعیت');
    });

    it('opens the list, detail, links and stats screens through their buttons', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین صفحه');

      await press('v1:camp:list:1');
      expect(ux.last().text).toContain('کمپین صفحه');

      await press('v1:camp:view:cmp_1');
      expect(ux.last().text).toContain('cmp_1');

      await press('v1:camp:links:cmp_1');
      expect(ux.last().text).toContain('track.example.test/c/');

      await press('v1:camp:stats:cmp_1');
      expect(ux.last().text).toContain('کاربر یکتا');
    });

    it('answers a button for a campaign that does not exist without exposing anything', async () => {
      await asAdmin('/campaign new instagram BOT_START prices کمپین موجود');

      await press('v1:camp:view:cmp_999');
      expect(ux.last().text).toContain('پیدا نشد');
    });
  });
});

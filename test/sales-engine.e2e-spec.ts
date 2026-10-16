import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';

import { AppModule } from './../src/app.module';
import { AppConfigService } from './../src/config/app-config.service';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { CampaignService } from './../src/campaigns/campaign.service';
import { CampaignStore } from './../src/campaigns/campaign.store';
import { CampaignTrackingService } from './../src/campaigns/campaign-tracking.service';
import { SalesService } from './../src/sales/sales.service';
import { SalesStore } from './../src/sales/sales.store';
import { UserStore } from './../src/users/user.store';

let updateId = 0;

/**
 * Phase 9 end-to-end: the purchase journey of a *tracked* visitor through the real application, the
 * Phase 8 attribution that journey writes, and the durability of a stored request across restart.
 *
 * The whole module graph boots (config, market engine, campaign tracking, sales engine, bot router);
 * only the platform transport is doubled, so no network access is required. Both data files live in
 * the suite's throw-away directory (`test/setup-env.ts`).
 */
describe('Sales engine (e2e)', () => {
  let app: INestApplication;
  let botUx: BotUxService;
  let sales: SalesService;
  let store: SalesStore;
  let campaignStore: CampaignStore;

  /** Platform user id of the operator (the allow-list stores the qualified `bale:<id>` form). */
  const admin = 'e2e-sales-admin';
  const adminKey = 'bale:e2e-sales-admin';
  const customer = 'e2e-user';
  const chat = 'e2e-chat';

  beforeAll(async () => {
    const httpDouble = {
      post: () => of({ data: { ok: true, result: { message_id: 42 } } }),
      get: () => of({ data: { prices: {} } }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      .compile();

    app = moduleFixture.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    botUx = app.get(BotUxService);
    sales = app.get(SalesService);
    store = app.get(SalesStore);
    campaignStore = app.get(CampaignStore);

    await app.get(UserStore).ensureLoaded();
    await store.ensureLoaded();
    await campaignStore.ensureLoaded();

    expect(app.get(AppConfigService).salesEnabled).toBe(true);
    expect(app.get(AppConfigService).salesAdminIds).toContain(adminKey);
  });

  afterAll(async () => {
    await app.close();
  });

  const message = async (
    text: string,
    platformUserId = customer,
    chatId = chat,
  ): Promise<void> =>
    botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: (updateId += 1) + 50_000,
      platformUserId,
      chatId,
      text,
      messageId: 300 + updateId,
    });

  const press = async (
    data: string,
    platformUserId = customer,
    chatId = chat,
  ): Promise<void> =>
    botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: (updateId += 1) + 50_000,
      platformUserId,
      chatId,
      messageId: 555,
      callbackId: `cb-${updateId}`,
      data,
    });

  let campaignId = '';

  it('turns a tracked visitor’s purchase request into an attributed, persisted lead', async () => {
    const campaigns = app.get(CampaignService);
    const tracking = app.get(CampaignTrackingService);

    const created = await campaigns.createCampaign({
      name: 'کمپین تست فاز ۹',
      source: 'telegram_ad',
      medium: 'post',
      destinationType: 'BOT_START',
      destination: 'prices',
      createdBy: adminKey,
    });

    expect(created.ok).toBe(true);

    if (!created.ok) {
      throw new Error(`${created.code}: ${created.message}`);
    }

    campaignId = created.value.campaignId;

    // The documented Phase 8 entry path: a tracked link hands the bot `/start c_<token>`.
    await message(`/start c_${created.value.trackingToken}`);
    expect(tracking.enabled).toBe(true);

    await message('/buy');
    await press('v1:sales:cat:MANUFACTURED_GOLD');
    await message('نگار احمدی');
    await message('۰۹۱۲۳۳۳۴۴۴۵');
    await message('دستبند ۱۸ عیار');
    await message('-');

    // Nothing is stored before the explicit confirmation.
    expect(store.listLeads()).toHaveLength(0);

    await press('v1:sales:confirm');

    const leads = store.listLeads();

    expect(leads).toHaveLength(1);

    const lead = leads[0];

    expect(lead.reference).toMatch(/^SL-/u);
    expect(lead.phone).toBe('+989123334445');
    expect(lead.phoneVerified).toBe(false);
    expect(lead.identityKey).toBe(`bale:${customer}`);
    // Attribution comes from the persisted Phase 8 evidence of this identity.
    expect(lead.campaignId).toBe(campaignId);

    const rows = campaignStore.listConversions();

    expect(
      rows.filter(
        (row) => row.type === 'LEAD' && row.identityKey === lead.identityKey,
      ),
    ).toHaveLength(1);
  });

  it('records the customer and the sale only through authorized operator actions', async () => {
    const lead = store.listLeads()[0];

    // An unauthorized visitor cannot change anything.
    await message(
      `/sales status ${lead.reference} CONTACTED`,
      'someone-else',
      'other-chat',
    );
    expect(sales.findLead(lead.leadId)?.status).toBe('NEW');

    await message(
      `/sales status ${lead.reference} CONTACTED`,
      admin,
      'admin-chat',
    );
    await message(
      `/sales status ${lead.reference} QUALIFIED`,
      admin,
      'admin-chat',
    );
    expect(sales.findLead(lead.leadId)?.status).toBe('QUALIFIED');

    // Conversion needs the explicit confirmation button, and it writes the Phase 8 customer row.
    await press(`v1:salesadm:convyes:${lead.leadId}`, admin, 'admin-chat');
    expect(sales.findLead(lead.leadId)?.status).toBe('CONVERTED');

    const customerRows = campaignStore
      .listConversions()
      .filter(
        (row) =>
          row.type === 'CUSTOMER' && row.identityKey === lead.identityKey,
      );

    expect(customerRows).toHaveLength(1);
    expect(customerRows[0].campaignId).toBe(campaignId);

    await message(
      `/sales sale ${lead.reference} 120,000,000 TOMAN`,
      admin,
      'admin-chat',
    );

    const outcome = sales.activeOutcome(lead.leadId);

    expect(outcome?.amount).toBe(120_000_000);
    expect(outcome?.currency).toBe('TOMAN');
    expect(outcome?.recordedBy).toBe(adminKey);
    // The outcome is the *only* place a sale exists; recording it must not add a second conversion
    // row: `ConversionType` has exactly two members (`LEAD`/`CUSTOMER`), and the lead was already
    // converted once by the explicit confirmation above. (The previous spelling compared against a
    // type member that does not exist — `'SALE'` — which was a permanent compile error in the dev
    // tsconfig and made this line assert nothing at runtime.)
    expect(outcome?.status).toBe('ACTIVE');

    const conversionsAfterSale = campaignStore
      .listConversions()
      .filter(
        (row) =>
          row.identityKey === lead.identityKey && row.type === 'CUSTOMER',
      );

    // Exactly one customer conversion for this identity: the explicit confirmation wrote it, and
    // recording the sale did not write a second one.
    expect(conversionsAfterSale).toHaveLength(1);
    expect(conversionsAfterSale[0].recordedBy).toBe(adminKey);
    expect(sales.listAllOutcomes()).toHaveLength(1);

    // …and the sale is what a conversion *counts as sold* — never an inferred one.
    expect(
      sales.listAllOutcomes().filter((row) => row.status === 'ACTIVE'),
    ).toHaveLength(1);
  });

  it('keeps the request across a restart and adds a genuinely new request without merging', async () => {
    const before = store.listLeads();

    // A fresh store over the same file is exactly what a process restart does.
    const reloaded = new SalesStore(app.get(AppConfigService));

    await reloaded.ensureLoaded();

    expect(reloaded.listLeads().map((lead) => lead.reference)).toContain(
      before[0].reference,
    );

    // Re-sending the very same submission resolves to the stored request: no duplicate.
    const repeated = await sales.createLead({
      userId: 'usr-e2e-user',
      identityKey: `bale:${customer}`,
      platform: 'bale',
      platformUserId: customer,
      chatId: chat,
      customerName: 'نگار احمدی',
      phone: '۰۹۱۲۳۳۳۴۴۴۵',
      category: 'MANUFACTURED_GOLD',
      productDescription: null,
      notes: null,
      submissionKey: before[0].submissionKey,
      consentTextVersion: 'sales-consent-v1',
    });

    expect(repeated.ok).toBe(true);

    if (repeated.ok) {
      expect(repeated.value.created).toBe(false);
      expect(repeated.value.lead.leadId).toBe(before[0].leadId);
    }

    expect(reloaded.listLeads()).toHaveLength(before.length);

    // A *different* submission key is a second, legitimate request: requests are never merged by
    // phone number, because two people can share a number.
    const fresh = await sales.createLead({
      userId: 'usr-e2e-user-2',
      identityKey: 'bale:e2e-user-2',
      platform: 'bale',
      platformUserId: 'e2e-user-2',
      chatId: chat,
      customerName: 'نگار احمدی',
      phone: '۰۹۱۲۳۳۳۴۴۴۵',
      category: 'COIN',
      productDescription: null,
      notes: null,
      submissionKey: 'sub_second_request',
      consentTextVersion: 'sales-consent-v1',
    });

    expect(fresh.ok).toBe(true);
    expect(store.listLeads()).toHaveLength(before.length + 1);
  });
});

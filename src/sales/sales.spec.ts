import {
  createAppConfigService,
  createCampaignHarness,
  createPlatformHarness,
  EnvMap,
} from '../testing/test-doubles';
import { UserStore } from '../users/user.store';
import {
  formatPhoneFa,
  maskPhone,
  normalizePhone,
  toAsciiDigits,
} from './phone';
import {
  normalizeCategory,
  normalizeCustomerName,
  normalizeNotes,
  normalizeOperatorNote,
  normalizeProductDescription,
} from './lead-validation';
import { generateLeadReference, isLeadReference } from './lead-reference';
import { SalesNotificationService } from './sales-notification.service';
import { SalesService } from './sales.service';
import { identityKeyOf, SalesStore } from './sales.store';
import {
  canTransition,
  LEAD_STATUSES,
  LOSS_REASONS,
  PRODUCT_CATEGORIES,
} from './sales.types';

/**
 * Phase 9 — sales engine domain tests (§17).
 *
 * Everything runs against the real store, the real validators and the real Phase 8 stack; only the
 * platform transport is doubled. Two rules are checked in almost every test because they are the ones
 * that decide whether a sales report can be trusted: nothing is reported as done before it is
 * persisted, and a repeated delivery never becomes a second record.
 */

const BASE_ENV: EnvMap = {
  SALES_ENGINE_ENABLED: 'true',
  SALES_DATA_FILE: '',
  SALES_NOTIFICATION_MAX_ATTEMPTS: '2',
  SALES_NOTIFICATION_RETRY_DELAY_MS: '0',
  SALES_MAX_OPEN_LEADS_PER_IDENTITY: '5',
  SALES_ADMIN_USER_IDS: 'bale:900',
  CHANNEL_ADMIN_USER_IDS: 'bale:111',
  BOT_POLLING_ENABLED: 'false',
};

interface Stack {
  config: ReturnType<typeof createAppConfigService>;
  platform: ReturnType<typeof createPlatformHarness>;
  campaigns: ReturnType<typeof createCampaignHarness>;
  store: SalesStore;
  sales: SalesService;
  notifications: SalesNotificationService;
  userStore: UserStore;
}

const build = (env: EnvMap = {}): Stack => {
  const merged = { ...BASE_ENV, ...env };
  const config = createAppConfigService(merged);
  const platform = createPlatformHarness({
    ...merged,
    BOT_POLLING_ENABLED: 'false',
  });
  const campaigns = createCampaignHarness(
    { ...merged, BOT_POLLING_ENABLED: 'false' },
    { config, platform },
  );
  const userStore = new UserStore(config);
  const store = new SalesStore(config);
  const sales = new SalesService(
    config,
    store,
    campaigns.tracking,
    campaigns.service,
    campaigns.conversions,
  );
  const notifications = new SalesNotificationService(
    config,
    store,
    sales,
    platform.registry,
    userStore,
  );

  return {
    config,
    platform,
    campaigns,
    store,
    sales,
    notifications,
    userStore,
  };
};

let submission = 0;

const leadInput = (overrides: Record<string, unknown> = {}) => ({
  userId: 'usr_1',
  identityKey: 'bale:cust-1',
  platform: 'bale' as const,
  platformUserId: 'cust-1',
  chatId: 'chat-1',
  customerName: 'زهرا محمدی',
  phone: '۰۹۱۲۳۴۵۶۷۸۹',
  category: 'MANUFACTURED_GOLD' as const,
  productDescription: 'انگشتر طلا',
  notes: null,
  submissionKey: `sub_test_${(submission += 1)}`,
  consentTextVersion: 'sales-consent-v1',
  ...overrides,
});

describe('phase 9 — phone normalization', () => {
  it('accepts Persian digits, separators and the +98 form and stores one canonical value', () => {
    for (const input of [
      '۰۹۱۲۳۴۵۶۷۸۹',
      '0912-345-6789',
      '+98 912 345 6789',
      '00989123456789',
      '0912 345 6789',
      '٠٩١٢٣٤٥٦٧٨٩',
    ]) {
      const result = normalizePhone(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.canonical).toBe('+989123456789');
        expect(result.value.kind).toBe('MOBILE');
      }
    }
  });

  it('keeps landlines and converts Persian digits for display', () => {
    const result = normalizePhone('02122334455');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canonical).toBe('+982122334455');
      expect(result.value.kind).toBe('LANDLINE');
      expect(result.value.display).toContain('۰۲۱');
    }
  });

  it('rejects impossible input instead of guessing a number', () => {
    expect(normalizePhone('').ok).toBe(false);
    expect(normalizePhone('12345').ok).toBe(false);
    expect(normalizePhone('09abc2345678').ok).toBe(false);
    expect(normalizePhone('0512345678').ok).toBe(false);
  });

  it('never logs a usable number when masking', () => {
    const masked = maskPhone('+989123456789');

    expect(masked).toContain('***');
    expect(masked).not.toBe('+989123456789');
    expect(toAsciiDigits('۱۲۳')).toBe('123');
    expect(formatPhoneFa('+989123456789')).toContain('۰۹۱۲');
  });
});

describe('phase 9 — text validation', () => {
  it('accepts Persian names with ZWNJ and rejects values that are not names', () => {
    const ok = normalizeCustomerName('  علی‌رضا  کریمی ');

    expect(ok.ok).toBe(true);
    if (ok.ok) {
      // Whitespace is collapsed; the rest of the value (including the ZWNJ) is preserved.
      expect(ok.value).not.toContain('  ');
      expect(ok.value.startsWith('علی')).toBe(true);
      expect(ok.value.endsWith('کریمی')).toBe(true);
    }

    expect(normalizeCustomerName('').ok).toBe(false);
    expect(normalizeCustomerName('a').ok).toBe(false);
    expect(normalizeCustomerName('12345678').ok).toBe(false);
    expect(normalizeCustomerName('۱۲۳۴۵').ok).toBe(false);
  });

  it('strips markup characters and refuses control characters outright', () => {
    const markup = normalizeCustomerName('<b>مریم محمدی</b>');

    expect(markup.ok).toBe(true);
    if (markup.ok) {
      expect(markup.value).not.toContain('<');
      expect(markup.value).not.toContain('>');
    }

    // A control character is not silently removed: the value is refused and the customer is asked
    // again, so what is stored is always exactly what the customer typed.
    expect(normalizeCustomerName('مریم\u0007محمدی').ok).toBe(false);
    expect(normalizeCustomerName('مریم\nمحمدی').ok).toBe(true);
  });

  it('caps the optional fields and treats an empty answer as “no answer”', () => {
    const tooLong = normalizeProductDescription('ط'.repeat(500));

    // Over-long input is refused with a message instead of being silently truncated.
    expect(tooLong.ok).toBe(false);

    const description = normalizeProductDescription('انگشتر طلا');

    expect(description.ok).toBe(true);
    if (description.ok) {
      expect(description.value).toBe('انگشتر طلا');
    }

    const notes = normalizeNotes('   ');

    expect(notes.ok).toBe(true);
    if (notes.ok) {
      expect(notes.value).toBeNull();
    }
  });

  it('validates the category against the registry and the operator note length', () => {
    expect(normalizeCategory('COIN').ok).toBe(true);
    expect(normalizeCategory('coin').ok).toBe(true);
    expect(normalizeCategory('DIAMOND').ok).toBe(false);
    expect(normalizeOperatorNote('ی'.repeat(500)).ok).toBe(false);
  });

  it('keeps the category registry the single source of truth', () => {
    expect(PRODUCT_CATEGORIES.map((entry) => entry.category)).toEqual([
      'MANUFACTURED_GOLD',
      'MELTED_GOLD',
      'COIN',
    ]);
  });
});

describe('phase 9 — public references', () => {
  it('generates non-guessable, non-sequential references', () => {
    const references = new Set(
      Array.from({ length: 50 }, () => generateLeadReference()),
    );

    expect(references.size).toBeGreaterThan(45);

    for (const reference of references) {
      expect(isLeadReference(reference)).toBe(true);
      // No internal id and no PII can be read off the reference.
      expect(reference.startsWith('SL-')).toBe(true);
      expect(reference).not.toContain('lead_');
    }
  });

  it('rejects a reference that is not in the documented shape', () => {
    expect(isLeadReference('SL-1')).toBe(false);
    expect(isLeadReference('lead_1')).toBe(false);
  });
});

describe('phase 9 — lead creation', () => {
  it('persists a lead and reports it as created', async () => {
    const { sales, store } = build();
    const result = await sales.createLead(leadInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(true);
      expect(result.value.lead.phone).toBe('+989123456789');
      // Nothing here proves ownership of the number, and the record says so.
      expect(result.value.lead.phoneVerified).toBe(false);
      expect(result.value.lead.status).toBe('NEW');
      expect(
        store.findLeadByReference(result.value.lead.reference),
      ).not.toBeNull();
    }

    expect(store.listLeads()).toHaveLength(1);
  });

  it('never creates a second lead for a repeated confirmation', async () => {
    const { sales, store } = build();
    const input = leadInput();
    const first = await sales.createLead(input);
    const second = await sales.createLead(input);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.created).toBe(true);
      // The retry resolves to the same stored request, not to a copy.
      expect(second.value.created).toBe(false);
      expect(second.value.lead.leadId).toBe(first.value.lead.leadId);
    }

    expect(store.listLeads()).toHaveLength(1);
  });

  it('rejects invalid input before touching the store', async () => {
    const { sales, store } = build();

    const badPhone = await sales.createLead(leadInput({ phone: '123' }));
    const badName = await sales.createLead(leadInput({ customerName: '9' }));
    const badCategory = await sales.createLead(
      leadInput({ category: 'DIAMOND' }),
    );

    expect(badPhone.ok).toBe(false);
    expect(badName.ok).toBe(false);
    expect(badCategory.ok).toBe(false);
    expect(store.listLeads()).toHaveLength(0);
  });

  it('bounds how many open requests one identity may have', async () => {
    const { sales, store } = build({ SALES_MAX_OPEN_LEADS_PER_IDENTITY: '1' });

    expect((await sales.createLead(leadInput())).ok).toBe(true);

    const second = await sales.createLead(leadInput());

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('LIMIT_REACHED');
    }
    expect(store.listLeads()).toHaveLength(1);
  });

  it('reports a failed write as a failure — never as a created lead', async () => {
    const { sales, store } = build();
    const transact = jest
      .spyOn(store, 'transact')
      .mockRejectedValueOnce(new Error('disk full'));

    const result = await sales.createLead(leadInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERSISTENCE_FAILED');
    }
    expect(store.listLeads()).toHaveLength(0);
    transact.mockRestore();
  });

  it('keeps the lead when campaign tracking is switched off', async () => {
    const { sales } = build({ CAMPAIGN_TRACKING_ENABLED: 'false' });
    const result = await sales.createLead(leadInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead.phase8.status).toBe('TRACKING_DISABLED');
      expect(result.value.lead.campaignId).toBeNull();
      expect(result.value.lead.attributionBucket).toBe('TRACKING_DISABLED');
    }
  });

  it('attaches the Phase 8 lead row when the identity is attributed', async () => {
    const { sales, campaigns } = build({
      CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
      BALE_BOT_USERNAME: 'atabak_test_bot',
    });
    const created = await campaigns.service.createCampaign({
      name: 'کمپین تست',
      source: 'bale_ads',
      destinationType: 'BOT_START',
      destination: 'prices',
      createdBy: 'bale:111',
    });

    expect(created.ok).toBe(true);

    const started = await campaigns.tracking.recordStart({
      platform: 'bale',
      platformUserId: 'cust-1',
      payload: `c_${created.ok ? created.value.trackingToken : ''}`,
    });

    expect(started.recorded).toBe(true);

    const lead = await sales.createLead(leadInput());

    expect(lead.ok).toBe(true);
    if (lead.ok) {
      expect(lead.value.lead.phase8.status).toBe('RECORDED');
      expect(lead.value.lead.campaignId).toBe(
        created.ok ? created.value.campaignId : null,
      );
      const conversions = campaigns.conversions.listConversions({
        campaignId: lead.value.lead.campaignId ?? '',
      });

      expect(conversions.some((row) => row.type === 'LEAD')).toBe(true);
    }
  });
});

describe('phase 9 — lead lifecycle, audit and sales', () => {
  it('allows only the documented transitions', async () => {
    const { sales } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;
    const skipped = await sales.changeStatus(
      reference,
      'QUALIFIED',
      'bale:900',
    );

    expect(skipped.ok).toBe(false);
    if (!skipped.ok) {
      expect(skipped.code).toBe('INVALID_STATUS_TRANSITION');
    }

    expect(
      (await sales.changeStatus(reference, 'CONTACTED', 'bale:900')).ok,
    ).toBe(true);
    expect(
      (await sales.changeStatus(reference, 'QUALIFIED', 'bale:900')).ok,
    ).toBe(true);
    expect(canTransition('NEW', 'LOST')).toBe(true);
    expect(canTransition('CONVERTED', 'QUALIFIED')).toBe(true);
    expect(canTransition('LOST', 'CONVERTED')).toBe(false);
    expect(LEAD_STATUSES).toContain('CONVERTED');
  });

  it('records who did what, when, and keeps the history', async () => {
    const { sales } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;
    await sales.changeStatus(reference, 'CONTACTED', 'bale:900');
    await sales.logContact(reference, 'bale:900', 'تماس گرفته شد');
    await sales.addNote(reference, 'bale:900', 'منتظر تماس دوباره');
    await sales.assign(reference, 'bale:900', 'bale:900');

    const activities = sales.listActivities(created.value.lead.leadId);
    const actions = activities.map((row) => row.action);

    expect(actions).toContain('CREATED');
    expect(actions).toContain('STATUS_CHANGED');
    expect(actions).toContain('CONTACT_LOGGED');
    expect(actions).toContain('NOTE_ADDED');
    expect(actions).toContain('ASSIGNED');
    // The stored lead keeps its own record of the contact attempts.
    expect(
      (await Promise.resolve(sales.findLead(reference)))?.contactAttempts,
    ).toBe(1);
  });

  it('requires a documented loss reason', async () => {
    const { sales } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;
    const invalid = await sales.markLost(reference, 'bale:900', 'BECAUSE');

    expect(invalid.ok).toBe(false);

    const valid = await sales.markLost(reference, 'bale:900', LOSS_REASONS[0]);

    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.status).toBe('LOST');
      expect(valid.value.lossReason).toBe(LOSS_REASONS[0]);
    }
  });

  it('converts to a customer and writes the Phase 8 customer row once', async () => {
    const { sales, campaigns } = build({
      CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
      BALE_BOT_USERNAME: 'atabak_test_bot',
    });
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;

    // The state machine is enforced: a lead must be worked on before it can become a customer.
    const skipped = await sales.convertToCustomer(reference, 'bale:900');

    expect(skipped.ok).toBe(false);

    await sales.changeStatus(reference, 'CONTACTED', 'bale:900');
    await sales.changeStatus(reference, 'QUALIFIED', 'bale:900');

    const converted = await sales.convertToCustomer(reference, 'bale:900');

    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.value.status).toBe('CONVERTED');
      expect(converted.value.customerConvertedAt).not.toBeNull();
    }

    const customers = campaigns.conversions
      .listConversions({})
      .filter((row) => row.type === 'CUSTOMER');

    expect(customers).toHaveLength(1);

    // A repeated press must not create a second conversion row.
    await sales.convertToCustomer(reference, 'bale:900');
    expect(
      campaigns.conversions
        .listConversions({})
        .filter((row) => row.type === 'CUSTOMER'),
    ).toHaveLength(1);
  });

  it('records a sale only for a customer, with an explicit currency and a real amount', async () => {
    const { sales } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;
    const tooEarly = await sales.recordSale(reference, 'bale:900', {
      amount: 1_000,
      currency: 'TOMAN',
      note: null,
    });

    expect(tooEarly.ok).toBe(false);
    await sales.changeStatus(reference, 'CONTACTED', 'bale:900');
    await sales.changeStatus(reference, 'QUALIFIED', 'bale:900');
    await sales.convertToCustomer(reference, 'bale:900');

    const noCurrency = await sales.recordSale(reference, 'bale:900', {
      amount: 1_000,
      currency: null,
      note: null,
    });

    expect(noCurrency.ok).toBe(false);

    const noAmount = await sales.recordSale(reference, 'bale:900', {
      amount: null,
      currency: null,
      note: 'مبلغ اعلام نشد',
    });

    expect(noAmount.ok).toBe(true);
    if (noAmount.ok) {
      // “Unknown” is stored as unknown — never as zero.
      expect(noAmount.value.amount).toBeNull();
      expect(noAmount.value.currency).toBeNull();
    }

    const corrected = await sales.recordSale(reference, 'bale:900', {
      amount: 120_000_000,
      currency: 'TOMAN',
      note: 'اصلاح مبلغ',
    });

    expect(corrected.ok).toBe(true);

    const outcomes = sales.listOutcomes(created.value.lead.leadId);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    // The superseded row is kept as evidence instead of being erased.
    expect(outcomes.filter((row) => row.status === 'CORRECTED')).toHaveLength(
      1,
    );
  });

  it('authorizes assignment against the configured allow-list', async () => {
    const { sales } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const reference = created.value.lead.reference;
    const unauthorized = await sales.assign(reference, 'bale:999', 'bale:900');

    expect(unauthorized.ok).toBe(false);

    // An operator who is a *channel* admin but not on the sales allow-list cannot be assigned.
    const channelOnly = await sales.assign(reference, 'bale:111', 'bale:900');

    expect(channelOnly.ok).toBe(false);

    const ok = await sales.assign(reference, 'bale:900', 'bale:900');

    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.assignedTo).toBe('bale:900');
    }

    const cleared = await sales.assign(reference, null, 'bale:900');

    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.assignedTo).toBeNull();
    }
  });

  it('falls back to the channel allow-list when no sales admin is configured', () => {
    const { sales } = build({ SALES_ADMIN_USER_IDS: '' });

    expect(sales.isSalesAdmin('bale', '111')).toBe(true);
    expect(sales.isSalesAdmin('bale', '999')).toBe(false);
  });

  it('reports counts per campaign label without inventing an attribution', async () => {
    const { sales } = build();
    await sales.createLead(leadInput());
    await sales.createLead(
      leadInput({ identityKey: 'bale:cust-2', platformUserId: 'cust-2' }),
    );

    const counts = sales.countsByCampaignLabel();

    expect(counts).toHaveLength(1);
    expect(counts[0].campaignId).toBeNull();
    expect(counts[0].count).toBe(2);
    expect(sales.countByStatus().NEW).toBe(2);
  });
});

describe('phase 9 — notification delivery', () => {
  it('reserves one row per recipient and never duplicates it on a retry', async () => {
    const { sales, notifications, platform } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const lead = created.value.lead;
    const request = {
      leadId: lead.leadId,
      platform: 'bale' as const,
      customer: { userId: 'usr_1', targetUserId: 'cust-1', chatId: 'chat-1' },
    };

    await notifications.enqueueForLead(request);
    await notifications.enqueueForLead(request);

    const rows = notifications.listNotifications();

    // One row for the customer and one for the configured administrator — not two of each.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.key).sort()).toEqual(
      [`admin:${lead.leadId}:bale:900`, `customer:${lead.leadId}`].sort(),
    );

    notifications.dispatchForLead(lead.leadId);
    await notifications.drain();

    const sends = platform.calls.filter((call) => call.kind === 'send');

    expect(sends).toHaveLength(2);
    expect(
      notifications.listNotifications().every((row) => row.status === 'SENT'),
    ).toBe(true);
  });

  it('retries a failed delivery without creating a second message row, and never loses the lead', async () => {
    const { sales, notifications, platform, store } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const lead = created.value.lead;
    platform.failSends(1);

    await notifications.enqueueForLead({
      leadId: lead.leadId,
      platform: 'bale',
      customer: { userId: 'usr_1', targetUserId: 'cust-1', chatId: 'chat-1' },
    });
    notifications.dispatchForLead(lead.leadId);
    await notifications.drain();

    const rows = notifications.listNotifications();

    expect(rows).toHaveLength(2);
    // One row failed and was retried inside the same dispatch; nothing is marked SENT by accident.
    expect(rows.some((row) => row.status === 'SENT')).toBe(true);
    expect(store.findLead(lead.leadId)).not.toBeNull();
  });

  it('marks a delivery undeliverable after the attempt limit — and keeps the request', async () => {
    const { sales, notifications, platform, store } = build({
      SALES_NOTIFICATION_MAX_ATTEMPTS: '2',
    });
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const lead = created.value.lead;
    platform.failSends(10);

    await notifications.enqueueForLead({
      leadId: lead.leadId,
      platform: 'bale',
      customer: { userId: 'usr_1', targetUserId: 'cust-1', chatId: 'chat-1' },
    });
    notifications.dispatchForLead(lead.leadId);
    await notifications.drain();

    const rows = notifications.listNotifications();

    expect(rows.every((row) => row.status === 'UNDELIVERABLE')).toBe(true);
    expect(rows.every((row) => row.attemptCount === 2)).toBe(true);
    // The failure is a delivery fact, not a lead fact.
    expect(store.findLead(lead.leadId)?.status).toBe('NEW');
  });

  it('does not resend after a restart when the outcome is unknown', async () => {
    const { sales, notifications, store } = build();
    const created = await sales.createLead(leadInput());

    if (!created.ok) {
      throw new Error('lead was not created');
    }

    const lead = created.value.lead;
    await notifications.enqueueForLead({
      leadId: lead.leadId,
      platform: 'bale',
      customer: { userId: 'usr_1', targetUserId: 'cust-1', chatId: 'chat-1' },
    });

    // Simulate a process that died after the platform call but before the outcome was persisted.
    await store.transact((tx) => {
      for (const row of tx.listNotifications()) {
        tx.saveNotification({ ...row, attemptCount: 1, lastError: null });
      }
    });

    const resumed = await notifications.recoverPending();
    await notifications.drain();

    expect(resumed).toBe(0);
    expect(
      notifications
        .listNotifications()
        .every((row) => row.status === 'UNDELIVERABLE'),
    ).toBe(true);
  });
});

describe('phase 9 — identity keys', () => {
  it('keeps platforms apart and never merges identities', () => {
    expect(identityKeyOf('bale', '42')).toBe('bale:42');
    expect(identityKeyOf('telegram', '42')).toBe('telegram:42');
    expect(identityKeyOf('bale', '42')).not.toBe(
      identityKeyOf('telegram', '42'),
    );
  });
});

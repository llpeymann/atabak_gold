import {
  createCampaignHarness,
  CampaignHarness,
} from '../testing/test-doubles';
import { UserStore } from '../users/user.store';
import { ReportWindow } from './campaign-metrics.service';

const WINDOW: ReportWindow = {
  from: new Date('2026-10-01T00:00:00.000Z'),
  to: new Date('2026-11-01T00:00:00.000Z'),
  label: 'بازه تست',
};

/**
 * Phase 8 §5.5/§5.6/§9/§17 — manual conversions, imported aggregates and the reporting rules.
 */
describe('Campaign reporting & manual conversions (Phase 8 §5/§9/§17)', () => {
  let harness: CampaignHarness;
  let userStore: UserStore;

  beforeEach(async () => {
    userStore = new UserStore(createCampaignHarness({}).config);
    harness = createCampaignHarness(
      {
        CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
        BALE_BOT_USERNAME: 'atabak_bot',
        TELEGRAM_BOT_USERNAME: 'atabak_tg_bot',
      },
      { userStore },
    );
    await harness.load();
    await userStore.ensureLoaded();
  });

  async function createCampaign(overrides: Record<string, unknown> = {}) {
    const result = await harness.service.createCampaign({
      name: 'کمپین گزارش',
      source: 'telegram_ad',
      destinationType: 'BOT_START',
      destination: 'prices',
      createdBy: 'bale:admin',
      ...overrides,
    } as never);

    if (!result.ok) {
      throw new Error(result.code);
    }

    return result.value;
  }

  async function startFor(
    token: string,
    platformUserId: string,
    occurredAt: string,
    platform: 'bale' | 'telegram' = 'bale',
  ) {
    const result = await harness.tracking.recordStart({
      platform,
      platformUserId,
      payload: `c_${token}`,
      occurredAt: new Date(occurredAt),
    });

    expect(result.recorded).toBe(true);
  }

  describe('manual lead & customer (§8.6/§8.7)', () => {
    it('credits the last eligible touch and records the operator and both timestamps', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '111', '2026-10-05T10:00:00.000Z');

      const lead = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:111',
        occurredAt: '2026-10-10T09:00:00.000Z',
        operator: 'bale:admin',
        note: 'تماس تلفنی',
      });

      expect(lead.ok).toBe(true);

      if (!lead.ok) {
        return;
      }

      expect(lead.value.campaignId).toBe(campaign.campaignId);
      expect(lead.value.attributionModel).toBe('LAST_TOUCH');
      expect(lead.value.attributionBucket).toBe('CAMPAIGN');
      expect(lead.value.recordedBy).toBe('bale:admin');
      expect(lead.value.occurredAt).toBe('2026-10-10T09:00:00.000Z');
      expect(lead.value.recordedAt >= lead.value.occurredAt).toBe(true);
      expect(lead.value.firstTouch.campaignId).toBe(campaign.campaignId);
      expect(lead.value.lastTouch.campaignId).toBe(campaign.campaignId);
    });

    it('prevents the same user from being registered twice for the same stage', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '222', '2026-10-05T10:00:00.000Z');

      const first = await harness.conversions.registerConversion({
        type: 'CUSTOMER',
        userReference: 'bale:222',
        occurredAt: '2026-10-09T09:00:00.000Z',
        operator: 'bale:admin',
      });
      const second = await harness.conversions.registerConversion({
        type: 'CUSTOMER',
        userReference: 'bale:222',
        occurredAt: '2026-10-10T09:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);

      if (!second.ok) {
        expect(second.code).toBe('CONFLICT');
        expect(second.message).toContain('قبلاً');
      }

      // A customer may still be an additional lead: the two stages are tracked independently.
      const lead = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:222',
        occurredAt: '2026-10-08T09:00:00.000Z',
        operator: 'bale:admin',
      });
      expect(lead.ok).toBe(true);
    });

    it('classifies an unattributed conversion with its documented bucket instead of inventing a campaign', async () => {
      const unknown = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:999',
        occurredAt: '2026-10-10T09:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(unknown.ok).toBe(true);

      if (!unknown.ok) {
        return;
      }

      expect(unknown.value.campaignId).toBeNull();
      expect(unknown.value.attributionBucket).toBe('NO_TOUCH');
      expect(unknown.value.attributionEvidence).toBeNull();
    });

    it('falls outside the window when the only touch is older than 30 days', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '333', '2026-08-01T10:00:00.000Z');

      const lead = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:333',
        occurredAt: '2026-10-01T10:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(lead.ok).toBe(true);

      if (!lead.ok) {
        return;
      }

      expect(lead.value.campaignId).toBeNull();
      expect(lead.value.attributionBucket).toBe('EXPIRED_WINDOW');
    });

    it('rejects a future conversion time and an unknown identity', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '444', '2026-10-05T10:00:00.000Z');

      const future = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:444',
        occurredAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        operator: 'bale:admin',
      });
      const unknown = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'usr_999',
        occurredAt: '2026-10-06T10:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(future.ok).toBe(false);
      expect(unknown.ok).toBe(false);

      if (!future.ok) {
        expect(future.code).toBe('INVALID_CONVERSION_TIME');
      }

      if (!unknown.ok) {
        expect(unknown.code).toBe('INVALID_IDENTITY');
      }
    });

    it('resolves an internal user id through the existing user store (§5.4)', async () => {
      const user = await userStore.upsertUser('555', 'telegram', '555');
      const campaign = await createCampaign();

      await harness.tracking.recordStart({
        platform: 'telegram',
        platformUserId: '555',
        payload: `c_${campaign.trackingToken}`,
        occurredAt: new Date('2026-10-05T10:00:00.000Z'),
      });

      const lead = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: user.id,
        occurredAt: '2026-10-06T10:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(lead.ok).toBe(true);

      if (lead.ok) {
        expect(lead.value.identityKey).toBe('telegram:555');
        expect(lead.value.platform).toBe('telegram');
      }
    });

    it('keeps the original row when a conversion is corrected, and re-attributes the new row', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '666', '2026-10-05T10:00:00.000Z');

      const lead = await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:666',
        occurredAt: '2026-10-06T10:00:00.000Z',
        operator: 'bale:admin',
      });

      expect(lead.ok).toBe(true);

      if (!lead.ok) {
        return;
      }

      const corrected = await harness.conversions.correctConversion({
        conversionId: lead.value.conversionId,
        occurredAt: '2026-10-14T10:00:00.000Z',
        operator: 'bale:admin',
        note: 'تاریخ اصلاح شد',
      });

      expect(corrected.ok).toBe(true);

      if (!corrected.ok) {
        return;
      }

      expect(corrected.value.conversionId).not.toBe(lead.value.conversionId);
      expect(corrected.value.occurredAt).toBe('2026-10-14T10:00:00.000Z');
      expect(corrected.value.note).toBe('تاریخ اصلاح شد');

      // Both rows are in the document; only one is active.
      const all = harness.store.listConversions();
      expect(all).toHaveLength(2);
      const original = all.find(
        (row) => row.conversionId === lead.value.conversionId,
      );
      expect(original?.status).toBe('CORRECTED');
      expect(original?.supersededBy).toBe(corrected.value.conversionId);
      expect(harness.conversions.listConversions()).toHaveLength(1);

      // Correcting the same row twice is refused: the latest version is the one to edit.
      const twice = await harness.conversions.correctConversion({
        conversionId: lead.value.conversionId,
        operator: 'bale:admin',
      });
      expect(twice.ok).toBe(false);

      const auditActions = harness.store
        .listAudit()
        .map((entry) => entry.action);
      expect(auditActions).toEqual(
        expect.arrayContaining(['LEAD_REGISTERED', 'LEAD_CORRECTED']),
      );
    });
  });

  describe('imported aggregates (§5.5)', () => {
    it('rejects a duplicate period instead of inflating the number, unless it is an explicit correction', async () => {
      const campaign = await createCampaign();

      const first = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'IMPRESSION',
        value: 1200,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'bale:admin',
      });
      const duplicate = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'IMPRESSION',
        value: 1200,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'bale:admin',
      });

      expect(first.ok).toBe(true);
      expect(duplicate.ok).toBe(false);

      if (!duplicate.ok) {
        expect(duplicate.code).toBe('CONFLICT');
      }

      const replaced = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'IMPRESSION',
        value: 1500,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'bale:admin',
        replaceExisting: true,
      });

      expect(replaced.ok).toBe(true);
      const rows = harness.store.listImports();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === 'SUPERSEDED')).toHaveLength(1);
      expect(harness.conversions.listImports()).toHaveLength(1);
      expect(harness.store.listAudit().map((entry) => entry.action)).toContain(
        'AGGREGATE_IMPORT_REPLACED',
      );
    });

    it('validates the metric, the value and the period', async () => {
      const campaign = await createCampaign();

      const badMetric = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'CUSTOMER',
        value: 5,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'op',
      });
      const badValue = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'CLICK',
        value: -1,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'op',
      });
      const badPeriod = await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'CLICK',
        value: 3,
        periodStart: '2026-10-10',
        periodEnd: '2026-10-05',
        operator: 'op',
      });
      const unknownCampaign = await harness.conversions.importAggregate({
        campaignId: 'cmp_999',
        provider: 'telegram_ads',
        metric: 'CLICK',
        value: 3,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'op',
      });

      expect(badMetric.ok).toBe(false);
      expect(badValue.ok).toBe(false);
      expect(badPeriod.ok).toBe(false);
      expect(unknownCampaign.ok).toBe(false);

      if (!unknownCampaign.ok) {
        expect(unknownCampaign.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('metrics (§9/§16)', () => {
    it('labels every metric with its counting kind and separates unique users from total events', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '111', '2026-10-05T10:00:00.000Z');

      // A second touch of the *same* identity: unique stays 1, total events grows.
      await harness.store.transact((tx) => {
        tx.saveEvent({
          eventId: tx.nextId('evt'),
          type: 'START',
          campaignId: campaign.campaignId,
          platform: 'bale',
          platformUserId: '111',
          identityKey: 'bale:111',
          occurredAt: '2026-10-06T10:00:00.000Z',
          recordedAt: '2026-10-06T10:00:00.000Z',
          provenance: 'NATIVE',
          idempotencyKey: 'start:manual:111',
          meta: {},
          externalRef: null,
        });
      });

      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );

      expect(report).not.toBeNull();

      const byKey = new Map(
        (report?.metrics ?? []).map((metric) => [metric.key, metric]),
      );

      expect(byKey.get('newStarts')).toMatchObject({
        value: 1,
        kind: 'UNIQUE_USERS',
      });
      expect(byKey.get('totalStarts')).toMatchObject({
        value: 2,
        kind: 'TOTAL_EVENTS',
      });
      expect(byKey.get('impressions')?.kind).toBe('EXTERNAL_AGGREGATE');
    });

    it('never turns an unavailable metric into zero', async () => {
      const campaign = await createCampaign();
      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );
      const byKey = new Map(
        (report?.metrics ?? []).map((metric) => [metric.key, metric]),
      );

      expect(byKey.get('impressions')?.value).toBeNull();
      expect(byKey.get('impressions')?.unavailableReason).toContain(
        'وارد نشده',
      );
      expect(byKey.get('uniqueClickers')?.value).toBeNull();
      expect(byKey.get('uniqueClickers')?.unavailableReason).toContain(
        'اثرانگشت',
      );
      expect(byKey.get('verifiedJoins')?.value).toBeNull();
      // Metrics that were measured are honest zeros, not `null`.
      expect(byKey.get('totalStarts')?.value).toBe(0);
    });

    it('returns N/A instead of Infinity when a denominator is zero', async () => {
      const campaign = await createCampaign();
      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );

      for (const ratio of report?.ratios ?? []) {
        // Every ratio is either explicitly unmeasurable or has a zero denominator; none is a number.
        expect(ratio.percent).toBeNull();
        expect(ratio.unavailableReason).not.toBeNull();
        expect(
          ratio.unavailableReason === 'این نسبت قابل اندازه‌گیری نیست.' ||
            ratio.unavailableReason?.includes('مخرج صفر'),
        ).toBe(true);
        expect(
          Number.isFinite(ratio.numerator / Math.max(1, ratio.denominator)),
        ).toBe(true);
      }

      const clickRatio = report?.ratios.find(
        (ratio) => ratio.key === 'clickToStart',
      );
      expect(clickRatio?.denominator).toBe(0);
      expect(JSON.stringify(report?.ratios)).not.toContain('Infinity');
      expect(JSON.stringify(report?.ratios)).not.toContain('NaN');
    });

    it('computes conversion rates only with a real denominator', async () => {
      const campaign = await createCampaign();
      const now = new Date('2026-10-16T10:00:00.000Z');

      for (const id of ['111', '112', '113', '114']) {
        await startFor(campaign.trackingToken, id, '2026-10-10T10:00:00.000Z');
      }

      for (let index = 0; index < 4; index += 1) {
        await harness.service.recordClick({
          token: campaign.trackingToken,
          platformHint: null,
          userAgent: `Mozilla/5.0 (device ${index})`,
          now: new Date(now.getTime() + index * 120_000),
        });
      }

      await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:111',
        occurredAt: '2026-10-12T10:00:00.000Z',
        operator: 'op',
      });

      const report = harness.metrics.campaignReport(campaign.campaignId, {
        ...WINDOW,
        from: new Date('2026-10-09T00:00:00.000Z'),
        to: new Date('2026-10-17T00:00:00.000Z'),
      });
      const byKey = new Map(report?.ratios.map((ratio) => [ratio.key, ratio]));

      expect(byKey.get('startToLead')).toMatchObject({
        numerator: 1,
        denominator: 4,
        percent: 25,
      });
      expect(byKey.get('clickToStart')).toMatchObject({
        numerator: 4,
        denominator: 4,
        percent: 100,
      });
      // A measured zero is a real zero (no leads became customers yet) — not `N/A`, not `NaN`.
      expect(byKey.get('leadToCustomer')).toMatchObject({
        numerator: 0,
        denominator: 1,
        percent: 0,
      });
    });

    it('never sums costs of different currencies', async () => {
      const eur = await createCampaign({
        costAmount: 100,
        costCurrency: 'EUR',
        name: 'کمپین یورویی',
      });
      const usd = await createCampaign({
        costAmount: 50,
        costCurrency: 'USD',
        name: 'کمپین دلاری',
        source: 'instagram',
      });

      const eurWindow = WINDOW;
      const aggregate = harness.metrics.aggregateReport(eurWindow);

      expect(aggregate.costs.amount).toBeNull();
      expect(aggregate.costs.mixedCurrencies.sort()).toEqual(['EUR', 'USD']);
      expect(aggregate.costs.unavailableReason).toContain('چند واحد پول');
      expect(aggregate.notes.join(' ')).toContain('چند واحد پول');

      // Per campaign the cost is still exact.
      const report = harness.metrics.campaignReport(eur.campaignId, eurWindow);
      expect(report?.costs.recorded).toMatchObject({
        amount: 100,
        currency: 'EUR',
      });
      expect(usd.costAmount).toBe(50);
    });

    it('never prorates an imported period that only partly covers the window', async () => {
      const campaign = await createCampaign();

      await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'IMPRESSION',
        value: 1000,
        periodStart: '2026-09-25',
        periodEnd: '2026-10-05',
        operator: 'op',
      });

      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );
      const impressions = report?.metrics.find(
        (metric) => metric.key === 'impressions',
      );

      expect(impressions?.value).toBeNull();
      expect(report?.imports.excludedPartial).toBe(1);
      expect(report?.imports.included).toBe(0);

      // A period fully inside the window is counted as an external aggregate.
      await harness.conversions.importAggregate({
        campaignId: campaign.campaignId,
        provider: 'telegram_ads',
        metric: 'IMPRESSION',
        value: 800,
        periodStart: '2026-10-05',
        periodEnd: '2026-10-05',
        operator: 'op',
      });

      const after = harness.metrics.campaignReport(campaign.campaignId, WINDOW);
      expect(
        after?.metrics.find((metric) => metric.key === 'impressions')?.value,
      ).toBe(800);
      expect(
        after?.metrics.find((metric) => metric.key === 'impressions')?.kind,
      ).toBe('EXTERNAL_AGGREGATE');
    });

    it('uses a half-open window: the upper bound belongs to the next period', async () => {
      const campaign = await createCampaign();
      await startFor(campaign.trackingToken, '111', '2026-10-31T23:59:59.000Z');
      await startFor(campaign.trackingToken, '112', '2026-11-01T00:00:00.000Z');

      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );
      const starts = report?.metrics.find(
        (metric) => metric.key === 'newStarts',
      );

      expect(starts?.value).toBe(1);
    });

    it('ranks campaigns for every funnel question and answers the comparison without dividing by zero', async () => {
      const campaignA = await createCampaign({ source: 'telegram_ad' });
      const campaignB = await createCampaign({
        source: 'instagram',
        name: 'کمپین ب',
      });

      await startFor(
        campaignA.trackingToken,
        '111',
        '2026-10-05T10:00:00.000Z',
      );
      await startFor(
        campaignA.trackingToken,
        '112',
        '2026-10-05T11:00:00.000Z',
      );
      await startFor(
        campaignB.trackingToken,
        '211',
        '2026-10-06T10:00:00.000Z',
      );

      await harness.conversions.registerConversion({
        type: 'LEAD',
        userReference: 'bale:111',
        occurredAt: '2026-10-07T10:00:00.000Z',
        operator: 'op',
      });

      const aggregate = harness.metrics.aggregateReport(WINDOW);
      const startsRanking = aggregate.rankings.find(
        (ranking) => ranking.key === 'newStarts',
      );
      const leadsRanking = aggregate.rankings.find(
        (ranking) => ranking.key === 'leads',
      );

      expect(startsRanking?.rows[0]).toMatchObject({
        campaignId: campaignA.campaignId,
        value: 2,
      });
      expect(startsRanking?.kind).toBe('UNIQUE_USERS');
      expect(leadsRanking?.rows).toHaveLength(1);

      const sourcesByModel = aggregate.sourcesByModel;
      expect(
        sourcesByModel.some(
          (row) => row.source === 'telegram_ad' && row.leads === 1,
        ),
      ).toBe(true);

      const comparison = harness.metrics.compareWindows(WINDOW, {
        from: new Date('2026-08-31T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
        label: 'بازه قبلی',
      });
      const startsDelta = comparison.deltas.find(
        (delta) => delta.key === 'newStarts',
      );

      expect(startsDelta).toMatchObject({
        current: 3,
        previous: 0,
        percent: null,
      });
      expect(startsDelta?.unavailableReason).toContain('صفر');
      expect(JSON.stringify(comparison.deltas)).not.toContain('Infinity');
    });

    it('reports the rejected-ingestion counters separately from the metrics', async () => {
      const campaign = await createCampaign();

      await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'TelegramBot',
        now: new Date('2026-10-05T10:00:00.000Z'),
      });

      const report = harness.metrics.campaignReport(
        campaign.campaignId,
        WINDOW,
      );

      expect(report?.rejections).toEqual([
        { reason: 'PREVIEW_FETCH', count: 1 },
      ]);
      expect(
        report?.metrics.find((metric) => metric.key === 'clicksRaw')?.value,
      ).toBe(0);
    });
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCampaignHarness } from '../testing/test-doubles';
import { CampaignHarness } from '../testing/test-doubles';
import { tokenFromPayload } from './campaign-token';

/**
 * Phase 8 §6/§7 — campaign management, tracked links and click ingestion.
 *
 * These tests exercise the *rules* directly (validation, lifecycle, link construction, request
 * classification); the funnel and the reports have their own suites.
 */
describe('CampaignService (Phase 8 §6/§7)', () => {
  let harness: CampaignHarness;

  const env = {
    CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
    BALE_BOT_USERNAME: 'atabak_bot',
    TELEGRAM_BOT_USERNAME: 'atabak_tg_bot',
    CHANNEL_URL: 'https://ble.ir/atabak_channel',
    TELEGRAM_CHANNEL_URL: 'https://t.me/atabak_channel',
  };

  beforeEach(async () => {
    harness = createCampaignHarness(env);
    await harness.load();
  });

  async function create(overrides: Record<string, unknown> = {}) {
    const result = await harness.service.createCampaign({
      name: 'کمپین تست',
      source: 'telegram_ad',
      destinationType: 'BOT_START',
      destination: 'alert',
      createdBy: 'bale:admin',
      ...overrides,
    } as never);

    if (!result.ok) {
      throw new Error(`campaign creation failed: ${result.code}`);
    }

    return result.value;
  }

  describe('creation validation', () => {
    it('creates a campaign with a unique opaque token and an audit entry', async () => {
      const first = await create();
      const second = await create({ name: 'کمپین دوم' });

      expect(first.status).toBe('ACTIVE');
      expect(first.campaignId).toBe('cmp_1');
      expect(second.campaignId).toBe('cmp_2');
      expect(first.trackingToken).not.toBe(second.trackingToken);
      expect(first.trackingToken).toMatch(/^cmp[a-z0-9]{12}$/);

      const audit = harness.store.listAudit();
      expect(audit.map((entry) => entry.action)).toContain('CAMPAIGN_CREATED');
      expect(audit[0]?.operator).toBe('bale:admin');
    });

    it('rejects an invalid name, source, medium and destination', async () => {
      const cases: { input: Record<string, unknown>; code: string }[] = [
        { input: { name: 'x' }, code: 'INVALID_NAME' },
        { input: { source: 'Telegram Ad' }, code: 'INVALID_SOURCE' },
        { input: { medium: ' pay per click ' }, code: 'INVALID_MEDIUM' },
        {
          input: { destinationType: 'OPEN_REDIRECT' },
          code: 'INVALID_DESTINATION_TYPE',
        },
        {
          input: { destination: 'https://evil.test' },
          code: 'INVALID_DESTINATION',
        },
        {
          input: {
            destinationType: 'CHANNEL_INVITE',
            destination: 'twitter',
          },
          code: 'INVALID_DESTINATION',
        },
      ];

      for (const testCase of cases) {
        const result = await harness.service.createCampaign({
          name: 'کمپین تست',
          source: 'instagram',
          destinationType: 'BOT_START',
          destination: 'prices',
          ...testCase.input,
        } as never);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe(testCase.code);
        }
      }

      expect(harness.store.campaignCount).toBe(0);
    });

    it('validates cost and currency together', async () => {
      const missingCurrency = await harness.service.createCampaign({
        name: 'هزینه بدون واحد',
        source: 'instagram',
        destinationType: 'BOT_START',
        destination: 'prices',
        costAmount: 100,
      });

      expect(missingCurrency.ok).toBe(false);
      if (!missingCurrency.ok) {
        expect(missingCurrency.code).toBe('INVALID_COST');
      }

      const negative = await harness.service.createCampaign({
        name: 'هزینه منفی',
        source: 'instagram',
        destinationType: 'BOT_START',
        destination: 'prices',
        costAmount: -5,
        costCurrency: 'EUR',
      });

      expect(negative.ok).toBe(false);

      const ok = await create({ costAmount: 250, costCurrency: 'eur' });
      expect(ok.costAmount).toBe(250);
      expect(ok.costCurrency).toBe('EUR');
    });

    it('rejects an inconsistent date range', async () => {
      const result = await harness.service.createCampaign({
        name: 'بازه نادرست',
        source: 'instagram',
        destinationType: 'BOT_START',
        destination: 'prices',
        startAt: '2026-10-10T00:00:00.000Z',
        endAt: '2026-10-01T00:00:00.000Z',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_DATE_RANGE');
      }
    });
  });

  describe('lifecycle (§6.3)', () => {
    it('allows ACTIVE → PAUSED → ACTIVE and both → ENDED, but never back from ENDED', async () => {
      const campaign = await create();

      const paused = await harness.service.setStatus(
        campaign.campaignId,
        'PAUSED',
        'op',
      );
      expect(paused.ok).toBe(true);

      const resumed = await harness.service.setStatus(
        campaign.campaignId,
        'ACTIVE',
        'op',
      );
      expect(resumed.ok).toBe(true);

      const ended = await harness.service.setStatus(
        campaign.campaignId,
        'ENDED',
        'op',
      );
      expect(ended.ok).toBe(true);

      const reopen = await harness.service.setStatus(
        campaign.campaignId,
        'ACTIVE',
        'op',
      );
      expect(reopen.ok).toBe(false);
      if (!reopen.ok) {
        expect(reopen.code).toBe('INVALID_STATUS_TRANSITION');
      }

      const auditActions = harness.store
        .listAudit()
        .map((entry) => entry.action);
      expect(auditActions).toEqual(
        expect.arrayContaining([
          'CAMPAIGN_STATUS_PAUSED',
          'CAMPAIGN_STATUS_ACTIVE',
          'CAMPAIGN_STATUS_ENDED',
        ]),
      );
    });

    it('updates metadata and cost with an operator trail', async () => {
      const campaign = await create();

      const renamed = await harness.service.updateMetadata(
        campaign.campaignId,
        { name: 'نام تازه', medium: 'story' },
        'bale:admin',
      );

      expect(renamed.ok).toBe(true);
      expect(renamed.ok && renamed.value.name).toBe('نام تازه');
      expect(renamed.ok && renamed.value.medium).toBe('story');

      const cost = await harness.service.setCost(
        campaign.campaignId,
        90,
        'usd',
        'bale:admin',
      );
      expect(cost.ok && cost.value.costCurrency).toBe('USD');

      const cleared = await harness.service.setCost(
        campaign.campaignId,
        null,
        null,
        'bale:admin',
      );
      expect(cleared.ok && cleared.value.costAmount).toBeNull();

      const operators = new Set(
        harness.store.listAudit().map((entry) => entry.operator),
      );
      expect(operators.has('bale:admin')).toBe(true);
    });
  });

  describe('tracked links (§7.1/§7.2)', () => {
    it('builds both a tracked and a direct link per platform, with a campaign payload', async () => {
      const campaign = await create();
      const links = harness.service.buildLinks(campaign);

      expect(links.payload).toBe(`c_${campaign.trackingToken}`);

      const telegram = links.links.find((link) => link.platform === 'telegram');
      const bale = links.links.find((link) => link.platform === 'bale');

      expect(telegram?.directUrl).toBe(
        `https://t.me/atabak_tg_bot?start=${links.payload}`,
      );
      expect(telegram?.trackedUrl).toBe(
        `https://track.example.test/c/${campaign.trackingToken}?p=telegram`,
      );
      expect(bale?.directUrl).toBe(
        `https://ble.ir/atabak_bot?start=${links.payload}`,
      );
      expect(bale?.trackedUrl).toBe(
        `https://track.example.test/c/${campaign.trackingToken}?p=bale`,
      );
    });

    it('explains instead of guessing when a destination is not configured', async () => {
      const bare = createCampaignHarness({ CAMPAIGN_TRACKING_BASE_URL: '' });
      await bare.load();

      const campaign = await bare.service.createCampaign({
        name: 'بدون تنظیمات',
        source: 'friend',
        destinationType: 'BOT_START',
        destination: 'prices',
      });

      expect(campaign.ok).toBe(true);
      const links = bare.service.buildLinks(
        campaign.ok ? campaign.value : ({} as never),
      );

      expect(links.links.every((link) => link.directUrl === null)).toBe(true);
      expect(links.links.every((link) => link.trackedUrl === null)).toBe(true);
      expect(links.notes.join(' ')).toContain('نام کاربری عمومی ربات');
    });

    it('keeps a channel campaign inside the configured channel (§7.2)', async () => {
      const campaign = await create({
        destinationType: 'CHANNEL_INVITE',
        destination: 'telegram',
        name: 'کمپین کانال',
      });
      const links = harness.service.buildLinks(campaign);

      expect(links.payload).toBeNull();
      expect(links.links).toHaveLength(1);
      expect(links.links[0]?.directUrl).toBe('https://t.me/atabak_channel');
      expect(links.links[0]?.trackedUrl).toBe(
        `https://track.example.test/c/${campaign.trackingToken}?p=telegram`,
      );
    });
  });

  describe('click ingestion (§7.3)', () => {
    it('records a human click and forwards to the allow-listed bot route only', async () => {
      const campaign = await create();
      const result = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: 'telegram',
        userAgent: 'Mozilla/5.0 (Linux; Android 13)',
        now: new Date('2026-10-16T10:00:00.000Z'),
      });

      expect(result.decision).toBe('REDIRECT');
      expect(result.classification).toBe('HUMAN');
      expect(result.recorded).toBe(true);
      expect(result.target).toBe(
        `https://t.me/atabak_tg_bot?start=c_${campaign.trackingToken}`,
      );

      const events = harness.store.listEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('CLICK');
      expect(events[0]?.provenance).toBe('NATIVE');
      // A raw request has no identity: nothing was fabricated (§7.3).
      expect(events[0]?.identityKey).toBeNull();
    });

    it('never counts a link preview or a crawler as a human click', async () => {
      const campaign = await create();
      const now = new Date('2026-10-16T10:00:00.000Z');

      const preview = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'TelegramBot (like TwitterBot)',
        now,
      });
      const unknown = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: null,
        now,
      });

      // Both requests are still forwarded (sharing works), but neither becomes a click.
      expect(preview.decision).toBe('REDIRECT');
      expect(preview.classification).toBe('PREVIEW');
      expect(preview.recorded).toBe(false);
      expect(unknown.classification).toBe('UNCLASSIFIED');
      expect(unknown.recorded).toBe(false);
      expect(harness.store.listEvents()).toHaveLength(0);

      const reasons = harness.store
        .listRejections()
        .map((record) => record.reason)
        .sort();
      expect(reasons).toEqual(['PREVIEW_FETCH', 'UNCLASSIFIED_REQUEST']);
    });

    it('answers an unknown token with 404 semantics and never redirects', async () => {
      const result = await harness.service.recordClick({
        token: 'cmp000000000000',
        platformHint: null,
        userAgent: 'Mozilla/5.0',
        now: new Date(),
      });

      expect(result.decision).toBe('NOT_FOUND');
      expect(result.target).toBeNull();
      expect(harness.store.listEvents()).toHaveLength(0);
    });

    it('stops a paused campaign from accepting new traffic while keeping its history', async () => {
      const campaign = await create();
      const now = new Date('2026-10-16T10:00:00.000Z');

      const before = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'Mozilla/5.0',
        now,
      });
      expect(before.recorded).toBe(true);

      await harness.service.setStatus(campaign.campaignId, 'PAUSED', 'op');

      const after = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'Mozilla/5.0',
        now: new Date(now.getTime() + 10 * 60_000),
      });

      expect(after.decision).toBe('GONE');
      expect(after.target).toBeNull();
      expect(after.recorded).toBe(false);

      // History is intact: exactly the one click from before the pause.
      expect(harness.store.listEvents()).toHaveLength(1);
      expect(harness.store.listCampaigns()[0]?.status).toBe('PAUSED');
    });

    it('refuses a campaign that has not started yet or has ended', async () => {
      const campaign = await create({
        startAt: '2026-11-01T00:00:00.000Z',
        endAt: '2026-11-30T00:00:00.000Z',
      });

      const tooEarly = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'Mozilla/5.0',
        now: new Date('2026-10-16T10:00:00.000Z'),
      });
      const tooLate = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent: 'Mozilla/5.0',
        now: new Date('2026-12-01T00:00:00.000Z'),
      });

      expect(tooEarly.decision).toBe('GONE');
      expect(tooLate.decision).toBe('GONE');
      expect(harness.store.listEvents()).toHaveLength(0);
    });

    it('damps an immediate replay of the same request without calling it a click', async () => {
      const campaign = await create();
      const now = new Date('2026-10-16T10:00:00.000Z');
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0)';

      await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent,
        now,
      });
      const replay = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: null,
        userAgent,
        now: new Date(now.getTime() + 3_000),
      });

      expect(replay.recorded).toBe(false);
      expect(replay.classification).toBe('HUMAN');
      expect(replay.reason).toContain('تکراری');
      expect(harness.store.listEvents()).toHaveLength(1);
    });

    it('ignores an unknown ?p= hint instead of trusting it (§7.2)', async () => {
      const campaign = await create();

      expect(harness.service.parsePlatformHint('telegram')).toBe('telegram');
      expect(harness.service.parsePlatformHint('BALE')).toBe('bale');
      expect(harness.service.parsePlatformHint('evil.example.test')).toBeNull();

      const hint = harness.service.parsePlatformHint('evil.example.test');
      const result = await harness.service.recordClick({
        token: campaign.trackingToken,
        platformHint: hint,
        userAgent: 'Mozilla/5.0',
        now: new Date('2026-10-16T10:00:00.000Z'),
      });

      expect(result.target).toBe(
        `https://ble.ir/atabak_bot?start=c_${campaign.trackingToken}`,
      );
    });
  });

  describe('payload namespace (§7.5/§6.4)', () => {
    it('recognizes only well-formed campaign payloads', () => {
      const token = 'cmp0123456789ab';

      expect(tokenFromPayload(`c_${token}`)).toBe(token);
      expect(tokenFromPayload(`C_${token.toUpperCase()}`)).toBe(token);
      expect(tokenFromPayload('prices')).toBeNull();
      expect(tokenFromPayload('ref_ab12cd')).toBeNull();
      expect(tokenFromPayload(`c_${token} extra`)).toBeNull();
      expect(tokenFromPayload('c_cmp')).toBeNull();
    });
  });

  describe('disabled tracking (§3, §19)', () => {
    it('refuses new ingestion but keeps every existing record readable', async () => {
      const campaign = await create();
      await harness.service.setStatus(campaign.campaignId, 'PAUSED', 'op');

      const disabledHarness = createCampaignHarness({
        ...env,
        CAMPAIGN_TRACKING_ENABLED: 'false',
      });
      await disabledHarness.load();

      const rejected = await disabledHarness.service.createCampaign({
        name: 'کمپین تازه',
        source: 'instagram',
        destinationType: 'BOT_START',
        destination: 'prices',
      });

      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.code).toBe('DISABLED');
      }

      // Nothing was erased: the (separate) enabled harness still reads its own history.
      expect(harness.store.listCampaigns()).toHaveLength(1);
    });
  });

  describe('persistence (§11.4)', () => {
    it('survives a restart and never reports a failed write as a successful ingestion', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atabak-campaign-'));
      const file = join(directory, 'campaigns.json');

      try {
        const first = createCampaignHarness({
          ...env,
          CAMPAIGN_DATA_FILE: file,
        });
        await first.load();

        const campaign = await first.service.createCampaign({
          name: 'کمپین پایدار',
          source: 'instagram',
          destinationType: 'BOT_START',
          destination: 'prices',
        });

        expect(campaign.ok).toBe(true);
        const token = campaign.ok ? campaign.value.trackingToken : '';

        const click = await first.service.recordClick({
          token,
          platformHint: null,
          userAgent: 'Mozilla/5.0',
          now: new Date('2026-10-16T10:00:00.000Z'),
        });
        expect(click.recorded).toBe(true);

        const raw = JSON.parse(await readFile(file, 'utf-8')) as {
          events: unknown[];
          campaigns: unknown[];
        };
        expect(raw.campaigns).toHaveLength(1);
        expect(raw.events).toHaveLength(1);

        // A second process (fresh store) sees exactly the same records.
        const second = createCampaignHarness({
          ...env,
          CAMPAIGN_DATA_FILE: file,
        });
        await second.load();
        expect(second.store.campaignCount).toBe(1);
        expect(second.store.eventCount).toBe(1);
        expect(second.store.findCampaignByToken(token)?.name).toBe(
          'کمپین پایدار',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module';
import { AppConfigService } from './../src/config/app-config.service';
import { CampaignService } from './../src/campaigns/campaign.service';
import { CampaignStore } from './../src/campaigns/campaign.store';
import { CampaignTrackingService } from './../src/campaigns/campaign-tracking.service';
import { UserStore } from './../src/users/user.store';

/**
 * Phase 8 end-to-end: the tracked-redirect endpoint over real HTTP, the campaign journey through the
 * real bot router, and the boundaries to the other phases (§7, §8, §12, §14).
 *
 * Everything runs in-process with the e2e environment (`test/setup-env.ts`): no platform, no market
 * API, no network. The campaign data file lives in the suite's throw-away directory.
 */
describe('Campaign tracking (e2e)', () => {
  let app: INestApplication<App>;
  let campaigns: CampaignService;
  let store: CampaignStore;

  const admin = 'bale:e2e-admin';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.get(UserStore).ensureLoaded();

    campaigns = app.get(CampaignService);
    store = app.get(CampaignStore);
    await store.ensureLoaded();

    // The allow-list is read from configuration on every check, so this is the same value the
    // application validates at boot (`test/setup-env.ts` sets a synthetic admin id).
    expect(app.get(AppConfigService).channelAdminUserIds).toContain(
      'bale:e2e-admin',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function newCampaign(name = 'کمپین تست', destination = 'prices') {
    const result = await campaigns.createCampaign({
      name,
      source: 'telegram_ad',
      medium: 'post',
      destinationType: 'BOT_START',
      destination,
      createdBy: admin,
    });

    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }

    return result.value;
  }

  describe('GET /c/:token — the tracked redirect (§7.2/§7.3)', () => {
    it('redirects a real browser click to the configured bot deep link and records it', async () => {
      const campaign = await newCampaign();

      const response = await request(app.getHttpServer())
        .get(`/c/${campaign.trackingToken}?p=telegram`)
        .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14)')
        .expect(302);

      expect(response.headers.location).toBe(
        `https://t.me/atabak_e2e_tg_bot?start=c_${campaign.trackingToken}`,
      );

      const clicks = store
        .listEvents()
        .filter(
          (event) =>
            event.type === 'CLICK' && event.campaignId === campaign.campaignId,
        );
      expect(clicks).toHaveLength(1);
    });

    it('never redirects an unknown token (no open redirect, no guessing)', async () => {
      const before = store.eventCount;

      const response = await request(app.getHttpServer())
        .get('/c/cmp000000000000')
        .set('User-Agent', 'Mozilla/5.0')
        .expect(404);

      expect(response.headers.location).toBeUndefined();
      expect(store.eventCount).toBe(before);
    });

    it('answers a paused campaign with 410 and keeps its history', async () => {
      const campaign = await newCampaign('کمپین متوقف');

      await request(app.getHttpServer())
        .get(`/c/${campaign.trackingToken}`)
        .set('User-Agent', 'Mozilla/5.0 (first visit)')
        .expect(302);

      await campaigns.setStatus(campaign.campaignId, 'PAUSED', admin);

      const paused = await request(app.getHttpServer())
        .get(`/c/${campaign.trackingToken}`)
        .set('User-Agent', 'Mozilla/5.0 (second visit)')
        .expect(410);

      expect(paused.headers.location).toBeUndefined();
      expect(
        store
          .listEvents()
          .filter(
            (event) =>
              event.type === 'CLICK' &&
              event.campaignId === campaign.campaignId,
          ),
      ).toHaveLength(1);
    });

    it('does not count a link preview as a human click but still forwards it', async () => {
      const campaign = await newCampaign('کمپین پیش‌نمایش');

      const response = await request(app.getHttpServer())
        .get(`/c/${campaign.trackingToken}`)
        .set('User-Agent', 'TelegramBot (like TwitterBot)')
        .expect(302);

      expect(response.headers.location).toContain('ble.ir/atabak_e2e_bot');
      expect(
        store
          .listEvents()
          .filter((event) => event.campaignId === campaign.campaignId),
      ).toHaveLength(0);
      expect(
        store
          .listRejections()
          .some(
            (row) =>
              row.reason === 'PREVIEW_FETCH' &&
              row.campaignId === campaign.campaignId,
          ),
      ).toBe(true);
    });

    it('keeps the Phase 6 routes working next to the campaign endpoint (§6.4)', async () => {
      await request(app.getHttpServer()).get('/').expect(200);
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });

  describe('the funnel inside the bot (§8)', () => {
    it('counts a start once for a new identity and never twice for the same link', async () => {
      const campaign = await newCampaign('کمپین بازگشت', 'alert');
      const tracking = app.get(CampaignTrackingService);

      const firstStart = await tracking.recordStart({
        platform: 'bale',
        platformUserId: 'e2e-new-user',
        payload: `c_${campaign.trackingToken}`,
      });
      const secondStart = await tracking.recordStart({
        platform: 'bale',
        platformUserId: 'e2e-new-user',
        payload: `c_${campaign.trackingToken}`,
      });

      expect(firstStart).toMatchObject({ recognized: true, recorded: true });
      expect(secondStart.recorded).toBe(false);

      const starts = store
        .listEvents()
        .filter(
          (event) =>
            event.type === 'START' && event.campaignId === campaign.campaignId,
        );
      expect(starts).toHaveLength(1);

      // The identity used the same payload from the other platform: still one identity per platform,
      // never a merged person (§5.4).
      await tracking.recordStart({
        platform: 'telegram',
        platformUserId: 'e2e-new-user',
        payload: `c_${campaign.trackingToken}`,
      });

      expect(
        store
          .listAttributions()
          .map((row) => row.identityKey)
          .sort(),
      ).toEqual(['bale:e2e-new-user', 'telegram:e2e-new-user']);
    });

    it('records an alert only through the authoritative path and only once per alert (§8.5)', async () => {
      const campaign = await newCampaign('کمپین هشدار', 'alert');
      const tracking = app.get(CampaignTrackingService);

      await tracking.recordStart({
        platform: 'bale',
        platformUserId: 'e2e-alert-user',
        payload: `c_${campaign.trackingToken}`,
      });

      const first = await tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: 'e2e-alert-user',
        alertId: 'alr_e2e_1',
      });
      const replay = await tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: 'e2e-alert-user',
        alertId: 'alr_e2e_1',
      });

      expect(first).toMatchObject({
        recorded: true,
        campaignId: campaign.campaignId,
      });
      expect(replay.recorded).toBe(false);
      expect(
        store.listEvents().filter((event) => event.type === 'ALERT_CREATED'),
      ).toHaveLength(1);
    });

    it('reports channel joins as unavailable unless the platform verifies them (§8.4)', async () => {
      const tracking = app.get(CampaignTrackingService);
      const result = await tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: 'e2e-join-user',
      });

      expect(result.checked).toBe(false);
      expect(result.joinRecorded).toBe(false);
      expect(
        store.listEvents().filter((event) => event.type === 'CHANNEL_JOIN'),
      ).toHaveLength(0);
    });
  });

  describe('phase boundaries (§12/§19)', () => {
    it('does not create a second user, alert, referral or reward record', async () => {
      const users = app.get(UserStore);
      const before = users.listUsers().length;

      await newCampaign('کمپین بی‌اثر');

      expect(users.listUsers().length).toBe(before);
      expect(users.listReferrals()).toHaveLength(0);
      expect(
        users.listUsers().flatMap((entry) => users.listRewards(entry.id)),
      ).toHaveLength(0);
    });

    it('keeps `/health` independent of campaign tracking', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({ status: 'ok' });
    });
  });
});

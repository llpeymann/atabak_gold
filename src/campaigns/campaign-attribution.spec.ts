import {
  createCampaignHarness,
  createUxHarness,
  CampaignHarness,
} from '../testing/test-doubles';
import { CampaignTouch } from './campaign.types';
import {
  creditedCampaign,
  decideAttribution,
  decideBothModels,
  evidenceOf,
} from './attribution';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 30 * DAY;

/**
 * Phase 8 §8/§10/§11 — funnel ingestion, attribution models and idempotency.
 */
describe('Campaign attribution & funnel (Phase 8 §8/§10/§11)', () => {
  let harness: CampaignHarness;

  beforeEach(async () => {
    harness = createCampaignHarness({
      BALE_BOT_USERNAME: 'atabak_bot',
      TELEGRAM_BOT_USERNAME: 'atabak_tg_bot',
      CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
    });
    await harness.load();
  });

  async function createCampaign(source = 'telegram_ad') {
    const result = await harness.service.createCampaign({
      name: `کمپین ${source}`,
      source,
      destinationType: 'BOT_START',
      destination: 'alert',
      createdBy: 'bale:admin',
    });

    if (!result.ok) {
      throw new Error(result.code);
    }

    return result.value;
  }

  function touch(
    campaignId: string,
    occurredAt: string,
    eventId: string,
    recordedAt = occurredAt,
  ): CampaignTouch {
    return {
      campaignId,
      occurredAt: new Date(occurredAt),
      recordedAt: new Date(recordedAt),
      eventId,
      type: 'START',
    };
  }

  describe('pure rules (§10.1/§10.2/§10.4)', () => {
    it('credits the earliest touch for first-touch and the most recent for last-touch', () => {
      const touches = [
        touch('cmp_1', '2026-10-01T10:00:00.000Z', 'evt_1'),
        touch('cmp_2', '2026-10-10T10:00:00.000Z', 'evt_2'),
      ];
      const query = {
        at: new Date('2026-10-15T10:00:00.000Z'),
        windowMs: WINDOW,
      };

      expect(decideAttribution('FIRST_TOUCH', touches, query).campaignId).toBe(
        'cmp_1',
      );
      expect(decideAttribution('LAST_TOUCH', touches, query).campaignId).toBe(
        'cmp_2',
      );
    });

    it('treats the window boundary as inclusive and the next millisecond as expired', () => {
      const first = touch('cmp_1', '2026-09-16T10:00:00.000Z', 'evt_1');
      const exactly = new Date(new Date(first.occurredAt).getTime() + WINDOW);
      const later = new Date(exactly.getTime() + 1);

      expect(
        decideAttribution('LAST_TOUCH', [first], {
          at: exactly,
          windowMs: WINDOW,
        }).campaignId,
      ).toBe('cmp_1');
      expect(
        decideAttribution('LAST_TOUCH', [first], {
          at: later,
          windowMs: WINDOW,
        }),
      ).toMatchObject({ campaignId: null, bucket: 'EXPIRED_WINDOW' });
    });

    it('breaks ties deterministically by ingestion time and then event id', () => {
      const touches = [
        touch(
          'cmp_1',
          '2026-10-10T10:00:00.000Z',
          'evt_9',
          '2026-10-10T10:05:00.000Z',
        ),
        touch(
          'cmp_2',
          '2026-10-10T10:00:00.000Z',
          'evt_2',
          '2026-10-10T10:05:00.000Z',
        ),
      ];
      const query = {
        at: new Date('2026-10-11T10:00:00.000Z'),
        windowMs: WINDOW,
      };

      // Same occurredAt and same recordedAt → the higher event id wins, in both array orders, so the
      // outcome never depends on the order the touches happen to be stored in.
      expect(decideAttribution('LAST_TOUCH', touches, query).campaignId).toBe(
        'cmp_1',
      );
      expect(
        decideAttribution('LAST_TOUCH', [...touches].reverse(), query)
          .campaignId,
      ).toBe('cmp_1');
    });

    it('never credits a touch that happened after the conversion', () => {
      const decision = decideAttribution(
        'LAST_TOUCH',
        [touch('cmp_1', '2026-10-20T10:00:00.000Z', 'evt_1')],
        { at: new Date('2026-10-16T10:00:00.000Z'), windowMs: WINDOW },
      );

      expect(decision.campaignId).toBeNull();
      expect(decision.bucket).toBe('TOUCH_AFTER_CONVERSION');
    });

    it('reports “no touch at all” as its own bucket (organic/direct)', () => {
      const decision = decideAttribution('FIRST_TOUCH', [], {
        at: new Date('2026-10-16T10:00:00.000Z'),
        windowMs: WINDOW,
      });

      expect(decision).toMatchObject({ campaignId: null, bucket: 'NO_TOUCH' });
    });
  });

  describe('campaign starts (§8.3)', () => {
    it('records a start for a new identity and updates both attribution models', async () => {
      const campaign = await createCampaign();
      const result = await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '111',
        payload: `c_${campaign.trackingToken}`,
        occurredAt: new Date('2026-10-16T09:00:00.000Z'),
      });

      expect(result).toMatchObject({ recognized: true, recorded: true });
      expect(result.campaignId).toBe(campaign.campaignId);

      const attribution = harness.store.findAttribution('bale:111');
      expect(attribution?.firstTouchCampaignId).toBe(campaign.campaignId);
      expect(attribution?.lastTouchCampaignId).toBe(campaign.campaignId);
      expect(attribution?.models).toEqual(['FIRST_TOUCH', 'LAST_TOUCH']);
      expect(attribution?.firstTouchEvidence).toMatch(/^start:evt_/);
    });

    it('does not count a second start of the same identity through the same link', async () => {
      const campaign = await createCampaign();
      const payload = `c_${campaign.trackingToken}`;

      const first = await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '111',
        payload,
      });
      const second = await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '111',
        payload,
      });

      expect(first.recorded).toBe(true);
      expect(second.recorded).toBe(false);
      expect(harness.store.listEvents()).toHaveLength(1);
      expect(harness.store.listAttributions()).toHaveLength(1);
    });

    it('keeps identities of one platform apart from the other (§5.4 — no merging)', async () => {
      const campaign = await createCampaign();
      const payload = `c_${campaign.trackingToken}`;

      await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '77',
        payload,
      });
      await harness.tracking.recordStart({
        platform: 'telegram',
        platformUserId: '77',
        payload,
      });

      expect(
        harness.store
          .listAttributions()
          .map((row) => row.identityKey)
          .sort(),
      ).toEqual(['bale:77', 'telegram:77']);
      expect(harness.store.listEvents()).toHaveLength(2);
    });

    it('ignores payloads that are not campaign references', async () => {
      const result = await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '111',
        payload: 'prices',
      });

      expect(result).toMatchObject({ recognized: false, recorded: false });
      expect(harness.store.eventCount).toBe(0);
    });

    it('refuses a start on a campaign that is not accepting traffic', async () => {
      const campaign = await createCampaign();
      await harness.service.setStatus(campaign.campaignId, 'PAUSED', 'op');

      const result = await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '111',
        payload: `c_${campaign.trackingToken}`,
      });

      expect(result).toMatchObject({ recognized: true, recorded: false });
      expect(harness.store.eventCount).toBe(0);
      expect(harness.store.listRejections().map((row) => row.reason)).toContain(
        'START_ON_INACTIVE_CAMPAIGN',
      );
    });

    it('advances last-touch but never rewrites first-touch when a newer touch arrives', async () => {
      const first = await createCampaign('telegram_ad');
      const second = await createCampaign('instagram');

      await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '222',
        payload: `c_${first.trackingToken}`,
        occurredAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '222',
        payload: `c_${second.trackingToken}`,
        occurredAt: new Date('2026-10-05T10:00:00.000Z'),
      });

      const attribution = harness.store.findAttribution('bale:222');
      expect(attribution?.firstTouchCampaignId).toBe(first.campaignId);
      expect(attribution?.lastTouchCampaignId).toBe(second.campaignId);
      expect(
        attribution === null ||
          attribution.updatedAt >= attribution.establishedAt,
      ).toBe(true);
    });
  });

  describe('alert funnel (§8.5)', () => {
    it('records one alert event per alert and never counts a replay twice', async () => {
      const campaign = await createCampaign();
      await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '333',
        payload: `c_${campaign.trackingToken}`,
        occurredAt: new Date('2026-10-16T08:00:00.000Z'),
      });

      const first = await harness.tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: '333',
        alertId: 'alr_1',
      });
      const replay = await harness.tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: '333',
        alertId: 'alr_1',
      });

      expect(first.recorded).toBe(true);
      expect(first.campaignId).toBe(campaign.campaignId);
      expect(replay.recorded).toBe(false);

      const alerts = harness.store
        .listEvents()
        .filter((event) => event.type === 'ALERT_CREATED');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.externalRef).toBe('alr_1');
      expect(alerts[0]?.meta.attributionModel).toBe('LAST_TOUCH');
    });

    it('stores nothing for an identity without any campaign touch', async () => {
      const result = await harness.tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: 'nobody',
        alertId: 'alr_2',
      });

      expect(result.recorded).toBe(false);
      expect(harness.store.eventCount).toBe(0);
    });

    it('does not attribute an alert that arrives after the window expired', async () => {
      const campaign = await createCampaign();
      await harness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '444',
        payload: `c_${campaign.trackingToken}`,
        occurredAt: new Date('2026-01-01T08:00:00.000Z'),
      });

      const result = await harness.tracking.recordAlertCreated({
        platform: 'bale',
        platformUserId: '444',
        alertId: 'alr_3',
        occurredAt: new Date('2026-03-01T08:00:00.000Z'),
      });

      expect(result.recorded).toBe(false);
      expect(result.campaignId).toBeNull();
    });
  });

  describe('channel joins (§8.4)', () => {
    it('reports joins as unavailable when verification is switched off', async () => {
      const result = await harness.tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: '555',
      });

      expect(result.checked).toBe(false);
      expect(result.state).toBe('UNKNOWN');
      expect(harness.store.listEvents()).toHaveLength(0);
    });

    it('never claims a verified join on a platform without a verified capability', async () => {
      const withVerification = createCampaignHarness({
        CAMPAIGN_CHANNEL_JOIN_VERIFICATION: 'getChatMember',
      });
      await withVerification.load();

      const result = await withVerification.tracking.verifyMembershipTransition(
        {
          platform: 'bale',
          platformUserId: '555',
        },
      );

      expect(result.checked).toBe(false);
      expect(result.joinRecorded).toBe(false);
      expect(result.reason).toContain('تأیید');
    });

    it('records a join only on a verified transition from not-a-member to member', async () => {
      const verified = createCampaignHarness({
        CAMPAIGN_CHANNEL_JOIN_VERIFICATION: 'getChatMember',
        TELEGRAM_BOT_TOKEN: 'tg-token',
        TELEGRAM_CHANNEL_ID: '-100123',
      });
      await verified.load();

      const campaign = await verified.service.createCampaign({
        name: 'کمپین کانال',
        source: 'channel_post',
        destinationType: 'CHANNEL_INVITE',
        destination: 'telegram',
      });

      if (!campaign.ok) {
        throw new Error(campaign.code);
      }

      await verified.tracking.recordStart({
        platform: 'telegram',
        platformUserId: '666',
        payload: `c_${campaign.value.trackingToken}`,
        occurredAt: new Date('2026-10-16T08:00:00.000Z'),
      });

      const spy = verified.platform.client.getChatMember;

      // First observation: the platform answers “left” → no join, and the state is remembered.
      spy.mockResolvedValueOnce({
        platform: 'telegram',
        supported: true,
        answered: true,
        status: 'left',
        error: null,
      });
      const before = await verified.tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: '666',
        at: new Date('2026-10-16T09:00:00.000Z'),
      });
      expect(before).toMatchObject({
        checked: true,
        state: 'NOT_MEMBER',
        joinRecorded: false,
      });

      // Second observation: “member” → this is the transition that may be credited.
      spy.mockResolvedValueOnce({
        platform: 'telegram',
        supported: true,
        answered: true,
        status: 'member',
        error: null,
      });
      const after = await verified.tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: '666',
        at: new Date('2026-10-16T10:00:00.000Z'),
      });

      expect(after).toMatchObject({
        checked: true,
        state: 'MEMBER',
        joinRecorded: true,
      });
      expect(after.campaignId).toBe(campaign.value.campaignId);

      const joins = verified.store
        .listEvents()
        .filter((event) => event.type === 'CHANNEL_JOIN');
      expect(joins).toHaveLength(1);
      expect(joins[0]?.meta.verification).toBe('getChatMember');

      // A third observation of the same state is not a new join (§8.4 — no inflated joins).
      spy.mockResolvedValueOnce({
        platform: 'telegram',
        supported: true,
        answered: true,
        status: 'member',
        error: null,
      });
      const repeated = await verified.tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: '666',
        at: new Date('2026-10-16T11:00:00.000Z'),
      });
      expect(repeated.joinRecorded).toBe(false);
      expect(
        verified.store
          .listEvents()
          .filter((event) => event.type === 'CHANNEL_JOIN'),
      ).toHaveLength(1);
    });

    it('does not record a join when the platform cannot answer', async () => {
      const verified = createCampaignHarness({
        CAMPAIGN_CHANNEL_JOIN_VERIFICATION: 'getChatMember',
        TELEGRAM_BOT_TOKEN: 'tg-token',
        TELEGRAM_CHANNEL_ID: '-100123',
      });
      await verified.load();

      verified.platform.client.getChatMember.mockResolvedValueOnce({
        platform: 'telegram',
        supported: true,
        answered: false,
        status: null,
        error: 'timeout',
      });

      const result = await verified.tracking.verifyMembershipTransition({
        platform: 'telegram',
        platformUserId: '777',
      });

      expect(result).toMatchObject({
        checked: false,
        state: 'UNKNOWN',
        joinRecorded: false,
      });
      expect(verified.store.eventCount).toBe(0);
    });
  });

  describe('retention (§5.7/§21)', () => {
    it('prunes only raw click requests and never touches conversions', async () => {
      const retentionHarness = createCampaignHarness({
        CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
        CAMPAIGN_RAW_EVENT_RETENTION_DAYS: '1',
        CAMPAIGN_MAX_RAW_EVENTS: '2',
      });
      await retentionHarness.load();

      const campaign = await retentionHarness.service.createCampaign({
        name: 'کمپین نگهداشت',
        source: 'instagram',
        destinationType: 'BOT_START',
        destination: 'prices',
      });

      if (!campaign.ok) {
        throw new Error(campaign.code);
      }

      for (let index = 0; index < 4; index += 1) {
        await retentionHarness.service.recordClick({
          token: campaign.value.trackingToken,
          platformHint: null,
          userAgent: `Mozilla/5.0 (client ${index})`,
          now: new Date(
            Date.parse('2026-10-16T10:00:00.000Z') + index * 120_000,
          ),
        });
      }

      const clicks = retentionHarness.store
        .listEvents()
        .filter((event) => event.type === 'CLICK');
      expect(clicks.length).toBeLessThanOrEqual(2);

      await retentionHarness.tracking.recordStart({
        platform: 'bale',
        platformUserId: '888',
        payload: `c_${campaign.value.trackingToken}`,
      });

      // The start event is not a raw request: it survives every pruning rule.
      expect(
        retentionHarness.store
          .listEvents()
          .filter((event) => event.type === 'START'),
      ).toHaveLength(1);
    });
  });

  describe('phase separation (§21 of the frozen spec / §12)', () => {
    it('does not touch Phase 7 referral attribution when a campaign start is recorded', async () => {
      const ux = createUxHarness({
        CAMPAIGN_TRACKING_BASE_URL: 'https://track.example.test',
        BALE_BOT_USERNAME: 'atabak_bot',
        REFERRAL_BOT_USERNAME: 'atabak_bot',
      });

      const campaign = await ux.campaigns.service.createCampaign({
        name: 'کمپین + معرف',
        source: 'friend',
        destinationType: 'BOT_START',
        destination: 'prices',
      });

      if (!campaign.ok) {
        throw new Error(campaign.code);
      }

      const inviter = await ux.store.upsertUser('900', 'bale', '900');
      const code = await ux.growth.referralCodeFor(inviter.id);

      await ux.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 1,
        platformUserId: '901',
        chatId: '901',
        text: `/start ref_${code}`,
        messageId: 1,
      });

      const referrals = ux.store.listReferrals();
      expect(referrals).toHaveLength(1);

      // The campaign payload arrives later from the same identity: it must neither create a second
      // referral nor rewrite the referral attribution (§12 — two independent concepts).
      await ux.botUx.handleUpdate({
        kind: 'message',
        platform: 'bale',
        updateId: 2,
        platformUserId: '901',
        chatId: '901',
        text: `/start c_${campaign.value.trackingToken}`,
        messageId: 2,
      });

      expect(ux.store.listReferrals()).toHaveLength(1);
      expect(
        ux.store.listUsers().flatMap((entry) => ux.store.listRewards(entry.id)),
      ).toHaveLength(0);
      // …and the returning user is not counted as a second registration or a campaign start.
      expect(
        ux.campaigns.store
          .listEvents()
          .filter((event) => event.type === 'START'),
      ).toHaveLength(0);
    });
  });
  describe('both-model resolution and evidence (§10.4/§10.6)', () => {
    const at = new Date('2026-10-15T10:00:00.000Z');
    const query = { at, windowMs: WINDOW };

    it('returns the two models in a fixed order, never merged into one number', () => {
      const decisions = decideBothModels([], query);

      expect(decisions.map((decision) => decision.model)).toEqual([
        'FIRST_TOUCH',
        'LAST_TOUCH',
      ]);
      expect(decisions.every((decision) => decision.campaignId === null)).toBe(
        true,
      );
    });

    it('credits the last-touch campaign, and falls back to first-touch when only that model is eligible', () => {
      // The old (expired) touch cannot credit anything; the fresh one can.
      const expiredThenFresh = decideBothModels(
        [
          touch('cmp_old', '2026-07-01T10:00:00.000Z', 'evt_1'),
          touch('cmp_new', '2026-10-14T10:00:00.000Z', 'evt_2'),
        ],
        query,
      );
      const credited = creditedCampaign(expiredThenFresh);

      expect(credited.model).toBe('LAST_TOUCH');
      expect(credited.campaignId).toBe('cmp_new');
      expect(evidenceOf(credited)).toBe(
        'LAST_TOUCH:cmp_new@2026-10-14T10:00:00.000Z',
      );

      // A touch that happened *after* the conversion is not eligible for either model, so the
      // eligible touch of 2026-10-14 is the only candidate — and the decision says so.
      const futureTouchIgnored = decideBothModels(
        [
          touch('cmp_first', '2026-10-14T10:00:00.000Z', 'evt_3'),
          touch('cmp_later', '2026-10-16T10:00:00.000Z', 'evt_4'),
        ],
        query,
      );

      expect(
        futureTouchIgnored.find((decision) => decision.model === 'LAST_TOUCH')
          ?.campaignId,
      ).toBe('cmp_first');
      expect(
        futureTouchIgnored.find((decision) => decision.model === 'FIRST_TOUCH')
          ?.campaignId,
      ).toBe('cmp_first');

      // The fallback branch is defensive (the models share one eligibility rule, so both are null
      // together): it is exercised with a hand-built list and still never invents a campaign.
      const fallback = creditedCampaign([
        {
          model: 'FIRST_TOUCH',
          campaignId: 'cmp_first',
          bucket: 'CAMPAIGN',
          touch: touch('cmp_first', '2026-10-14T10:00:00.000Z', 'evt_5'),
          reason: 'اولین تماس مشاهده‌شده در پنجره انتساب.',
        },
        {
          model: 'LAST_TOUCH',
          campaignId: null,
          bucket: 'TOUCH_AFTER_CONVERSION',
          touch: null,
          reason: 'تماس بعد از تبدیل.',
        },
      ]);

      expect(fallback.model).toBe('FIRST_TOUCH');
      expect(fallback.campaignId).toBe('cmp_first');
      expect(fallback.reason).toContain('اولین تماس');
    });

    it('never invents evidence: an uncredited conversion keeps its bucket and no evidence string', () => {
      const nothing = decideBothModels([], query);
      const credited = creditedCampaign(nothing);

      expect(credited.campaignId).toBeNull();
      expect(credited.bucket).toBe('NO_TOUCH');
      expect(evidenceOf(credited)).toBeNull();

      // Total function: an empty decision list is answered, not crashed on.
      const empty = creditedCampaign([]);
      expect(empty.campaignId).toBeNull();
      expect(empty.bucket).toBe('NO_TOUCH');
      expect(evidenceOf(empty)).toBeNull();
    });
  });
});

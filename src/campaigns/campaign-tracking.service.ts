import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { BotApiClient } from '../platform/bot-api.client';
import { Platform } from '../platform/platform.types';
import {
  creditedCampaign,
  decideAttribution,
  decideBothModels,
} from './attribution';
import { CampaignService } from './campaign.service';
import {
  CampaignStore,
  CampaignTransaction,
  identityKeyOf,
} from './campaign.store';
import {
  AttributionDecision,
  CampaignAttributionRecord,
  CampaignEventRecord,
  CampaignTouch,
  TrackingResolution,
} from './campaign.types';

/**
 * Phase 8 — funnel ingestion (§8, §11).
 *
 * This service is the only writer of `START`, `CHANNEL_JOIN` and `ALERT_CREATED` events, and it keeps
 * the per-identity attribution record up to date. The rules it implements deliberately *depend on*
 * the other phases instead of duplicating them:
 *
 *  * `START` is recorded **after** the caller has durably registered the new identity (§8.3).
 *  * `ALERT_CREATED` is recorded **after** Phase 3 persisted the alert, and only for identities that
 *    already carry a campaign touch — the alert engine itself is never touched (§8.5).
 *  * `CHANNEL_JOIN` is recorded only on a *verified membership transition*, and never on Bale, whose
 *    `getChatMember` support this project does not claim (§8.4).
 */

export interface StartIngestionInput {
  platform: Platform;
  platformUserId: string;
  /** Raw `/start <payload>` text. Any non-campaign payload is recognized as “not ours”. */
  payload: string;
  /** When the registration happened (defaults to now). */
  occurredAt?: Date;
}

export interface StartIngestionResult {
  /** `true` when the payload carried a campaign token (whether or not it was accepted). */
  recognized: boolean;
  campaignId: string | null;
  /** `true` only when a START event was durably stored. */
  recorded: boolean;
  reason: string;
}

export interface AlertIngestionInput {
  platform: Platform;
  platformUserId: string;
  /** Id of the alert Phase 3 actually persisted. */
  alertId: string;
  occurredAt?: Date;
}

export interface AlertIngestionResult {
  recorded: boolean;
  campaignId: string | null;
  reason: string;
}

export interface MembershipCheckResult {
  checked: boolean;
  state: 'MEMBER' | 'NOT_MEMBER' | 'UNKNOWN';
  joinRecorded: boolean;
  campaignId: string | null;
  reason: string;
}

@Injectable()
export class CampaignTrackingService {
  private readonly logger = new Logger(CampaignTrackingService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: CampaignStore,
    private readonly campaigns: CampaignService,
    private readonly client: BotApiClient,
  ) {}

  get enabled(): boolean {
    return this.campaigns.enabled;
  }

  /** Resolve a tracking token to a campaign and its current accept/refuse state (§7.4). */
  resolve(token: string, at: Date = new Date()): TrackingResolution | null {
    return this.campaigns.resolveToken(token, at);
  }

  /**
   * Record a campaign start (§8.3).
   *
   * The caller must only invoke this for a *newly created* identity: a returning user pressing the
   * same link again is not a new start, and the campaign-agnostic UX is untouched — this method never
   * sends, edits or blocks anything.
   */
  async recordStart(input: StartIngestionInput): Promise<StartIngestionResult> {
    if (!this.enabled) {
      return {
        recognized: false,
        campaignId: null,
        recorded: false,
        reason: this.campaigns.trackingDisabledReason ?? 'ردیابی غیرفعال است.',
      };
    }

    const now = new Date();
    const occurredAt = input.occurredAt ?? now;
    const resolution = this.campaigns.resolvePayload(input.payload, now);

    if (!resolution) {
      return {
        recognized: false,
        campaignId: null,
        recorded: false,
        reason: 'payload کمپین نیست.',
      };
    }

    const campaign = resolution.campaign;
    const identityKey = identityKeyOf(input.platform, input.platformUserId);

    if (!resolution.accepting) {
      await this.campaigns.countRejectionPublic(
        campaign.campaignId,
        'START_ON_INACTIVE_CAMPAIGN',
      );

      return {
        recognized: true,
        campaignId: campaign.campaignId,
        recorded: false,
        reason: resolution.blockedReason ?? 'کمپین فعال نیست.',
      };
    }

    const idempotencyKey = `start:${campaign.campaignId}:${identityKey}`;

    try {
      const outcome = await this.store.transact((tx) => {
        if (tx.hasEventKey(idempotencyKey)) {
          return { recorded: false, reason: 'این شروع قبلاً ثبت شده است.' };
        }

        const eventId = tx.nextId('evt');
        const event: CampaignEventRecord = {
          eventId,
          type: 'START',
          campaignId: campaign.campaignId,
          platform: input.platform,
          platformUserId: input.platformUserId,
          identityKey,
          occurredAt: occurredAt.toISOString(),
          recordedAt: now.toISOString(),
          provenance: 'NATIVE',
          idempotencyKey,
          meta: {
            source: campaign.source,
            destination: `${campaign.destinationType}:${campaign.destination}`,
          },
          externalRef: null,
        };

        tx.saveEvent(event);
        this.applyTouch(tx, identityKey, input.platform, input.platformUserId, {
          campaignId: campaign.campaignId,
          occurredAt,
          recordedAt: now,
          eventId,
          type: 'START',
        });

        return { recorded: true, reason: 'شروع کمپینی ثبت شد.' };
      });

      if (outcome.recorded) {
        this.logger.log(
          `Campaign start recorded for ${campaign.campaignId} (${input.platform}); no message was altered.`,
        );
      }

      return {
        recognized: true,
        campaignId: campaign.campaignId,
        recorded: outcome.recorded,
        reason: outcome.reason,
      };
    } catch (error) {
      this.logger.error(
        `Could not persist campaign start for ${campaign.campaignId}: ${describeError(error)}`,
      );

      return {
        recognized: true,
        campaignId: campaign.campaignId,
        recorded: false,
        reason: 'ثبت شروع ناموفق بود (خطای ذخیره‌سازی).',
      };
    }
  }

  /**
   * Record an alert created through the authoritative Phase 3 path (§8.5).
   *
   * Only identities that already carry a credited campaign produce an event: an alert that cannot be
   * attributed to any campaign has nothing to report against, and storing it would grow the document
   * for every user of the bot. Duplicate prevention is trivial and absolute — the Phase 3 alert id is
   * unique, and it is the idempotency key.
   */
  async recordAlertCreated(
    input: AlertIngestionInput,
  ): Promise<AlertIngestionResult> {
    if (!this.enabled) {
      return {
        recorded: false,
        campaignId: null,
        reason: this.campaigns.trackingDisabledReason ?? 'ردیابی غیرفعال است.',
      };
    }

    const now = new Date();
    const occurredAt = input.occurredAt ?? now;
    const identityKey = identityKeyOf(input.platform, input.platformUserId);
    const decision = this.attributedCampaignFor(identityKey, occurredAt);

    if (!decision.campaignId) {
      return {
        recorded: false,
        campaignId: null,
        reason: 'این کاربر به هیچ کمپینی منتسب نیست؛ رویداد هشدار ذخیره نشد.',
      };
    }

    const idempotencyKey = `alert:${input.alertId}`;

    try {
      const recorded = await this.store.transact((tx) => {
        if (tx.hasEventKey(idempotencyKey)) {
          return false;
        }

        tx.saveEvent({
          eventId: tx.nextId('evt'),
          type: 'ALERT_CREATED',
          campaignId: decision.campaignId,
          platform: input.platform,
          platformUserId: input.platformUserId,
          identityKey,
          occurredAt: occurredAt.toISOString(),
          recordedAt: now.toISOString(),
          provenance: 'NATIVE',
          idempotencyKey,
          meta: { attributionModel: decision.model },
          externalRef: input.alertId,
        });

        return true;
      });

      if (recorded) {
        this.logger.log(
          `Alert ${input.alertId} attributed to campaign ${decision.campaignId} (${decision.model}).`,
        );
      }

      return {
        recorded,
        campaignId: decision.campaignId,
        reason: recorded
          ? 'هشدار منتسب ثبت شد.'
          : 'این هشدار قبلاً ثبت شده بود.',
      };
    } catch (error) {
      this.logger.error(
        `Could not persist alert attribution for ${input.alertId}: ${describeError(error)}`,
      );

      return {
        recorded: false,
        campaignId: decision.campaignId,
        reason: 'ثبت رویداد هشدار ناموفق بود (خطای ذخیره‌سازی).',
      };
    }
  }

  /**
   * Verify channel membership and record a *verified join* only on a real transition (§8.4).
   *
   * The check is a capability, not an assumption:
   *  * verification switched off → `checked: false`;
   *  * platform without a verified `getChatMember` (Bale) → `checked: false` (joins stay unavailable);
   *  * no configured channel on that platform → `checked: false`;
   *  * query failed → `checked: false` (never a “probably joined”).
   */
  async verifyMembershipTransition(input: {
    platform: Platform;
    platformUserId: string;
    at?: Date;
  }): Promise<MembershipCheckResult> {
    const unavailable = (reason: string): MembershipCheckResult => ({
      checked: false,
      state: 'UNKNOWN',
      joinRecorded: false,
      campaignId: null,
      reason,
    });

    if (!this.enabled) {
      return unavailable(
        this.campaigns.trackingDisabledReason ?? 'ردیابی غیرفعال است.',
      );
    }

    if (this.config.campaignChannelJoinVerification !== 'getChatMember') {
      return unavailable(
        'بررسی عضویت کانال تنظیم نشده است (CAMPAIGN_CHANNEL_JOIN_VERIFICATION).',
      );
    }

    const chatId =
      input.platform === 'telegram'
        ? (this.config.telegram?.channelId ?? null)
        : (this.config.bale?.channelId ?? null);

    if (!chatId) {
      return unavailable('کانال این پلتفرم در تنظیمات موجود نیست.');
    }

    if (input.platform !== 'telegram') {
      return unavailable(
        'پلتفرم این کاربر برای بررسی عضویت پشتیبانی تأییدشده ندارد؛ عضویت «در دسترس نیست».',
      );
    }

    const result = await this.client.getChatMember(
      input.platform,
      chatId,
      input.platformUserId,
    );

    if (!result.supported || !result.answered || !result.status) {
      return unavailable(
        result.error ?? 'پلتفرم به پرسش عضویت پاسخ نداد؛ عضویت تأیید نشد.',
      );
    }

    const isMember = isMemberStatus(result.status);
    const identityKey = identityKeyOf(input.platform, input.platformUserId);
    const now = input.at ?? new Date();
    const decision = this.attributedCampaignFor(identityKey, now);
    const previous = this.store.findMembership(identityKey);
    const state: 'MEMBER' | 'NOT_MEMBER' = isMember ? 'MEMBER' : 'NOT_MEMBER';
    const transition = previous?.state === 'NOT_MEMBER' && isMember;

    try {
      const joinRecorded = await this.store.transact((tx) => {
        tx.saveMembership({
          identityKey,
          platform: input.platform,
          platformUserId: input.platformUserId,
          state,
          observedAt: now.toISOString(),
          campaignId: decision.campaignId,
        });

        if (!transition) {
          return false;
        }

        const idempotencyKey = `join:${identityKey}:${decision.campaignId ?? 'none'}:${now.toISOString()}`;

        if (tx.hasEventKey(idempotencyKey)) {
          return false;
        }

        const eventId = tx.nextId('evt');

        tx.saveEvent({
          eventId,
          type: 'CHANNEL_JOIN',
          campaignId: decision.campaignId,
          platform: input.platform,
          platformUserId: input.platformUserId,
          identityKey,
          occurredAt: now.toISOString(),
          recordedAt: now.toISOString(),
          provenance: 'NATIVE',
          idempotencyKey,
          meta: { verification: 'getChatMember' },
          externalRef: null,
        });

        if (decision.campaignId) {
          this.applyTouch(
            tx,
            identityKey,
            input.platform,
            input.platformUserId,
            {
              campaignId: decision.campaignId,
              occurredAt: now,
              recordedAt: now,
              eventId,
              type: 'CHANNEL_JOIN',
            },
          );
        }

        return true;
      });

      if (joinRecorded) {
        this.logger.log(
          `Verified channel join recorded (campaign ${decision.campaignId ?? 'unattributed'}).`,
        );
      }

      return {
        checked: true,
        state,
        joinRecorded,
        campaignId: decision.campaignId,
        reason: joinRecorded
          ? 'عضویت تأییدشده ثبت شد.'
          : 'عضویت تأیید شد اما گذار جدیدی مشاهده نشد.',
      };
    } catch (error) {
      this.logger.error(
        `Could not persist membership observation: ${describeError(error)}`,
      );

      return unavailable('ثبت مشاهده عضویت ناموفق بود (خطای ذخیره‌سازی).');
    }
  }

  /**
   * The campaign an identity is currently attributed to (`null` campaign = unattributed).
   *
   * Used by conversions and by alert/join ingestion; it always evaluates the *last-touch* model with
   * the configured window, and returns the bucket/reason when nothing could be credited.
   */
  attributedCampaignFor(
    identityKey: string,
    at: Date,
    model: 'FIRST_TOUCH' | 'LAST_TOUCH' = 'LAST_TOUCH',
  ): AttributionDecision {
    const touches = this.store.listTouches(identityKey);

    return decideAttribution(model, touches, {
      at,
      windowMs: this.config.campaignAttributionWindowMs,
    });
  }

  /** Both models for one identity, used when a conversion freezes its attribution (§10.6). */
  attributionDecisionsFor(
    identityKey: string,
    at: Date,
  ): { firstTouch: AttributionDecision; lastTouch: AttributionDecision } {
    const touches = this.store.listTouches(identityKey);
    const query = { at, windowMs: this.config.campaignAttributionWindowMs };
    const [firstTouch, lastTouch] = decideBothModels(touches, query);

    return { firstTouch, lastTouch };
  }

  /** The credited campaign of a conversion (last-touch first, §10.4) — used by the reporting layer. */
  creditedFor(identityKey: string, at: Date): AttributionDecision {
    const { firstTouch, lastTouch } = this.attributionDecisionsFor(
      identityKey,
      at,
    );

    return creditedCampaign([firstTouch, lastTouch]);
  }

  // --- internals --------------------------------------------------------------

  /**
   * Update the attribution record of one identity with a new touch (§10.2/§10.4).
   *
   * First touch is written once and then left alone: it is the earliest *observed* touch, and a
   * delayed ingestion is not allowed to rewrite an attribution that has already been reported.
   * Last touch always advances to the most recent touch (ties broken by ingestion time and id).
   */
  private applyTouch(
    tx: CampaignTransaction,
    identityKey: string,
    platform: Platform,
    platformUserId: string,
    touch: CampaignTouch,
  ): void {
    const existing = tx.findAttribution(identityKey);
    const now = new Date().toISOString();
    const evidence = `${touch.type.toLowerCase()}:${touch.eventId}`;

    if (!existing) {
      tx.saveAttribution({
        identityKey,
        platform,
        platformUserId,
        firstTouchCampaignId: touch.campaignId,
        firstTouchAt: touch.occurredAt.toISOString(),
        firstTouchEvidence: evidence,
        lastTouchCampaignId: touch.campaignId,
        lastTouchAt: touch.occurredAt.toISOString(),
        lastTouchEvidence: evidence,
        models: ['FIRST_TOUCH', 'LAST_TOUCH'],
        establishedAt: now,
        updatedAt: now,
      });

      return;
    }

    const advancesLast = isMoreRecent(touch, existing);

    tx.saveAttribution({
      ...existing,
      lastTouchCampaignId: advancesLast
        ? touch.campaignId
        : existing.lastTouchCampaignId,
      lastTouchAt: advancesLast
        ? touch.occurredAt.toISOString()
        : existing.lastTouchAt,
      lastTouchEvidence: advancesLast ? evidence : existing.lastTouchEvidence,
      models: ['FIRST_TOUCH', 'LAST_TOUCH'],
      updatedAt: now,
    });
  }
}

/** `member`-family statuses count as membership; everything else (left/kicked/…) does not. */
function isMemberStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();

  return (
    normalized === 'member' ||
    normalized === 'administrator' ||
    normalized === 'creator' ||
    normalized === 'restricted'
  );
}

/** Deterministic “is this touch newer than the stored last touch?” test (§10.4 tie-breaking). */
function isMoreRecent(
  touch: CampaignTouch,
  existing: CampaignAttributionRecord,
): boolean {
  if (!existing.lastTouchAt) {
    return true;
  }

  const stored = Date.parse(existing.lastTouchAt);

  if (touch.occurredAt.getTime() > stored) {
    return true;
  }

  if (touch.occurredAt.getTime() < stored) {
    return false;
  }

  return existing.lastTouchEvidence === null;
}

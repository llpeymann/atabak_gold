import { Injectable, Logger } from '@nestjs/common';

import { BotDestinationService } from '../bot/destination.service';
import { isBotRoute } from '../bot/deep-link';
import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import { CampaignStore, CampaignTransaction } from './campaign.store';
import {
  CampaignCreationInput,
  CampaignRecord,
  CampaignResult,
  CampaignStatus,
  ClickClassification,
  ClickDecision,
  campaignFail,
  campaignOk,
  TrackingResolution,
} from './campaign.types';
import {
  generateTrackingToken,
  isTrackingToken,
  payloadForToken,
  tokenFromPayload,
} from './campaign-token';

/**
 * Phase 8 — campaign management, tracked links and click ingestion (§6, §7).
 *
 * This service owns the *rules*: what a valid campaign is, which status transitions exist, how a
 * tracked link is built from existing destination configuration, and how a raw redirect request is
 * classified. Everything that happens on top of it (start/channel-join/alert ingestion, conversions,
 * imports, reporting) lives in the neighbouring services and goes through the same store.
 */

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const NAME_MIN = 2;
const NAME_MAX = 80;
const NOTE_MAX = 200;
/** Bounded number of aggregated rejection keys kept in the document (§16 category 5). */
const MAX_REJECTION_KEYS = 200;
/** In-memory replay damping: an identical request inside this window is not counted twice. */
const CLICK_DEDUPE_WINDOW_MS = 60_000;
const CLICK_DEDUPE_CACHE_SIZE = 5_000;
const TOKEN_ATTEMPTS = 5;

/** A link offered to the operator, with an explicit note about what it can and cannot measure. */
export interface CampaignLink {
  platform: Platform;
  /** Works, but records nothing (a plain platform link). */
  directUrl: string | null;
  /** Goes through this deployment's `/c/<token>` endpoint, so a click is recorded. */
  trackedUrl: string | null;
  note: string;
}

export interface CampaignLinks {
  campaignId: string;
  /** The `?start=` payload used by bot links (`null` for channel campaigns). */
  payload: string | null;
  links: CampaignLink[];
  notes: string[];
}

export interface ClickIngestionInput {
  token: string;
  /** Platform hinted by the shared link (`?p=`); `null` = derive the default order. */
  platformHint: Platform | null;
  /** User agent of the request, used *only* to classify it — never stored. */
  userAgent: string | null;
  now: Date;
}

export interface ClickIngestionResult {
  decision: ClickDecision;
  /** Where the visitor should be sent (`null` when there is no target at all). */
  target: string | null;
  classification: ClickClassification;
  /** `true` only when the request was actually stored as a click event. */
  recorded: boolean;
  reason: string;
  campaignId: string | null;
}

/** Raw platform hints recognized in a tracked link (`?p=telegram`). */
const PLATFORM_VALUES: readonly Platform[] = ['bale', 'telegram'];
const DEFAULT_PLATFORM_ORDER: readonly Platform[] = ['bale', 'telegram'];

/** User-agent markers of link previews/crawlers — recorded, never counted as human clicks (§7.3). */
const PREVIEW_MARKERS: readonly string[] = [
  'bot',
  'crawler',
  'spider',
  'preview',
  'curl',
  'wget',
  'python-requests',
  'headless',
  'facebookexternalhit',
  'whatsapp',
  'slack',
  'telegram',
  'node-fetch',
  'axios',
  'go-http-client',
  'okhttp',
];

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);
  /** Bounded, process-local replay damping (never persisted, never logged). */
  private readonly recentClicks = new Map<string, number>();

  constructor(
    private readonly config: AppConfigService,
    private readonly store: CampaignStore,
    private readonly destinations: BotDestinationService,
  ) {}

  /**
   * Whether campaign tracking is switched on.
   *
   * Persistence is *not* part of this switch: exactly like the Phase 2/3 stores, an empty
   * `CAMPAIGN_DATA_FILE` keeps everything in memory (useful for development and tests) and is reported
   * as a warning instead of blocking the feature. A configured file is what makes the data durable.
   */
  get enabled(): boolean {
    return this.config.campaignTrackingEnabled;
  }

  get trackingDisabledReason(): string | null {
    return this.config.campaignTrackingEnabled
      ? null
      : 'ردیابی کمپین (CAMPAIGN_TRACKING_ENABLED) غیرفعال است.';
  }

  /**
   * Non-blocking warning about durability, shown on the dashboard. It is deliberately *not* an error:
   * the memory store is a supported configuration, but an operator must know that a restart loses it.
   */
  get persistenceWarning(): string | null {
    return this.store.enabled
      ? null
      : 'فایل داده کمپین (CAMPAIGN_DATA_FILE) تنظیم نشده است؛ رکوردها فقط در حافظه نگه داشته می‌شوند.';
  }

  // --- reads ------------------------------------------------------------------

  findCampaign(campaignId: string): CampaignRecord | null {
    return this.store.findCampaign(campaignId);
  }

  listCampaigns(): CampaignRecord[] {
    return this.store.listCampaigns();
  }

  /** Campaigns whose source/medium/status match the (optional) filters, newest first. */
  findCampaigns(filter: {
    source?: string;
    medium?: string;
    status?: CampaignStatus;
  }): CampaignRecord[] {
    return this.listCampaigns()
      .filter((campaign) => {
        if (filter.source && campaign.source !== filter.source) {
          return false;
        }

        if (filter.medium && campaign.medium !== filter.medium) {
          return false;
        }

        if (filter.status && campaign.status !== filter.status) {
          return false;
        }

        return true;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Distinct sources/mediums, used by the dashboard filters (no arbitrary list is invented). */
  knownFacets(): { sources: string[]; mediums: string[] } {
    const sources = new Set<string>();
    const mediums = new Set<string>();

    for (const campaign of this.listCampaigns()) {
      sources.add(campaign.source);

      if (campaign.medium) {
        mediums.add(campaign.medium);
      }
    }

    return { sources: [...sources].sort(), mediums: [...mediums].sort() };
  }

  // --- management (§6) --------------------------------------------------------

  async createCampaign(
    input: CampaignCreationInput,
  ): Promise<CampaignResult<CampaignRecord>> {
    const disabled = this.requireEnabled<CampaignRecord>();

    if (disabled) {
      return disabled;
    }

    const validated = this.validateCreation(input);

    if (!validated.ok) {
      return validated;
    }

    const value = validated.value;
    const now = new Date().toISOString();

    try {
      const created = await this.store.transact((tx) => {
        // The token is random; a collision is retried, and a persistent collision is a hard error
        // rather than a silently shared token (§5.7 uniqueness).
        let token = generateTrackingToken();

        for (let attempt = 1; attempt < TOKEN_ATTEMPTS; attempt += 1) {
          if (!tx.findCampaignByToken(token)) {
            break;
          }

          token = generateTrackingToken();
        }

        if (tx.findCampaignByToken(token)) {
          throw new Error('TOKEN_COLLISION');
        }

        const campaign: CampaignRecord = {
          campaignId: tx.nextId('cmp'),
          name: value.name,
          source: value.source,
          medium: value.medium,
          status: 'ACTIVE',
          destinationType: value.destinationType,
          destination: value.destination,
          trackingToken: token,
          createdAt: now,
          createdBy: value.createdBy,
          startAt: value.startAt,
          endAt: value.endAt,
          costAmount: value.costAmount,
          costCurrency: value.costCurrency,
          updatedAt: now,
          note: value.note,
        };

        tx.saveCampaign(campaign);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: now,
          operator: value.createdBy ?? 'system',
          action: 'CAMPAIGN_CREATED',
          campaignId: campaign.campaignId,
          detail: `source=${campaign.source} medium=${campaign.medium ?? '-'} destination=${campaign.destinationType}:${campaign.destination}`,
        });

        return { ...campaign };
      });

      this.logger.log(
        `Campaign ${created.campaignId} created (source=${created.source}, destination=${created.destinationType}:${created.destination}) by ${created.createdBy ?? 'system'}; token not logged.`,
      );

      return campaignOk(created);
    } catch (error) {
      return this.failFromError<CampaignRecord>(error, 'ساخت کمپین');
    }
  }

  async setStatus(
    campaignId: string,
    status: CampaignStatus,
    operator: string,
  ): Promise<CampaignResult<CampaignRecord>> {
    const disabled = this.requireEnabled<CampaignRecord>();

    if (disabled) {
      return disabled;
    }

    const campaign = this.store.findCampaign(campaignId);

    if (!campaign) {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    const transition = validateTransition(campaign.status, status);

    if (transition) {
      return campaignFail('INVALID_STATUS_TRANSITION', transition);
    }

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findCampaign(campaignId);

        if (!current) {
          throw new Error('NOT_FOUND');
        }

        const next: CampaignRecord = {
          ...current,
          status,
          updatedAt: new Date().toISOString(),
        };

        tx.saveCampaign(next);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: next.updatedAt,
          operator,
          action: `CAMPAIGN_STATUS_${status}`,
          campaignId,
          detail: `${current.status} → ${status}`,
        });

        return { ...next };
      });

      this.logger.log(
        `Campaign ${campaignId} status ${campaign.status} → ${status} by ${operator}.`,
      );

      return campaignOk(updated);
    } catch (error) {
      return this.failFromError<CampaignRecord>(error, 'تغییر وضعیت کمپین');
    }
  }

  async updateMetadata(
    campaignId: string,
    patch: { name?: string; medium?: string | null; note?: string | null },
    operator: string,
  ): Promise<CampaignResult<CampaignRecord>> {
    const disabled = this.requireEnabled<CampaignRecord>();

    if (disabled) {
      return disabled;
    }

    const campaign = this.store.findCampaign(campaignId);

    if (!campaign) {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    const name = patch.name === undefined ? campaign.name : patch.name.trim();

    if (patch.name !== undefined) {
      const nameError = validateName(name);

      if (nameError) {
        return campaignFail('INVALID_NAME', nameError);
      }
    }

    const medium =
      patch.medium === undefined
        ? campaign.medium
        : patch.medium === null
          ? null
          : String(patch.medium).trim().toLowerCase();

    if (medium !== null && !SOURCE_PATTERN.test(medium)) {
      return campaignFail(
        'INVALID_MEDIUM',
        'میان‌مدیا (medium) باید حروف کوچک لاتین، عدد، «-» یا «_» و حداکثر ۳۲ کاراکتر باشد.',
      );
    }

    const note =
      patch.note === undefined
        ? campaign.note
        : patch.note === null
          ? null
          : String(patch.note).trim().slice(0, NOTE_MAX);

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findCampaign(campaignId);

        if (!current) {
          throw new Error('NOT_FOUND');
        }

        const next: CampaignRecord = {
          ...current,
          name,
          medium,
          note,
          updatedAt: new Date().toISOString(),
        };

        tx.saveCampaign(next);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: next.updatedAt,
          operator,
          action: 'CAMPAIGN_UPDATED',
          campaignId,
          detail: `name="${name}" medium=${medium ?? '-'}`,
        });

        return { ...next };
      });

      this.logger.log(
        `Campaign ${campaignId} metadata updated by ${operator}.`,
      );

      return campaignOk(updated);
    } catch (error) {
      return this.failFromError<CampaignRecord>(error, 'ویرایش کمپین');
    }
  }

  async setCost(
    campaignId: string,
    amount: number | null,
    currency: string | null,
    operator: string,
  ): Promise<CampaignResult<CampaignRecord>> {
    const disabled = this.requireEnabled<CampaignRecord>();

    if (disabled) {
      return disabled;
    }

    // The operator may type either case; what is stored is always the canonical upper-case code.
    const normalizedCurrency =
      currency === null ? null : currency.trim().toUpperCase();
    const validation = validateCost(amount, normalizedCurrency);

    if (validation) {
      return campaignFail('INVALID_COST', validation);
    }

    const campaign = this.store.findCampaign(campaignId);

    if (!campaign) {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findCampaign(campaignId);

        if (!current) {
          throw new Error('NOT_FOUND');
        }

        const next: CampaignRecord = {
          ...current,
          costAmount: amount,
          costCurrency: normalizedCurrency,
          updatedAt: new Date().toISOString(),
        };

        tx.saveCampaign(next);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: next.updatedAt,
          operator,
          action: 'CAMPAIGN_COST_SET',
          campaignId,
          detail:
            amount === null
              ? 'cost cleared'
              : `cost=${amount} ${currency?.toUpperCase() ?? ''}`.trim(),
        });

        return { ...next };
      });

      this.logger.log(
        `Campaign ${campaignId} cost updated by ${operator} (${amount ?? '-'} ${currency ?? '-'}).`,
      );

      return campaignOk(updated);
    } catch (error) {
      return this.failFromError<CampaignRecord>(error, 'ثبت هزینه کمپین');
    }
  }

  async setDateRange(
    campaignId: string,
    startAt: string | null,
    endAt: string | null,
    operator: string,
  ): Promise<CampaignResult<CampaignRecord>> {
    const disabled = this.requireEnabled<CampaignRecord>();

    if (disabled) {
      return disabled;
    }

    const rangeError = validateRange(startAt, endAt);

    if (rangeError) {
      return campaignFail('INVALID_DATE_RANGE', rangeError);
    }

    const campaign = this.store.findCampaign(campaignId);

    if (!campaign) {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findCampaign(campaignId);

        if (!current) {
          throw new Error('NOT_FOUND');
        }

        const next: CampaignRecord = {
          ...current,
          startAt,
          endAt,
          updatedAt: new Date().toISOString(),
        };

        tx.saveCampaign(next);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: next.updatedAt,
          operator,
          action: 'CAMPAIGN_RANGE_SET',
          campaignId,
          detail: `start=${startAt ?? '-'} end=${endAt ?? '-'}`,
        });

        return { ...next };
      });

      this.logger.log(
        `Campaign ${campaignId} date range updated by ${operator}.`,
      );

      return campaignOk(updated);
    } catch (error) {
      return this.failFromError<CampaignRecord>(error, 'ثبت بازه زمانی کمپین');
    }
  }

  // --- links (§7) -------------------------------------------------------------

  /**
   * All links of a campaign.
   *
   * Two flavours are produced on purpose:
   *  * `directUrl` — the platform link itself; it works, but nothing is measured.
   *  * `trackedUrl` — a link on this deployment (`<base>/c/<token>?p=…`) that records the click and
   *    then forwards to the *same* allow-listed destination.
   *
   * When a URL cannot be built (missing bot username, missing channel URL, no tracking base URL) the
   * corresponding entry is `null` and a note explains why — a guessed or dead link is never emitted.
   */
  buildLinks(campaign: CampaignRecord): CampaignLinks {
    const notes: string[] = [];
    const links: CampaignLink[] = [];
    const base = this.config.campaignTrackingBaseUrl;

    if (campaign.destinationType === 'BOT_START') {
      const payload = payloadForToken(campaign.trackingToken);

      for (const platform of PLATFORM_VALUES) {
        const directUrl = this.destinations.botDeepLink(platform, payload);
        const trackedUrl =
          base && directUrl
            ? `${base}/c/${campaign.trackingToken}?p=${platform}`
            : null;

        if (!directUrl) {
          notes.push(
            `برای ${platform} نام کاربری عمومی ربات تنظیم نشده است؛ لینک این پلتفرم ساخته نشد.`,
          );
        }

        if (directUrl && !trackedUrl) {
          notes.push(
            `لینک ردیابی‌شده ساخته نشد چون CAMPAIGN_TRACKING_BASE_URL تنظیم نشده است؛ لینک مستقیم ${platform} کلیک ثبت نمی‌کند.`,
          );
        }

        links.push({
          platform,
          directUrl,
          trackedUrl,
          note: directUrl
            ? 'لینک ردیابی‌شده کلیک را ثبت می‌کند؛ لینک مستقیم فقط بازدید را ممکن می‌کند.'
            : 'این پلتفرم قابل استفاده نیست.',
        });
      }

      return { campaignId: campaign.campaignId, payload, links, notes };
    }

    const platform = campaign.destination as Platform;
    const directUrl = PLATFORM_VALUES.includes(platform)
      ? this.destinations.channelUrl(platform)
      : null;
    const trackedUrl =
      base && directUrl
        ? `${base}/c/${campaign.trackingToken}?p=${platform}`
        : null;

    if (!directUrl) {
      notes.push(
        `آدرس کانال برای ${campaign.destination} تنظیم نشده است؛ لینک کمپین ساخته نشد.`,
      );
    }

    if (directUrl && !trackedUrl) {
      notes.push(
        'لینک ردیابی‌شده ساخته نشد چون CAMPAIGN_TRACKING_BASE_URL تنظیم نشده است؛ لینک مستقیم کانال کلیک ثبت نمی‌کند.',
      );
    } else if (trackedUrl) {
      notes.push(
        'کلیک روی لینک کانال ثبت می‌شود، اما «عضویت» فقط با تأیید خود پلتفرم قابل اندازه‌گیری است.',
      );
    }

    links.push({
      platform,
      directUrl,
      trackedUrl,
      note: 'کانال؛ ورود به کانال قابل اندازه‌گیری نیست، فقط کلیک روی لینک قابل ثبت است.',
    });

    return { campaignId: campaign.campaignId, payload: null, links, notes };
  }

  /** Parse the `?p=` hint of a tracked link; an unknown value is ignored (never trusted). */
  parsePlatformHint(value: string | null | undefined): Platform | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();

    return PLATFORM_VALUES.includes(normalized as Platform)
      ? (normalized as Platform)
      : null;
  }

  /** Resolve a token to a campaign *and* say whether it still accepts traffic (§7.2/§7.4). */
  resolveToken(
    token: string,
    at: Date = new Date(),
  ): TrackingResolution | null {
    if (!isTrackingToken(token)) {
      return null;
    }

    const campaign = this.store.findCampaignByToken(token);

    if (!campaign) {
      return null;
    }

    const blockedReason = this.acceptingReason(campaign, at);

    return { campaign, accepting: blockedReason === null, blockedReason };
  }

  /** Resolve the tracking reference inside a `/start <payload>`; `null` for every other payload. */
  resolvePayload(
    payload: string,
    at: Date = new Date(),
  ): TrackingResolution | null {
    const token = tokenFromPayload(payload);

    return token ? this.resolveToken(token, at) : null;
  }

  /**
   * Why a campaign currently refuses *new* traffic, or `null` when it accepts it.
   *
   * History is never affected: pausing only stops new references from being accepted.
   */
  acceptingReason(campaign: CampaignRecord, at: Date): string | null {
    if (campaign.status === 'PAUSED') {
      return 'این کمپین موقتاً متوقف شده است.';
    }

    if (campaign.status === 'ENDED') {
      return 'این کمپین پایان یافته است.';
    }

    if (campaign.startAt && at.getTime() < Date.parse(campaign.startAt)) {
      return 'زمان شروع این کمپین فرا نرسیده است.';
    }

    if (campaign.endAt && at.getTime() > Date.parse(campaign.endAt)) {
      return 'بازه زمانی این کمپین به پایان رسیده است.';
    }

    return null;
  }

  /**
   * Handle one raw request to `/c/<token>` (§7.3).
   *
   * The target is recomputed from configuration on every request, so a campaign can never act as an
   * open redirect: only the allow-listed bot route or the configured channel URL is ever returned.
   */
  async recordClick(input: ClickIngestionInput): Promise<ClickIngestionResult> {
    const classification = classifyRequest(input.userAgent);
    const resolution = this.resolveToken(input.token, input.now);

    if (!resolution) {
      await this.countRejection(null, 'UNKNOWN_TOKEN');

      return {
        decision: 'NOT_FOUND',
        target: null,
        classification,
        recorded: false,
        reason: 'نشانه ردیابی شناخته نشد.',
        campaignId: null,
      };
    }

    const campaign = resolution.campaign;
    const target = this.targetFor(campaign, input.platformHint);

    if (!resolution.accepting) {
      await this.countRejection(campaign.campaignId, 'CAMPAIGN_INACTIVE');

      return {
        decision: 'GONE',
        target: null,
        classification,
        recorded: false,
        reason: resolution.blockedReason ?? 'کمپین فعال نیست.',
        campaignId: campaign.campaignId,
      };
    }

    if (!target) {
      await this.countRejection(campaign.campaignId, 'NO_TARGET_CONFIGURED');

      return {
        decision: 'GONE',
        target: null,
        classification,
        recorded: false,
        reason:
          'مقصد این کمپین در تنظیمات موجود نیست؛ هیچ آدرسی حدس زده نمی‌شود.',
        campaignId: campaign.campaignId,
      };
    }

    if (classification !== 'HUMAN') {
      // A preview/crawler fetch is *not* a human click: the request is forwarded (so link previews
      // work) and counted as a rejected ingestion, but no click event is created (§7.3).
      await this.countRejection(
        campaign.campaignId,
        classification === 'PREVIEW' ? 'PREVIEW_FETCH' : 'UNCLASSIFIED_REQUEST',
      );

      return {
        decision: 'REDIRECT',
        target,
        classification,
        recorded: false,
        reason:
          classification === 'PREVIEW'
            ? 'درخواست پیش‌نمایش/خزنده است و کلیک انسانی محسوب نمی‌شود.'
            : 'نوع درخواست قابل تشخیص نبود؛ کلیک انسانی ثبت نشد.',
        campaignId: campaign.campaignId,
      };
    }

    if (this.isReplay(input.token, input.userAgent, input.now)) {
      await this.countRejection(campaign.campaignId, 'REPLAY_DAMPED');

      return {
        decision: 'REDIRECT',
        target,
        classification,
        recorded: false,
        reason:
          'درخواست تکراری در بازه کوتاه؛ برای جلوگیری از شمارش چندباره ثبت نشد.',
        campaignId: campaign.campaignId,
      };
    }

    const recorded = await this.persistClick(campaign, input.now, target);

    return {
      decision: 'REDIRECT',
      target,
      classification,
      recorded,
      reason: recorded
        ? 'کلیک ثبت شد.'
        : 'کلیک ثبت نشد (خطای ذخیره‌سازی)؛ بازدیدکننده هدایت شد.',
      campaignId: campaign.campaignId,
    };
  }

  /** Where a token points right now (`null` when nothing allow-listed is configured). */
  targetFor(
    campaign: CampaignRecord,
    platformHint: Platform | null,
  ): string | null {
    if (campaign.destinationType === 'CHANNEL_INVITE') {
      const platform = campaign.destination as Platform;

      return PLATFORM_VALUES.includes(platform)
        ? this.destinations.channelUrl(platform)
        : null;
    }

    if (!isBotRoute(campaign.destination)) {
      return null;
    }

    const payload = payloadForToken(campaign.trackingToken);
    const order = platformHint
      ? [
          platformHint,
          ...DEFAULT_PLATFORM_ORDER.filter((p) => p !== platformHint),
        ]
      : DEFAULT_PLATFORM_ORDER;

    for (const platform of order) {
      const url = this.destinations.botDeepLink(platform, payload);

      if (url) {
        return url;
      }
    }

    return null;
  }

  // --- internals --------------------------------------------------------------

  private async persistClick(
    campaign: CampaignRecord,
    now: Date,
    target: string,
  ): Promise<boolean> {
    try {
      await this.store.transact((tx) => {
        // A raw request has no user identity (and fingerprinting is out of scope, §21), so there is
        // no natural dedupe key: the event id itself is the key and the damping above is what keeps
        // reloads from inflating the number.
        const eventId = tx.nextId('evt');

        tx.saveEvent({
          eventId,
          type: 'CLICK',
          campaignId: campaign.campaignId,
          platform: null,
          platformUserId: null,
          identityKey: null,
          occurredAt: now.toISOString(),
          recordedAt: now.toISOString(),
          provenance: 'NATIVE',
          idempotencyKey: `click:${campaign.campaignId}:${eventId}`,
          meta: { target: target.includes('ble.ir') ? 'bale' : 'telegram' },
          externalRef: null,
          clickClassification: 'HUMAN',
        });

        this.pruneClicks(tx, now);
      });

      return true;
    } catch (error) {
      // Persistence failed: the visitor is still forwarded, but the click is *not* claimed as
      // recorded (§11.4). The rejection counter stays in memory in this case, because the store is
      // exactly the thing that failed.
      this.logger.error(
        `Could not persist click for campaign ${campaign.campaignId}: ${describe(error)}`,
      );

      return false;
    }
  }

  /**
   * Retention for raw click requests only (§5.7/§21): conversions, leads, customers, attributions and
   * imported aggregates are never pruned.
   */
  private pruneClicks(tx: CampaignTransaction, now: Date): void {
    const retentionMs = this.config.campaignRawEventRetentionMs;
    const maxRaw = this.config.campaignMaxRawEvents;

    if (retentionMs === 0 && maxRaw === 0) {
      return;
    }

    const clicks = tx
      .listEvents()
      .filter((event) => event.type === 'CLICK')
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
    const keep: string[] = [];
    const perCampaign = new Map<string, number>();

    for (const event of clicks) {
      const expired =
        retentionMs > 0 &&
        now.getTime() - Date.parse(event.recordedAt) > retentionMs;
      const key = event.campaignId ?? 'none';
      const used = perCampaign.get(key) ?? 0;
      const overCap = maxRaw > 0 && used >= maxRaw;

      if (expired || overCap) {
        tx.removeEvent(event.eventId);
        continue;
      }

      perCampaign.set(key, used + 1);
      keep.push(event.eventId);
    }
  }

  /**
   * Public hook for the other campaign services: a rejected ingestion is counted (bounded, aggregated)
   * so the dashboard can show it, and is never stored as user-level data (§16 category 5).
   */
  async countRejectionPublic(
    campaignId: string | null,
    reason: string,
  ): Promise<void> {
    await this.countRejection(campaignId, reason);
  }

  /** Bounded, aggregated counter of rejected ingestion attempts (§16 category 5). */
  private async countRejection(
    campaignId: string | null,
    reason: string,
  ): Promise<void> {
    const key = `${campaignId ?? 'none'}|${reason}`;
    const now = new Date().toISOString();

    try {
      await this.store.transact((tx) => {
        const existing = tx.findRejection(key);

        if (existing) {
          tx.saveRejection({
            ...existing,
            count: existing.count + 1,
            lastAt: now,
          });

          return;
        }

        if (tx.listRejections().length >= MAX_REJECTION_KEYS) {
          const overflowKey = 'none|OTHER_REJECTIONS';
          const overflow = tx.findRejection(overflowKey);

          tx.saveRejection({
            key: overflowKey,
            campaignId: null,
            reason: 'OTHER_REJECTIONS',
            count: (overflow?.count ?? 0) + 1,
            firstAt: overflow?.firstAt ?? now,
            lastAt: now,
          });

          return;
        }

        tx.saveRejection({
          key,
          campaignId,
          reason,
          count: 1,
          firstAt: now,
          lastAt: now,
        });
      });
    } catch (error) {
      // Counting a rejection must never break the visitor's request.
      this.logger.warn(
        `Could not persist rejection counter (${reason}): ${describe(error)}`,
      );
    }
  }

  private isReplay(
    token: string,
    userAgent: string | null,
    now: Date,
  ): boolean {
    const bucket = Math.floor(now.getTime() / CLICK_DEDUPE_WINDOW_MS);
    const key = `${token}|${hashOf(userAgent ?? '')}|${bucket}`;

    if (this.recentClicks.has(key)) {
      return true;
    }

    this.recentClicks.set(key, now.getTime());

    if (this.recentClicks.size > CLICK_DEDUPE_CACHE_SIZE) {
      const oldest = [...this.recentClicks.entries()].sort(
        (left, right) => left[1] - right[1],
      )[0];

      if (oldest) {
        this.recentClicks.delete(oldest[0]);
      }
    }

    return false;
  }

  private validateCreation(input: CampaignCreationInput): CampaignResult<{
    name: string;
    source: string;
    medium: string | null;
    destinationType: CampaignCreationInput['destinationType'];
    destination: string;
    startAt: string | null;
    endAt: string | null;
    costAmount: number | null;
    costCurrency: string | null;
    createdBy: string | null;
    note: string | null;
  }> {
    const name = String(input.name ?? '').trim();
    const nameError = validateName(name);

    if (nameError) {
      return campaignFail('INVALID_NAME', nameError);
    }

    const source = String(input.source ?? '')
      .trim()
      .toLowerCase();

    if (!SOURCE_PATTERN.test(source)) {
      return campaignFail(
        'INVALID_SOURCE',
        'منبع (source) باید حروف کوچک لاتین، عدد، «-» یا «_» و حداکثر ۳۲ کاراکتر باشد (مثال: telegram_ad).',
      );
    }

    const medium =
      input.medium === undefined || input.medium === null
        ? null
        : String(input.medium).trim().toLowerCase();

    if (medium !== null && !SOURCE_PATTERN.test(medium)) {
      return campaignFail(
        'INVALID_MEDIUM',
        'میان‌مدیا (medium) باید حروف کوچک لاتین، عدد، «-» یا «_» و حداکثر ۳۲ کاراکتر باشد.',
      );
    }

    if (
      input.destinationType !== 'BOT_START' &&
      input.destinationType !== 'CHANNEL_INVITE'
    ) {
      return campaignFail(
        'INVALID_DESTINATION_TYPE',
        'نوع مقصد باید BOT_START یا CHANNEL_INVITE باشد.',
      );
    }

    const destination = String(input.destination ?? '')
      .trim()
      .toLowerCase();

    if (input.destinationType === 'BOT_START' && !isBotRoute(destination)) {
      return campaignFail(
        'INVALID_DESTINATION',
        'مسیر مقصد باید یکی از مسیرهای مجاز ربات باشد: alert/prices/coin/gold/channel.',
      );
    }

    if (
      input.destinationType === 'CHANNEL_INVITE' &&
      !PLATFORM_VALUES.includes(destination as Platform)
    ) {
      return campaignFail(
        'INVALID_DESTINATION',
        'مقصد کانال باید یکی از پلتفرم‌های مجاز باشد: bale یا telegram.',
      );
    }

    const startAt = normalizeIso(input.startAt ?? null);
    const endAt = normalizeIso(input.endAt ?? null);
    const rangeError = validateRange(startAt, endAt);

    if (rangeError) {
      return campaignFail('INVALID_DATE_RANGE', rangeError);
    }

    const costAmount = input.costAmount ?? null;
    const costCurrency =
      input.costCurrency === undefined || input.costCurrency === null
        ? null
        : String(input.costCurrency).toUpperCase();
    const costError = validateCost(costAmount, costCurrency);

    if (costError) {
      return campaignFail('INVALID_COST', costError);
    }

    return campaignOk({
      name,
      source,
      medium,
      destinationType: input.destinationType,
      destination,
      startAt,
      endAt,
      costAmount,
      costCurrency,
      createdBy: input.createdBy ?? null,
      note:
        input.note === undefined || input.note === null
          ? null
          : String(input.note).trim().slice(0, NOTE_MAX),
    });
  }

  private requireEnabled<T>(): CampaignResult<T> | null {
    const reason = this.trackingDisabledReason;

    return reason ? campaignFail<T>('DISABLED', reason) : null;
  }

  private failFromError<T>(error: unknown, action: string): CampaignResult<T> {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'NOT_FOUND') {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    if (message === 'TOKEN_COLLISION') {
      return campaignFail(
        'CONFLICT',
        'ساخت نشانه ردیابی یکتا ناموفق بود؛ دوباره تلاش کنید.',
      );
    }

    this.logger.error(`${action} ناموفق بود: ${describe(error)}`);

    return campaignFail(
      'CONFLICT',
      'ذخیره‌سازی ناموفق بود؛ اطلاعات کمپین تغییر نکرد.',
    );
  }
}

// --- helpers ------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Small non-cryptographic hash used *only* as an in-memory replay key (never stored or logged). */
function hashOf(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }

  return hash.toString(36);
}

export function classifyRequest(userAgent: string | null): ClickClassification {
  if (userAgent === null || userAgent.trim() === '') {
    return 'UNCLASSIFIED';
  }

  const normalized = userAgent.toLowerCase();

  return PREVIEW_MARKERS.some((marker) => normalized.includes(marker))
    ? 'PREVIEW'
    : 'HUMAN';
}

function validateName(name: string): string | null {
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return `نام کمپین باید بین ${NAME_MIN} و ${NAME_MAX} کاراکتر باشد.`;
  }

  return null;
}

function validateCost(
  amount: number | null,
  currency: string | null,
): string | null {
  if (amount === null) {
    return currency === null || currency === ''
      ? null
      : 'برای هزینه، مبلغ هم باید ثبت شود.';
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return 'هزینه باید یک عدد نامنفی باشد.';
  }

  if (currency === null || !CURRENCY_PATTERN.test(currency)) {
    return 'واحد پول هزینه باید یک کد سه‌حرفی باشد (مثال: EUR).';
  }

  return null;
}

/** Only a full ISO timestamp with an explicit offset is accepted (`2026-10-16T00:00:00+03:30`). */
function normalizeIso(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toISOString();
}

function validateRange(
  startAt: string | null,
  endAt: string | null,
): string | null {
  if (startAt !== null && !Number.isFinite(Date.parse(startAt))) {
    return 'تاریخ شروع باید ISO 8601 با منطقه زمانی باشد.';
  }

  if (endAt !== null && !Number.isFinite(Date.parse(endAt))) {
    return 'تاریخ پایان باید ISO 8601 با منطقه زمانی باشد.';
  }

  if (
    startAt !== null &&
    endAt !== null &&
    Date.parse(endAt) <= Date.parse(startAt)
  ) {
    return 'تاریخ پایان باید بعد از تاریخ شروع باشد.';
  }

  return null;
}

/** Documented lifecycle (§6.3): ACTIVE ↔ PAUSED, both → ENDED, ENDED is terminal. */
function validateTransition(
  current: CampaignStatus,
  next: CampaignStatus,
): string | null {
  if (current === next) {
    return `کمپین همین حالا در وضعیت ${current} است.`;
  }

  if (current === 'ENDED') {
    return 'کمپین پایان‌یافته قابل تغییر وضعیت نیست؛ کمپین جدید بسازید.';
  }

  if (current === 'ACTIVE' && next === 'PAUSED') {
    return null;
  }

  if (current === 'PAUSED' && next === 'ACTIVE') {
    return null;
  }

  if ((current === 'ACTIVE' || current === 'PAUSED') && next === 'ENDED') {
    return null;
  }

  return 'این تغییر وضعیت مجاز نیست.';
}

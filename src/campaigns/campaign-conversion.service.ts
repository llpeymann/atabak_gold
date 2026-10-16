import { Injectable, Logger } from '@nestjs/common';

import { Platform } from '../platform/platform.types';
import { UserStore } from '../users/user.store';
import { CampaignService } from './campaign.service';
import { CampaignStore, identityKeyOf } from './campaign.store';
import { CampaignTrackingService } from './campaign-tracking.service';
import { evidenceOf } from './attribution';
import {
  campaignFail,
  campaignOk,
  CampaignResult,
  ConversionRecord,
  ConversionType,
  ExternalMetricImportRecord,
  FunnelStage,
} from './campaign.types';

/**
 * Phase 8 — manual conversions and imported aggregates (§5.5, §5.6, §8.6, §8.7, §17).
 *
 * There is no sales API in this project and no way to observe a purchase, so a Lead or a Customer is
 * **never** inferred: an authorized operator registers it, the operator id and both timestamps are
 * stored, and a correction keeps the previous row in the document as `CORRECTED` instead of deleting
 * history. External numbers (impressions, ad-platform clicks) can only enter as *aggregates* for a
 * period, labelled `EXTERNAL_AGGREGATE` wherever they are shown.
 */

const CURRENCY_LIKE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The five stages an external platform can report as a number (§5.5). */
const IMPORTABLE_STAGES: readonly FunnelStage[] = [
  'IMPRESSION',
  'CLICK',
  'START',
  'CHANNEL_JOIN',
  'LEAD',
];
/** Clock-skew allowance for an operator-entered time: beyond this, “future” is a typo. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface ConversionInput {
  type: ConversionType;
  /** Either a platform identity (`bale:12345`) or an internal user id (`usr_3`). */
  userReference: string;
  /** Business time of the conversion, ISO 8601 with offset. */
  occurredAt: string;
  operator: string;
  note?: string | null;
}

export interface ConversionCorrectionInput {
  conversionId: string;
  /** New business time (defaults to the current value). */
  occurredAt?: string;
  note?: string | null;
  operator: string;
}

export interface AggregateImportInput {
  campaignId: string;
  /** External system the number came from (`telegram_ads`, `bale_ads`, `manual_sheet`, …). */
  provider: string;
  metric: FunnelStage;
  value: number;
  periodStart: string;
  periodEnd: string;
  operator: string;
  note?: string | null;
  /** Correct an earlier number for the same period instead of being rejected as a duplicate. */
  replaceExisting?: boolean;
}

@Injectable()
export class CampaignConversionService {
  private readonly logger = new Logger(CampaignConversionService.name);

  constructor(
    private readonly store: CampaignStore,
    private readonly campaigns: CampaignService,
    private readonly tracking: CampaignTrackingService,
    private readonly users: UserStore,
  ) {}

  get enabled(): boolean {
    return this.campaigns.enabled;
  }

  /** Active conversions only (`CORRECTED` rows stay in the document for the audit trail). */
  listConversions(filter: { campaignId?: string } = {}): ConversionRecord[] {
    return this.store
      .listConversions()
      .filter((record) => record.status === 'ACTIVE')
      .filter(
        (record) =>
          filter.campaignId === undefined ||
          record.campaignId === filter.campaignId,
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }

  listImports(campaignId?: string): ExternalMetricImportRecord[] {
    return this.store
      .listImports()
      .filter((record) => record.status === 'ACTIVE')
      .filter(
        (record) =>
          campaignId === undefined || record.campaignId === campaignId,
      )
      .sort((left, right) => right.periodStart.localeCompare(left.periodStart));
  }

  // --- manual conversions ------------------------------------------------------

  async registerConversion(
    input: ConversionInput,
  ): Promise<CampaignResult<ConversionRecord>> {
    const disabled = this.requireEnabled<ConversionRecord>();

    if (disabled) {
      return disabled;
    }

    const identity = this.resolveIdentity(input.userReference);

    if (!identity.ok) {
      return identity;
    }

    const occurredAt = validateOccurredAt(input.occurredAt);

    if (!occurredAt) {
      return campaignFail(
        'INVALID_CONVERSION_TIME',
        'زمان تبدیل باید ISO 8601 با منطقه زمانی و نه در آینده باشد.',
      );
    }

    const { platform, platformUserId, identityKey } = identity.value;
    const existing = this.findActive(input.type, identityKey);

    if (existing) {
      return campaignFail(
        'CONFLICT',
        `این کاربر قبلاً به‌عنوان ${input.type} ثبت شده است (${existing.conversionId}). برای اصلاح، همان رکورد را ویرایش کنید.`,
      );
    }

    const decisions = this.tracking.attributionDecisionsFor(
      identityKey,
      occurredAt,
    );
    const credited = decisions.lastTouch.campaignId
      ? decisions.lastTouch
      : decisions.firstTouch.campaignId
        ? decisions.firstTouch
        : decisions.lastTouch;
    const now = new Date();
    const note =
      input.note === undefined || input.note === null
        ? null
        : String(input.note).trim().slice(0, 200);

    try {
      const record = await this.store.transact((tx) => {
        const conversionId = tx.nextId('cnv');

        const conversion: ConversionRecord = {
          conversionId,
          type: input.type,
          identityKey,
          platform,
          platformUserId,
          occurredAt: occurredAt.toISOString(),
          recordedAt: now.toISOString(),
          recordedBy: input.operator,
          campaignId: credited.campaignId,
          attributionModel: credited.campaignId ? credited.model : null,
          attributionBucket: credited.campaignId ? 'CAMPAIGN' : credited.bucket,
          attributionReason: credited.reason,
          attributionEvidence: evidenceOf(credited),
          firstTouch: {
            campaignId: decisions.firstTouch.campaignId,
            bucket: decisions.firstTouch.bucket,
          },
          lastTouch: {
            campaignId: decisions.lastTouch.campaignId,
            bucket: decisions.lastTouch.bucket,
          },
          status: 'ACTIVE',
          supersededBy: null,
          note,
        };

        tx.saveConversion(conversion);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: now.toISOString(),
          operator: input.operator,
          action: `${input.type}_REGISTERED`,
          campaignId: conversion.campaignId,
          detail: `${conversionId} identity=${identityKey} bucket=${conversion.attributionBucket}`,
        });

        return { ...conversion };
      });

      this.logger.log(
        `${input.type} ${record.conversionId} registered by ${input.operator} ` +
          `(campaign ${record.campaignId ?? 'unattributed'}, bucket ${record.attributionBucket}).`,
      );

      return campaignOk(record);
    } catch (error) {
      return this.failFromError<ConversionRecord>(error, 'ثبت تبدیل');
    }
  }

  /**
   * Correct a conversion without losing the original (§5.6).
   *
   * The previous row is marked `CORRECTED` and points at its successor; the new row carries the same
   * identity and type and is re-attributed at its (possibly corrected) business time.
   */
  async correctConversion(
    input: ConversionCorrectionInput,
  ): Promise<CampaignResult<ConversionRecord>> {
    const disabled = this.requireEnabled<ConversionRecord>();

    if (disabled) {
      return disabled;
    }

    const previous = this.store
      .listConversions()
      .find((record) => record.conversionId === input.conversionId);

    if (!previous) {
      return campaignFail('NOT_FOUND', 'تبدیل یافت نشد.');
    }

    if (previous.status !== 'ACTIVE') {
      return campaignFail(
        'CONFLICT',
        'این رکورد قبلاً اصلاح شده است؛ آخرین نسخه را ویرایش کنید.',
      );
    }

    const occurredAt =
      input.occurredAt === undefined
        ? new Date(previous.occurredAt)
        : validateOccurredAt(input.occurredAt);

    if (!occurredAt) {
      return campaignFail(
        'INVALID_CONVERSION_TIME',
        'زمان تبدیل باید ISO 8601 با منطقه زمانی و نه در آینده باشد.',
      );
    }

    const identityKey = previous.identityKey;

    if (!identityKey) {
      return campaignFail(
        'INVALID_IDENTITY',
        'این رکورد هویت پلتفرمی ندارد؛ اصلاح آن ممکن نیست.',
      );
    }

    const decisions = this.tracking.attributionDecisionsFor(
      identityKey,
      occurredAt,
    );
    const credited = decisions.lastTouch.campaignId
      ? decisions.lastTouch
      : decisions.firstTouch.campaignId
        ? decisions.firstTouch
        : decisions.lastTouch;
    const now = new Date();
    const note =
      input.note === undefined
        ? previous.note
        : input.note === null
          ? null
          : String(input.note).trim().slice(0, 200);

    try {
      const record = await this.store.transact((tx) => {
        const current = tx.findConversion(input.conversionId);

        if (!current || current.status !== 'ACTIVE') {
          throw new Error('NOT_FOUND');
        }

        const replacementId = tx.nextId('cnv');

        const replacement: ConversionRecord = {
          ...current,
          conversionId: replacementId,
          occurredAt: occurredAt.toISOString(),
          recordedAt: now.toISOString(),
          recordedBy: input.operator,
          campaignId: credited.campaignId,
          attributionModel: credited.campaignId ? credited.model : null,
          attributionBucket: credited.campaignId ? 'CAMPAIGN' : credited.bucket,
          attributionReason: credited.reason,
          attributionEvidence: evidenceOf(credited),
          firstTouch: {
            campaignId: decisions.firstTouch.campaignId,
            bucket: decisions.firstTouch.bucket,
          },
          lastTouch: {
            campaignId: decisions.lastTouch.campaignId,
            bucket: decisions.lastTouch.bucket,
          },
          status: 'ACTIVE',
          supersededBy: null,
          note,
        };

        tx.saveConversion({
          ...current,
          status: 'CORRECTED',
          supersededBy: replacementId,
        });
        tx.saveConversion(replacement);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: now.toISOString(),
          operator: input.operator,
          action: `${current.type}_CORRECTED`,
          campaignId: replacement.campaignId,
          detail: `${current.conversionId} → ${replacementId}`,
        });

        return { ...replacement };
      });

      this.logger.log(
        `Conversion ${previous.conversionId} corrected by ${input.operator} → ${record.conversionId}.`,
      );

      return campaignOk(record);
    } catch (error) {
      return this.failFromError<ConversionRecord>(error, 'اصلاح تبدیل');
    }
  }

  // --- imported aggregates -----------------------------------------------------

  /**
   * Import an aggregate number (§5.5).
   *
   * Aggregates are never exploded into user-level events: the record keeps the period it covers and
   * the dedup key `${provider}|${campaignId}|${metric}|${periodStart}|${periodEnd}`, so re-importing
   * the same file cannot inflate a metric, and a wrong number is corrected explicitly.
   */
  async importAggregate(
    input: AggregateImportInput,
  ): Promise<CampaignResult<ExternalMetricImportRecord>> {
    const disabled = this.requireEnabled<ExternalMetricImportRecord>();

    if (disabled) {
      return disabled;
    }

    const provider = String(input.provider ?? '')
      .trim()
      .toLowerCase();

    if (!CURRENCY_LIKE.test(provider)) {
      return campaignFail(
        'INVALID_IMPORT',
        'نام منبع خارجی باید حروف کوچک لاتین، عدد، «-» یا «_» و حداکثر ۳۲ کاراکتر باشد.',
      );
    }

    if (!IMPORTABLE_STAGES.includes(input.metric)) {
      return campaignFail(
        'INVALID_IMPORT',
        `مرحله قابل واردکردن نیست؛ مقادیر مجاز: ${IMPORTABLE_STAGES.join(', ')}.`,
      );
    }

    if (!Number.isInteger(input.value) || input.value < 0) {
      return campaignFail(
        'INVALID_IMPORT',
        'مقدار واردشده باید عدد صحیح نامنفی باشد.',
      );
    }

    const periodStart = normalizePeriod(input.periodStart);
    const periodEnd = normalizePeriod(input.periodEnd);

    if (!periodStart || !periodEnd) {
      return campaignFail(
        'INVALID_IMPORT',
        'بازه واردشده باید تاریخ ISO 8601 باشد (مثال: 2026-10-01).',
      );
    }

    if (Date.parse(periodEnd) < Date.parse(periodStart)) {
      return campaignFail(
        'INVALID_IMPORT',
        'پایان بازه باید بعد از شروع آن باشد.',
      );
    }

    const campaign = this.store.findCampaign(input.campaignId);

    if (!campaign) {
      return campaignFail('NOT_FOUND', 'کمپین یافت نشد.');
    }

    const dedupKey = `${provider}|${input.campaignId}|${input.metric}|${periodStart}|${periodEnd}`;
    const existing = this.store
      .listImports()
      .find(
        (record) => record.dedupKey === dedupKey && record.status === 'ACTIVE',
      );

    if (existing && !input.replaceExisting) {
      return campaignFail(
        'CONFLICT',
        `این عدد قبلاً برای همان بازه ثبت شده است (${existing.importId}). برای اصلاح، حالت «اصلاح» را انتخاب کنید.`,
      );
    }

    const note =
      input.note === undefined || input.note === null
        ? null
        : String(input.note).trim().slice(0, 200);
    const now = new Date();

    try {
      const record = await this.store.transact((tx) => {
        const importId = tx.nextId('imp');
        const next: ExternalMetricImportRecord = {
          importId,
          metric: input.metric,
          campaignId: input.campaignId,
          provider,
          value: input.value,
          periodStart,
          periodEnd,
          dedupKey,
          importedAt: now.toISOString(),
          importedBy: input.operator,
          note,
          status: 'ACTIVE',
        };

        const current = tx.findImport(dedupKey);

        if (current) {
          tx.saveImport({ ...current, status: 'SUPERSEDED' });
        }

        tx.saveImport(next);
        tx.appendAudit({
          auditId: tx.nextId('aud'),
          at: now.toISOString(),
          operator: input.operator,
          action: current ? 'AGGREGATE_IMPORT_REPLACED' : 'AGGREGATE_IMPORTED',
          campaignId: input.campaignId,
          detail: `${provider} ${input.metric}=${input.value} ${periodStart}..${periodEnd}`,
        });

        return { ...next };
      });

      this.logger.log(
        `Aggregate ${input.metric}=${input.value} imported for campaign ${input.campaignId} ` +
          `by ${input.operator} (provider ${provider}${existing ? ', replaced' : ''}).`,
      );

      return campaignOk(record);
    } catch (error) {
      return this.failFromError<ExternalMetricImportRecord>(
        error,
        'ثبت داده واردشده',
      );
    }
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Resolve what the operator typed into an existing platform identity.
   *
   * Two accepted forms: `platform:platformUserId` (the identity as the platform knows it) and an
   * internal `usr_…` id, resolved through the Phase 2/7 user store. Nothing is created: an unknown
   * reference is an error, never a new user (§5.4 — no second user database).
   */
  private resolveIdentity(reference: string): CampaignResult<{
    platform: Platform;
    platformUserId: string;
    identityKey: string;
  }> {
    const value = String(reference ?? '').trim();

    if (value === '') {
      return campaignFail('INVALID_IDENTITY', 'شناسه کاربر لازم است.');
    }

    const direct = /^(bale|telegram):([0-9A-Za-z_-]{1,32})$/.exec(value);

    if (direct) {
      const platform = direct[1] as Platform;
      const platformUserId = direct[2];

      return campaignOk({
        platform,
        platformUserId,
        identityKey: identityKeyOf(platform, platformUserId),
      });
    }

    if (value.startsWith('usr_')) {
      const user = this.users.findUser(value);

      if (!user) {
        return campaignFail(
          'INVALID_IDENTITY',
          'کاربری با این شناسه یافت نشد.',
        );
      }

      const userPlatformUserId = user.platformUserId;

      if (typeof userPlatformUserId !== 'string' || userPlatformUserId === '') {
        return campaignFail(
          'INVALID_IDENTITY',
          'این کاربر هویت پلتفرمی ندارد.',
        );
      }

      return campaignOk({
        platform: user.platform,
        platformUserId: userPlatformUserId,
        identityKey: identityKeyOf(user.platform, userPlatformUserId),
      });
    }

    return campaignFail(
      'INVALID_IDENTITY',
      'شناسه کاربر باید به شکل <platform>:<id> (مثال bale:12345) یا شناسه داخلی usr_… باشد.',
    );
  }

  private findActive(
    type: ConversionType,
    identityKey: string,
  ): ConversionRecord | null {
    return (
      this.store
        .listConversions()
        .find(
          (record) =>
            record.status === 'ACTIVE' &&
            record.type === type &&
            record.identityKey === identityKey,
        ) ?? null
    );
  }

  private requireEnabled<T>(): CampaignResult<T> | null {
    const reason = this.campaigns.trackingDisabledReason;

    return reason ? campaignFail<T>('DISABLED', reason) : null;
  }

  private failFromError<T>(error: unknown, action: string): CampaignResult<T> {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'NOT_FOUND') {
      return campaignFail('NOT_FOUND', 'رکورد یافت نشد.');
    }

    this.logger.error(`${action} ناموفق بود: ${message}`);

    return campaignFail(
      'CONFLICT',
      'ذخیره‌سازی ناموفق بود؛ اطلاعات تغییری نکرد.',
    );
  }
}

/** Business time must be a parseable ISO value and not (meaningfully) in the future. */
function validateOccurredAt(value: string): Date | null {
  const parsed = Date.parse(String(value ?? ''));

  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (parsed > Date.now() + FUTURE_TOLERANCE_MS) {
    return null;
  }

  return new Date(parsed);
}

/** Periods are stored as ISO timestamps; a date-only value is kept as the start of that day. */
function normalizePeriod(value: string): string | null {
  const parsed = Date.parse(String(value ?? ''));

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

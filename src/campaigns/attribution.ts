/**
 * Phase 8 — pure attribution rules (§10).
 *
 * Kept free of I/O so the window boundary, the tie-breaking and the “no fabricated history” rule can
 * be tested directly. Nothing in this file reads a clock: the caller passes `at`, which is what makes
 * the results deterministic.
 */

import {
  AttributionBucket,
  AttributionDecision,
  AttributionModel,
  CampaignTouch,
} from './campaign.types';
import { sortTouches } from './campaign.store';

export interface AttributionQuery {
  /** Conversion (or observation) time the touches are evaluated against. */
  at: Date;
  /** Configured click-to-conversion window (frozen default: 30 days). */
  windowMs: number;
}

/** A touch is *eligible* when it is not in the future and inside the window (§10.4). */
function isEligible(touch: CampaignTouch, query: AttributionQuery): boolean {
  const delta = query.at.getTime() - touch.occurredAt.getTime();

  if (delta < 0) {
    return false;
  }

  return delta <= query.windowMs;
}

/**
 * Why no touch could be credited — the documented taxonomy (§10.7).
 *
 * The order matters: “there was no touch at all” is a different business fact from “there was a
 * touch, but too long ago”, and both differ from “the only touch is *after* the conversion”.
 */
function ineligibleBucket(
  touches: CampaignTouch[],
  query: AttributionQuery,
): {
  bucket: AttributionBucket;
  reason: string;
} {
  if (touches.length === 0) {
    return {
      bucket: 'NO_TOUCH',
      reason: 'هیچ تماس کمپینی برای این کاربر ثبت نشده است (ارگانیک/مستقیم).',
    };
  }

  const earlier = touches.some(
    (touch) => touch.occurredAt.getTime() <= query.at.getTime(),
  );

  if (!earlier) {
    return {
      bucket: 'TOUCH_AFTER_CONVERSION',
      reason:
        'تنها تماس ثبت‌شده بعد از زمان تبدیل رخ داده است؛ نسبت دادن آن به گذشته مجاز نیست.',
    };
  }

  return {
    bucket: 'EXPIRED_WINDOW',
    reason: 'تماس کمپینی قدیمی‌تر از پنجره انتساب است.',
  };
}

/**
 * Decide one model for one conversion.
 *
 *  * `FIRST_TOUCH`  — the earliest *observed* touch. Because it is the earliest row in the document it
 *    can never change once a later touch arrives, so a first-touch attribution is never rewritten.
 *  * `LAST_TOUCH`   — the most recent eligible touch before the conversion. Ties are broken by
 *    ingestion time and then by event id, so the outcome does not depend on Map/array order.
 */
export function decideAttribution(
  model: AttributionModel,
  touches: CampaignTouch[],
  query: AttributionQuery,
): AttributionDecision {
  if (touches.length === 0) {
    const { bucket, reason } = ineligibleBucket(touches, query);

    return { model, campaignId: null, bucket, touch: null, reason };
  }

  const ordered = sortTouches(touches);
  const eligible = ordered.filter((touch) => isEligible(touch, query));

  if (eligible.length === 0) {
    const { bucket, reason } = ineligibleBucket(ordered, query);

    return { model, campaignId: null, bucket, touch: null, reason };
  }

  const chosen =
    model === 'FIRST_TOUCH' ? eligible[0] : eligible[eligible.length - 1];

  return {
    model,
    campaignId: chosen.campaignId,
    bucket: 'CAMPAIGN',
    touch: chosen,
    reason:
      model === 'FIRST_TOUCH'
        ? 'اولین تماس مشاهده‌شده در پنجره انتساب.'
        : 'آخرین تماس واجد شرایط قبل از تبدیل.',
  };
}

/** Both models for one conversion, in a fixed order (first-touch, then last-touch). */
export function decideBothModels(
  touches: CampaignTouch[],
  query: AttributionQuery,
): AttributionDecision[] {
  return (['FIRST_TOUCH', 'LAST_TOUCH'] as AttributionModel[]).map((model) =>
    decideAttribution(model, touches, query),
  );
}

/**
 * The campaign a conversion is *credited* to.
 *
 * Last-touch is the default for reporting (§10.4) and is deliberately returned together with the
 * model name, so no caller can print a credited campaign without saying which model produced it.
 * A conversion whose only touches are ineligible stays uncredited — with its bucket preserved.
 */
export function creditedCampaign(
  decisions: AttributionDecision[],
): AttributionDecision {
  const last = decisions.find((decision) => decision.model === 'LAST_TOUCH');

  if (last && last.campaignId) {
    return last;
  }

  const first = decisions.find((decision) => decision.model === 'FIRST_TOUCH');

  if (first && first.campaignId) {
    return {
      ...first,
      reason: `${first.reason} (فقط مدل اولین تماس واجد شرایط بود.)`,
    };
  }

  if (last) {
    return last;
  }

  if (first) {
    return first;
  }

  // Unreachable through `decideBothModels`, but the function stays total: a caller that passed an
  // empty list gets an explicit “nothing was credited” answer instead of an undefined.
  return {
    model: 'LAST_TOUCH',
    campaignId: null,
    bucket: 'NO_TOUCH',
    touch: null,
    reason: 'هیچ مدل انتسابی ارزیابی نشد.',
  };
}

/** Evidence string recorded next to a conversion (`LAST_TOUCH:cmp_3@2026-10-01T10:00:00.000Z`). */
export function evidenceOf(decision: AttributionDecision): string | null {
  if (!decision.campaignId || !decision.touch) {
    return null;
  }

  return `${decision.model}:${decision.campaignId}@${decision.touch.occurredAt.toISOString()}`;
}

import { randomBytes } from 'node:crypto';

/**
 * Phase 8 — tracking tokens and start payloads (§7.1/§7.5).
 *
 * One place decides what a campaign token and a campaign start payload look like, so the bot parser
 * and the link builder can never drift apart. Tokens are opaque and random (never derived from the
 * campaign name, the operator or a counter): a guessable token would let anybody register clicks for
 * somebody else's campaign.
 */

const TOKEN_BODY_LENGTH = 12;
/** `cmp` + 12 random characters. */
export const CAMPAIGN_TOKEN_PATTERN = /^cmp[a-z0-9]{12,20}$/;
/** The payload the platforms hand back: `/start c_<token>` (Bale sends it as a message text). */
export const CAMPAIGN_PAYLOAD_PREFIX = 'c_';
export const CAMPAIGN_PAYLOAD_PATTERN = /^c_cmp[a-z0-9]{12,20}$/;

/** Collision-checked by the store; the retry loop lives in `CampaignService.createCampaign`. */
export function generateTrackingToken(): string {
  return `cmp${randomBytes(TOKEN_BODY_LENGTH / 2)
    .toString('hex')
    .slice(0, TOKEN_BODY_LENGTH)}`;
}

export function isTrackingToken(value: unknown): value is string {
  return typeof value === 'string' && CAMPAIGN_TOKEN_PATTERN.test(value);
}

/** `cmp…` → `c_cmp…`: the payload that travels inside a platform deep link. */
export function payloadForToken(token: string): string {
  return `${CAMPAIGN_PAYLOAD_PREFIX}${token}`;
}

/**
 * Extract the tracking token from a `/start` payload.
 *
 * Returns `null` for every other payload (`prices`, `ref_ab12`, …) — a campaign reference is only
 * recognized when it is well formed, so a typo cannot silently create a phantom campaign.
 */
export function tokenFromPayload(payload: string): string | null {
  const normalized = payload.trim().toLowerCase();

  if (!CAMPAIGN_PAYLOAD_PATTERN.test(normalized)) {
    return null;
  }

  const token = normalized.slice(CAMPAIGN_PAYLOAD_PREFIX.length);

  return isTrackingToken(token) ? token : null;
}

/**
 * Payload length guard (§7.5): the platforms accept a bounded start parameter, so a payload that
 * cannot fit is never offered as a link.
 */
export const MAX_START_PAYLOAD_LENGTH = 64;

export function isPayloadWithinPlatformLimit(payload: string): boolean {
  return payload.length > 0 && payload.length <= MAX_START_PAYLOAD_LENGTH;
}

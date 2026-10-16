/**
 * Phase 6 — deep-link route registry (§6).
 *
 * One logical contract shared by both platforms: Bale and Telegram deliver the same
 * `/start <payload>` message (Bale documents `ble.ir/<bot_username>?start=<parameter>` and sends the
 * payload as `/start <parameter>`; Telegram uses `t.me/<bot_username>?start=<payload>`), so the bot
 * only ever has to understand one small, closed set of payloads.
 *
 * The registry is deliberately *static code*, not persisted state: a route is a capability of the
 * application, not user data (§12).
 */

import { tokenFromPayload } from '../campaigns/campaign-token';
import { referralCodeFromPayload } from '../referrals/referral-code';
import { ScreenKey } from './ux/callback-data';

/** The five approved start routes (§6). */
export type BotRoute = 'alert' | 'prices' | 'coin' | 'gold' | 'channel';

export const BOT_ROUTES: readonly BotRoute[] = [
  'alert',
  'prices',
  'coin',
  'gold',
  'channel',
];

export function isBotRoute(value: unknown): value is BotRoute {
  return (
    typeof value === 'string' &&
    (BOT_ROUTES as readonly string[]).includes(value)
  );
}

/** Longest payload accepted from a platform link (Telegram allows 64; both platforms accept these). */
export const MAX_START_PAYLOAD_LENGTH = 32;

/**
 * Payload prefix of a referral link (Phase 7). `ref_` plus a code stays inside the same syntax and the
 * same length bound as the five routes, so both platforms keep accepting it unchanged.
 */
export const REFERRAL_PAYLOAD_PREFIX = 'ref_';

/**
 * Payload syntax: lowercase letters and digits with optional `_`/`-` separators. The five approved
 * payloads are plain lowercase words; the stricter pattern keeps unknown or hostile input out of the
 * routing decision *before* it is compared against the registry.
 */
const PAYLOAD_PATTERN = /^[a-z0-9_-]{1,32}$/;

export type StartPayload =
  /** `/start` with no argument — the normal entry point. */
  | { kind: 'none' }
  /** `/start <payload>` where the payload maps to an approved route. */
  | { kind: 'route'; route: BotRoute; raw: string }
  /**
   * `/start ref_<code>` — a referral link (Phase 7 §5). The payload only *names* a code: it grants
   * nothing by itself, and the referral is validated, attributed and persisted by the referral
   * service, never by the parser.
   */
  | { kind: 'referral'; code: string; raw: string }
  /**
   * `/start c_cmp…` — a tracked campaign link (Phase 8 §7.5).
   *
   * Like a referral payload it only *names* a campaign token; authorization, accept/refuse and the
   * funnel record are decided by the campaign services, never by the parser.
   */
  | { kind: 'campaign'; token: string; raw: string }
  /** `/start <payload>` with a payload this product does not define. */
  | { kind: 'unknown'; raw: string };

/**
 * Parse the argument of a start command.
 *
 * Rules (§6.2, §6.3):
 *   * only the **first** token after the command is interpreted; further tokens are ignored (they are
 *     never treated as a second route, a symbol or a permission);
 *   * comparison is case-insensitive (a link that upper-cases the payload still works) but the
 *     accepted syntax itself is narrow (`PAYLOAD_PATTERN`);
 *   * anything that fails the syntax, or passes it without being one of the five routes, is `unknown`
 *     — it never falls through into a different feature and never throws.
 */
export function parseStartPayload(
  text: string | null | undefined,
): StartPayload {
  const tokens = (text ?? '').trim().split(/\s+/).filter(Boolean);

  // tokens[0] is the command itself (`/start`, `/start@bot`); the payload is the next token only.
  const raw = tokens.length > 1 ? (tokens[1] ?? '') : '';

  if (raw.length === 0) {
    return { kind: 'none' };
  }

  const normalized = raw.toLowerCase();

  if (
    normalized.length > MAX_START_PAYLOAD_LENGTH ||
    !PAYLOAD_PATTERN.test(normalized)
  ) {
    return { kind: 'unknown', raw };
  }

  if (isBotRoute(normalized)) {
    return { kind: 'route', route: normalized, raw };
  }

  // Phase 7: `ref_<code>` is recognized *after* the five routes, so an existing payload can never be
  // reinterpreted as a referral. A malformed referral payload stays `unknown` (logged, never acted on).
  const referralCode = referralCodeFromPayload(normalized);

  if (referralCode) {
    return { kind: 'referral', code: referralCode, raw };
  }

  // Phase 8: `c_cmp…` is recognized last for the same reason — an existing payload can never be
  // reinterpreted as a campaign. An unknown or malformed token stays `unknown` and is never acted on.
  const campaignToken = tokenFromPayload(normalized);

  if (campaignToken) {
    return { kind: 'campaign', token: campaignToken, raw };
  }

  return { kind: 'unknown', raw };
}

/** Routes that open an existing bot screen. `alert` is executed separately (it starts the wizard). */
const ROUTE_SCREENS: Record<Exclude<BotRoute, 'alert'>, ScreenKey> = {
  prices: 'prices',
  coin: 'coins',
  gold: 'gold',
  channel: 'channel',
};

/** The existing screen a route opens, or `null` for the `alert` route (Phase 3 wizard entry). */
export function screenForRoute(route: BotRoute): ScreenKey | null {
  return route === 'alert' ? null : ROUTE_SCREENS[route];
}

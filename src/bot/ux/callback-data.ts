/**
 * Callback payload contract (the only data a button may carry).
 *
 * Design rules (§39, §40, §41):
 *  - deterministic and versionable: every payload starts with a version tag, so future versions
 *    can be introduced without breaking old buttons,
 *  - short: symbols are validated against the canonical registry, never encoded with details,
 *  - no secrets and no ownership information: a payload can never name a user, so a modified
 *    callback cannot address someone else's data — ownership always comes from the platform
 *    identity resolved server-side.
 */

import { isSafeChannelId } from '../../channel/channel.types';
import { AlertTypeKey, isAlertTypeKey } from './alert-callback.types';

export type { AlertTypeKey } from './alert-callback.types';

export const CALLBACK_VERSION = 'v1';

export type ScreenKey =
  | 'prices'
  | 'gold'
  | 'coins'
  | 'market'
  // Phase 4 — Market Intelligence screens, all children of the `market` hub.
  | 'report'
  | 'report-full'
  | 'movement'
  | 'last-update'
  | 'favorites'
  | 'alerts'
  | 'channel'
  // Phase 7 — growth engine (referral screen). Child of the main menu, like the other hubs.
  | 'referral';

export const SCREEN_KEYS: readonly ScreenKey[] = [
  'prices',
  'gold',
  'coins',
  'market',
  'report',
  'report-full',
  'movement',
  'last-update',
  'favorites',
  'alerts',
  'channel',
  'referral',
];

/** Alert actions exposed by buttons (Phase 3 §23–§40). */
export type AlertCallbackAction =
  | { kind: 'alert-new' }
  | { kind: 'alert-list' }
  | { kind: 'alert-symbol'; symbol: string }
  | { kind: 'alert-type'; type: AlertTypeKey }
  | { kind: 'alert-confirm' }
  | { kind: 'alert-cancel' }
  | { kind: 'alert-view'; alertId: string }
  | { kind: 'alert-enable'; alertId: string }
  | { kind: 'alert-disable'; alertId: string }
  | { kind: 'alert-edit'; alertId: string }
  | { kind: 'alert-delete'; alertId: string }
  | { kind: 'alert-delete-confirm'; alertId: string };

/**
 * Phase 5 — content management actions.
 *
 * They are *not* protected by the callback payload: the payload only carries an internal content id,
 * and authorisation is resolved server-side from the platform identity against
 * `CHANNEL_ADMIN_USER_IDS` (§22). A forwarded or modified button therefore cannot grant access.
 */
export type ContentCallbackAction =
  | { kind: 'content-list' }
  | { kind: 'content-view'; contentId: string }
  | { kind: 'content-approve'; contentId: string }
  | { kind: 'content-cancel'; contentId: string }
  | { kind: 'content-publish'; contentId: string };

/**
 * Phase 8 — campaign dashboard actions.
 *
 * As with the content surface, the payload carries an internal id only: authorization is resolved
 * server-side from the platform identity against the admin allow-list (`CHANNEL_ADMIN_USER_IDS`), so a
 * modified or forwarded button can never grant access, change a cost or inject a conversion.
 */
export type CampaignCallbackAction =
  | { kind: 'campaign-list'; page: number }
  | { kind: 'campaign-view'; campaignId: string }
  | { kind: 'campaign-stats'; campaignId: string }
  | { kind: 'campaign-links'; campaignId: string }
  | { kind: 'campaign-activate'; campaignId: string }
  | { kind: 'campaign-pause'; campaignId: string }
  | { kind: 'campaign-end'; campaignId: string };

export type CallbackAction =
  | { kind: 'menu' }
  | { kind: 'home' }
  | { kind: 'back' }
  | { kind: 'noop' }
  | { kind: 'screen'; screen: ScreenKey }
  | { kind: 'manage-favorites' }
  | { kind: 'favorite'; op: 'add' | 'remove'; symbol: string }
  | AlertCallbackAction
  | ContentCallbackAction
  | CampaignCallbackAction;

/** Symbols are uppercase registry ids; anything else is rejected before touching the store. */
const SYMBOL_PATTERN = /^[A-Z0-9_]{1,32}$/;

export function callbackDataForMenu(): string {
  return `${CALLBACK_VERSION}:menu`;
}

export function callbackDataForHome(): string {
  return `${CALLBACK_VERSION}:home`;
}

export function callbackDataForBack(): string {
  return `${CALLBACK_VERSION}:back`;
}

export function callbackDataForNoop(): string {
  return `${CALLBACK_VERSION}:noop`;
}

export function callbackDataForScreen(screen: ScreenKey): string {
  return `${CALLBACK_VERSION}:screen:${screen}`;
}

export function callbackDataForManageFavorites(): string {
  return `${CALLBACK_VERSION}:fav:manage`;
}

export function callbackDataForFavorite(
  op: 'add' | 'remove',
  symbol: string,
): string {
  return `${CALLBACK_VERSION}:fav:${op}:${symbol}`;
}

export function callbackDataForAlertNew(): string {
  return `${CALLBACK_VERSION}:alert:new`;
}

export function callbackDataForAlertList(): string {
  return `${CALLBACK_VERSION}:alert:list`;
}

export function callbackDataForAlertSymbol(symbol: string): string {
  return `${CALLBACK_VERSION}:alert:sym:${symbol}`;
}

export function callbackDataForAlertType(type: AlertTypeKey): string {
  return `${CALLBACK_VERSION}:alert:type:${type}`;
}

export function callbackDataForAlertConfirm(): string {
  return `${CALLBACK_VERSION}:alert:confirm`;
}

export function callbackDataForAlertCancel(): string {
  return `${CALLBACK_VERSION}:alert:cancel`;
}

export function callbackDataForAlertView(alertId: string): string {
  return `${CALLBACK_VERSION}:alert:view:${alertId}`;
}

export function callbackDataForAlertStatus(
  op: 'enable' | 'disable',
  alertId: string,
): string {
  return `${CALLBACK_VERSION}:alert:${op}:${alertId}`;
}

export function callbackDataForAlertEdit(alertId: string): string {
  return `${CALLBACK_VERSION}:alert:edit:${alertId}`;
}

export function callbackDataForAlertDelete(alertId: string): string {
  return `${CALLBACK_VERSION}:alert:del:${alertId}`;
}

export function callbackDataForAlertDeleteConfirm(alertId: string): string {
  return `${CALLBACK_VERSION}:alert:delok:${alertId}`;
}

export function callbackDataForContentList(): string {
  return `${CALLBACK_VERSION}:c:list`;
}

export function callbackDataForContentView(contentId: string): string {
  return `${CALLBACK_VERSION}:c:view:${contentId}`;
}

export function callbackDataForContentAction(
  op: 'apr' | 'can' | 'pub',
  contentId: string,
): string {
  return `${CALLBACK_VERSION}:c:${op}:${contentId}`;
}

export function callbackDataForCampaignList(page: number): string {
  return `${CALLBACK_VERSION}:camp:list:${Math.max(1, Math.floor(page))}`;
}

export function callbackDataForCampaignView(campaignId: string): string {
  return `${CALLBACK_VERSION}:camp:view:${campaignId}`;
}

export function callbackDataForCampaignStats(campaignId: string): string {
  return `${CALLBACK_VERSION}:camp:stats:${campaignId}`;
}

export function callbackDataForCampaignLinks(campaignId: string): string {
  return `${CALLBACK_VERSION}:camp:links:${campaignId}`;
}

export function callbackDataForCampaignStatus(
  campaignId: string,
  op: 'act' | 'pause' | 'end',
): string {
  return `${CALLBACK_VERSION}:camp:${op}:${campaignId}`;
}

/** Campaign ids are generated internally (`cmp_<n>`); this is the shape a callback may carry. */
export function isSafeCampaignId(value: string): boolean {
  return /^cmp_\d{1,10}$/.test(value);
}

const CAMPAIGN_ACTION_KINDS: readonly CampaignCallbackAction['kind'][] = [
  'campaign-list',
  'campaign-view',
  'campaign-stats',
  'campaign-links',
  'campaign-activate',
  'campaign-pause',
  'campaign-end',
];

/** Narrow a parsed callback to a campaign action (used by the router's dispatch). */
export function isCampaignAction(
  action: CallbackAction,
): action is CampaignCallbackAction {
  return (CAMPAIGN_ACTION_KINDS as readonly string[]).includes(action.kind);
}

/** Content ids are generated internally (`cnt_…`); this is the shape a callback may carry. */
export function isSafeContentId(value: string): boolean {
  return isSafeChannelId(value);
}

const CONTENT_ACTION_KINDS: readonly ContentCallbackAction['kind'][] = [
  'content-list',
  'content-view',
  'content-approve',
  'content-cancel',
  'content-publish',
];

/** Narrow a parsed callback to a content-management action (used by the router's dispatch). */
export function isContentAction(
  action: CallbackAction,
): action is ContentCallbackAction {
  return (CONTENT_ACTION_KINDS as readonly string[]).includes(action.kind);
}

/** Alert ids are generated internally; this is the shape a callback may carry. */
const ALERT_ID_PATTERN = /^alr_[a-z0-9_]{1,40}$/;

export function isSafeAlertId(value: string): boolean {
  return ALERT_ID_PATTERN.test(value);
}

const ALERT_ACTION_KINDS: readonly AlertCallbackAction['kind'][] = [
  'alert-new',
  'alert-list',
  'alert-symbol',
  'alert-type',
  'alert-confirm',
  'alert-cancel',
  'alert-view',
  'alert-enable',
  'alert-disable',
  'alert-edit',
  'alert-delete',
  'alert-delete-confirm',
];

/** Narrow a parsed callback to an alert action (used by the router's dispatch). */
export function isAlertAction(
  action: CallbackAction,
): action is AlertCallbackAction {
  return (ALERT_ACTION_KINDS as readonly string[]).includes(action.kind);
}

export function isScreenKey(value: string): value is ScreenKey {
  return (SCREEN_KEYS as readonly string[]).includes(value);
}

export function isSafeSymbol(value: string): boolean {
  return SYMBOL_PATTERN.test(value);
}

/**
 * Parse a callback payload. Returns `null` for anything unknown, malformed or from another
 * version — the caller answers with a safe "this option is no longer valid" screen instead of
 * crashing (§40).
 */
/**
 * Content-management actions. The payload carries an internal id only; the id shape is validated
 * here so a malformed button can never reach the store.
 */
function parseContentAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  if (head === 'list') {
    return rest.length === 0 ? { kind: 'content-list' } : null;
  }

  const [contentId, ...extra] = rest;

  if (
    extra.length > 0 ||
    contentId === undefined ||
    !isSafeContentId(contentId)
  ) {
    return null;
  }

  switch (head) {
    case 'view':
      return { kind: 'content-view', contentId };
    case 'apr':
      return { kind: 'content-approve', contentId };
    case 'can':
      return { kind: 'content-cancel', contentId };
    case 'pub':
      return { kind: 'content-publish', contentId };
    default:
      return null;
  }
}

/**
 * Campaign-dashboard actions. The payload is validated here (page number and id shape) before it can
 * reach the domain layer; ownership and authorization are still resolved server-side.
 */
function parseCampaignAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  if (head === 'list') {
    const [page, ...extra] = rest;
    const parsed = Number(page);

    return extra.length === 0 && Number.isInteger(parsed) && parsed >= 1
      ? { kind: 'campaign-list', page: parsed }
      : null;
  }

  const [campaignId, ...extra] = rest;

  if (
    extra.length > 0 ||
    campaignId === undefined ||
    !isSafeCampaignId(campaignId)
  ) {
    return null;
  }

  switch (head) {
    case 'view':
      return { kind: 'campaign-view', campaignId };
    case 'stats':
      return { kind: 'campaign-stats', campaignId };
    case 'links':
      return { kind: 'campaign-links', campaignId };
    case 'act':
      return { kind: 'campaign-activate', campaignId };
    case 'pause':
      return { kind: 'campaign-pause', campaignId };
    case 'end':
      return { kind: 'campaign-end', campaignId };
    default:
      return null;
  }
}

/**
 * Alert actions. Every payload is validated here (shape + symbol/id format) before it can reach
 * the domain layer: a modified button can never address another user's alert, because ownership
 * is resolved server-side from the platform identity (§68).
 */
function parseAlertAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  switch (head) {
    case 'new':
      return rest.length === 0 ? { kind: 'alert-new' } : null;
    case 'list':
      return rest.length === 0 ? { kind: 'alert-list' } : null;
    case 'confirm':
      return rest.length === 0 ? { kind: 'alert-confirm' } : null;
    case 'cancel':
      return rest.length === 0 ? { kind: 'alert-cancel' } : null;
    case 'sym': {
      const [symbol, ...extra] = rest;

      return extra.length === 0 && symbol !== undefined && isSafeSymbol(symbol)
        ? { kind: 'alert-symbol', symbol }
        : null;
    }
    case 'type': {
      const [type, ...extra] = rest;

      return extra.length === 0 && type !== undefined && isAlertTypeKey(type)
        ? { kind: 'alert-type', type }
        : null;
    }
    case 'view':
    case 'edit':
    case 'del':
    case 'delok':
    case 'enable':
    case 'disable': {
      const [alertId, ...extra] = rest;

      if (
        extra.length > 0 ||
        alertId === undefined ||
        !isSafeAlertId(alertId)
      ) {
        return null;
      }

      switch (head) {
        case 'view':
          return { kind: 'alert-view', alertId };
        case 'edit':
          return { kind: 'alert-edit', alertId };
        case 'del':
          return { kind: 'alert-delete', alertId };
        case 'delok':
          return { kind: 'alert-delete-confirm', alertId };
        case 'enable':
          return { kind: 'alert-enable', alertId };
        default:
          return { kind: 'alert-disable', alertId };
      }
    }
    default:
      return null;
  }
}

export function parseCallbackData(
  data: string | null | undefined,
): CallbackAction | null {
  if (typeof data !== 'string') {
    return null;
  }

  const parts = data.split(':');
  const [version, ...rest] = parts;

  if (version !== CALLBACK_VERSION || rest.length === 0) {
    return null;
  }

  const [head, ...tail] = rest;

  switch (head) {
    case 'menu':
      return tail.length === 0 ? { kind: 'menu' } : null;
    case 'home':
      return tail.length === 0 ? { kind: 'home' } : null;
    case 'back':
      return tail.length === 0 ? { kind: 'back' } : null;
    case 'noop':
      return tail.length === 0 ? { kind: 'noop' } : null;
    case 'screen': {
      const [key, ...extra] = tail;

      return extra.length === 0 && key !== undefined && isScreenKey(key)
        ? { kind: 'screen', screen: key }
        : null;
    }
    case 'alert': {
      return parseAlertAction(tail);
    }
    case 'c': {
      return parseContentAction(tail);
    }
    case 'camp': {
      return parseCampaignAction(tail);
    }
    case 'fav': {
      const [op, ...extra] = tail;

      if (op === 'manage' && extra.length === 0) {
        return { kind: 'manage-favorites' };
      }

      if (op !== 'add' && op !== 'remove') {
        return null;
      }

      const [symbol, ...symbolExtra] = extra;

      return symbolExtra.length === 0 &&
        symbol !== undefined &&
        isSafeSymbol(symbol)
        ? { kind: 'favorite', op, symbol }
        : null;
    }
    default:
      return null;
  }
}

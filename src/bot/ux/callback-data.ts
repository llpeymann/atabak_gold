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
import {
  isLossReason,
  isProductCategory,
  LeadStatus,
  LossReason,
  ProductCategory,
} from '../../sales/sales.types';
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
  | 'referral'
  // Phase 9 — sales engine: the customer's purchase/quotation entry point.
  | 'sales';

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
  'sales',
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

/**
 * Phase 9 — sales engine actions.
 *
 * Two families share one versioned namespace:
 *
 *  * customer actions (`sales:*`) carry a stable category id or nothing at all. Ownership is never
 *    part of a payload: the request is always attached to the identity resolved server-side;
 *  * admin actions (`salesadm:*`) carry an internal lead id (`lead_<n>`) or a status/reason token.
 *    The payload never carries a role, and every press re-checks the admin allow-list server-side, so
 *    a forwarded button cannot authorize anything.
 */
export type SalesCallbackAction =
  | { kind: 'sales-hub' }
  | { kind: 'sales-category'; category: ProductCategory }
  | { kind: 'sales-skip-description' }
  | { kind: 'sales-confirm' }
  | { kind: 'sales-edit' }
  | { kind: 'sales-cancel' }
  | { kind: 'sales-track' }
  | { kind: 'sales-list'; page: number }
  | { kind: 'sales-lead-view'; leadId: string }
  | { kind: 'sales-lead-status'; leadId: string; status: LeadStatus }
  | { kind: 'sales-lead-lost'; leadId: string; reason: LossReason }
  | { kind: 'sales-lead-loss-menu'; leadId: string }
  | { kind: 'sales-lead-convert'; leadId: string }
  | { kind: 'sales-lead-convert-confirm'; leadId: string }
  | { kind: 'sales-lead-sale'; leadId: string }
  | { kind: 'sales-lead-sale-note'; leadId: string }
  | { kind: 'sales-lead-contact'; leadId: string }
  | { kind: 'sales-lead-note'; leadId: string }
  | { kind: 'sales-lead-assign'; leadId: string }
  | { kind: 'sales-lead-assign-to'; leadId: string; index: number }
  | { kind: 'sales-lead-history'; leadId: string };

/**
 * Phase 10 — administrative actions.
 *
 * Same security contract as every other namespace: the payload carries only an opaque internal
 * reference (`usr_12`, `inc_3`, `bc_2`, `BC-0003`, an alert id or a lead id) or a closed token. It
 * never carries a role, an allow-list entry, a chat id or a phone number, and every press is
 * re-authorized server-side against the platform identity of the sender — so a forwarded or forged
 * button can only ever ask for something, never authorize it (§12.1, §12.3).
 */
export type AdminCallbackAction =
  | { kind: 'admin-hub' }
  | {
      kind: 'admin-stats';
      preset: 'today' | '7d' | '30d' | 'all';
      section: number;
    }
  | { kind: 'admin-stats-custom' }
  | { kind: 'admin-dict' }
  | { kind: 'admin-users'; filter: AdminUserFilterToken; page: number }
  | { kind: 'admin-user'; userId: string }
  | { kind: 'admin-user-search' }
  | { kind: 'admin-channels' }
  | { kind: 'admin-publishing'; op: 'enable' | 'disable'; confirmed: boolean }
  | { kind: 'admin-test-message'; destination: number; confirmed: boolean }
  | { kind: 'admin-channel-history' }
  | { kind: 'admin-alerts'; filter: AdminAlertFilterToken; page: number }
  | { kind: 'admin-alert'; alertId: string }
  | {
      kind: 'admin-alert-state';
      alertId: string;
      op: 'disable' | 'enable';
      confirmed: boolean;
    }
  | { kind: 'admin-leads'; filter: AdminLeadFilterToken; page: number }
  | { kind: 'admin-campaigns'; page: number }
  | { kind: 'admin-campaign-funnel'; campaignId: string }
  | { kind: 'admin-errors'; filter: AdminIncidentFilterToken; page: number }
  | { kind: 'admin-error'; incidentId: string }
  | {
      kind: 'admin-error-act';
      incidentId: string;
      op: 'review' | 'resolve' | 'reopen';
    }
  | { kind: 'admin-error-retry'; incidentId: string }
  | { kind: 'admin-broadcast' }
  | { kind: 'admin-broadcast-list' }
  | {
      kind: 'admin-broadcast-audience';
      audience: AdminAudienceToken;
      days: number | null;
    }
  | { kind: 'admin-broadcast-text' }
  | { kind: 'admin-broadcast-preview' }
  | { kind: 'admin-broadcast-save' }
  | { kind: 'admin-broadcast-start'; reference: string }
  | { kind: 'admin-broadcast-cancel'; reference: string }
  | { kind: 'admin-broadcast-retry'; reference: string }
  | { kind: 'admin-broadcast-report'; reference: string }
  | { kind: 'admin-audit'; page: number };

export type AdminUserFilterToken =
  'all' | 'bale' | 'telegram' | 'new' | 'inactive';

export type AdminAlertFilterToken =
  'all' | 'active' | 'disabled' | 'triggered' | 'bale' | 'telegram';

export type AdminLeadFilterToken =
  'all' | 'open' | 'converted' | 'lost' | 'today';

export type AdminIncidentFilterToken =
  'open' | 'reviewed' | 'resolved' | 'all' | 'retryable' | 'retryable-open';

export type AdminAudienceToken =
  'all' | 'bale' | 'telegram' | 'active' | 'inactive';

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
  | CampaignCallbackAction
  | SalesCallbackAction
  | AdminCallbackAction;

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

export function callbackDataForSalesHub(): string {
  return `${CALLBACK_VERSION}:sales:hub`;
}

export function callbackDataForSalesCategory(
  category: ProductCategory,
): string {
  return `${CALLBACK_VERSION}:sales:cat:${category}`;
}

export function callbackDataForSalesSkipDescription(): string {
  return `${CALLBACK_VERSION}:sales:skip`;
}

export function callbackDataForSalesConfirm(): string {
  return `${CALLBACK_VERSION}:sales:confirm`;
}

export function callbackDataForSalesEdit(): string {
  return `${CALLBACK_VERSION}:sales:edit`;
}

export function callbackDataForSalesCancel(): string {
  return `${CALLBACK_VERSION}:sales:cancel`;
}

export function callbackDataForSalesTrack(): string {
  return `${CALLBACK_VERSION}:sales:track`;
}

export function callbackDataForSalesList(page: number): string {
  return `${CALLBACK_VERSION}:salesadm:list:${Math.max(1, Math.floor(page))}`;
}

export function callbackDataForSalesLeadView(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:view:${leadId}`;
}

/**
 * Status/reason buttons carry the *target* token only: the domain layer decides whether the
 * transition is allowed, and a role is never part of the payload.
 */
export function callbackDataForSalesLeadStatus(
  leadId: string,
  status: LeadStatus,
): string {
  return `${CALLBACK_VERSION}:salesadm:st:${leadId}:${status}`;
}

/** Opens the loss-reason list; recording a loss always requires a chosen reason (§10.1). */
export function callbackDataForSalesLeadLossMenu(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:loss:${leadId}`;
}

export function callbackDataForSalesLeadLost(
  leadId: string,
  reason: LossReason,
): string {
  return `${CALLBACK_VERSION}:salesadm:lost:${leadId}:${reason}`;
}

export function callbackDataForSalesLeadConvert(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:conv:${leadId}`;
}

export function callbackDataForSalesLeadConvertConfirm(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:convyes:${leadId}`;
}

export function callbackDataForSalesLeadSale(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:sale:${leadId}`;
}

export function callbackDataForSalesLeadSaleNote(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:salen:${leadId}`;
}

export function callbackDataForSalesLeadContact(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:contact:${leadId}`;
}

export function callbackDataForSalesLeadNote(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:note:${leadId}`;
}

export function callbackDataForSalesLeadAssign(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:assign:${leadId}`;
}

export function callbackDataForSalesLeadAssignTo(
  leadId: string,
  index: number,
): string {
  return `${CALLBACK_VERSION}:salesadm:asto:${leadId}:${Math.max(0, Math.floor(index))}`;
}

export function callbackDataForSalesLeadHistory(leadId: string): string {
  return `${CALLBACK_VERSION}:salesadm:hist:${leadId}`;
}

/** Campaign ids are generated internally (`cmp_<n>`); this is the shape a callback may carry. */
// --- Phase 10: admin namespace (`v1:admin:*`) -----------------------------------

const ADMIN_USER_FILTERS: readonly AdminUserFilterToken[] = [
  'all',
  'bale',
  'telegram',
  'new',
  'inactive',
];
const ADMIN_ALERT_FILTERS: readonly AdminAlertFilterToken[] = [
  'all',
  'active',
  'disabled',
  'triggered',
  'bale',
  'telegram',
];
const ADMIN_LEAD_FILTERS: readonly AdminLeadFilterToken[] = [
  'all',
  'open',
  'converted',
  'lost',
  'today',
];
const ADMIN_INCIDENT_FILTERS: readonly AdminIncidentFilterToken[] = [
  'open',
  'reviewed',
  'resolved',
  'all',
  'retryable',
  'retryable-open',
];
const ADMIN_AUDIENCES: readonly AdminAudienceToken[] = [
  'all',
  'bale',
  'telegram',
  'active',
  'inactive',
];
const ADMIN_PERIODS: readonly ('today' | '7d' | '30d' | 'all')[] = [
  'today',
  '7d',
  '30d',
  'all',
];

/** Internal ids produced by the project's own stores (`usr_12`, `inc_3`, `bc_2`, …). */
const INTERNAL_ID_PATTERN = /^[a-z]{2,6}_[0-9]{1,12}$/u;
/** Broadcast reference shown to the operator (`BC-0003`). */
const BROADCAST_REFERENCE_PATTERN = /^BC-[0-9]{1,8}$/u;

export function isSafeInternalId(value: string): boolean {
  return INTERNAL_ID_PATTERN.test(value);
}

export function isSafeBroadcastReference(value: string): boolean {
  return BROADCAST_REFERENCE_PATTERN.test(value);
}

export function callbackDataForAdminHub(): string {
  return `${CALLBACK_VERSION}:admin:hub`;
}

export function callbackDataForAdminStats(
  preset: 'today' | '7d' | '30d' | 'all',
  section = 0,
): string {
  return `${CALLBACK_VERSION}:admin:stats:${preset}:${section}`;
}

export function callbackDataForAdminStatsCustom(): string {
  return `${CALLBACK_VERSION}:admin:stats:custom`;
}

export function callbackDataForAdminDictionary(): string {
  return `${CALLBACK_VERSION}:admin:dict`;
}

export function callbackDataForAdminUsers(
  filter: AdminUserFilterToken,
  page: number,
): string {
  return `${CALLBACK_VERSION}:admin:users:${filter}:${page}`;
}

export function callbackDataForAdminUser(userId: string): string {
  return `${CALLBACK_VERSION}:admin:user:${userId}`;
}

export function callbackDataForAdminUserSearch(): string {
  return `${CALLBACK_VERSION}:admin:usearch`;
}

export function callbackDataForAdminChannels(): string {
  return `${CALLBACK_VERSION}:admin:channels`;
}

export function callbackDataForAdminPublishing(
  op: 'enable' | 'disable',
  confirmed = false,
): string {
  return `${CALLBACK_VERSION}:admin:pub:${op}${confirmed ? ':yes' : ''}`;
}

export function callbackDataForAdminTestMessage(
  destination: number,
  confirmed = false,
): string {
  return `${CALLBACK_VERSION}:admin:test:${destination}${
    confirmed ? ':yes' : ''
  }`;
}

export function callbackDataForAdminChannelHistory(): string {
  return `${CALLBACK_VERSION}:admin:pubhist`;
}

export function callbackDataForAdminAlerts(
  filter: AdminAlertFilterToken,
  page: number,
): string {
  return `${CALLBACK_VERSION}:admin:alerts:${filter}:${page}`;
}

export function callbackDataForAdminAlert(alertId: string): string {
  return `${CALLBACK_VERSION}:admin:alert:${alertId}`;
}

export function callbackDataForAdminAlertState(
  alertId: string,
  op: 'disable' | 'enable',
  confirmed = false,
): string {
  return `${CALLBACK_VERSION}:admin:alertset:${alertId}:${op}${
    confirmed ? ':yes' : ''
  }`;
}

export function callbackDataForAdminLeads(
  filter: AdminLeadFilterToken,
  page: number,
): string {
  return `${CALLBACK_VERSION}:admin:leads:${filter}:${page}`;
}

export function callbackDataForAdminCampaigns(page: number): string {
  return `${CALLBACK_VERSION}:admin:campaigns:${page}`;
}

export function callbackDataForAdminCampaignFunnel(campaignId: string): string {
  return `${CALLBACK_VERSION}:admin:cfunnel:${campaignId}`;
}

export function callbackDataForAdminErrors(
  filter: AdminIncidentFilterToken,
  page: number,
): string {
  return `${CALLBACK_VERSION}:admin:errors:${filter}:${page}`;
}

export function callbackDataForAdminError(incidentId: string): string {
  return `${CALLBACK_VERSION}:admin:error:${incidentId}`;
}

export function callbackDataForAdminErrorAct(
  incidentId: string,
  op: 'review' | 'resolve' | 'reopen',
): string {
  return `${CALLBACK_VERSION}:admin:erract:${incidentId}:${op}`;
}

export function callbackDataForAdminErrorRetry(incidentId: string): string {
  return `${CALLBACK_VERSION}:admin:errretry:${incidentId}`;
}

export function callbackDataForAdminBroadcast(): string {
  return `${CALLBACK_VERSION}:admin:broadcast`;
}

export function callbackDataForAdminBroadcastList(): string {
  return `${CALLBACK_VERSION}:admin:bclist`;
}

export function callbackDataForAdminBroadcastAudience(
  audience: AdminAudienceToken,
  days: number | null = null,
): string {
  return `${CALLBACK_VERSION}:admin:bcaud:${audience}${
    days === null ? '' : `:${days}`
  }`;
}

export function callbackDataForAdminBroadcastText(): string {
  return `${CALLBACK_VERSION}:admin:bctext`;
}

export function callbackDataForAdminBroadcastPreview(): string {
  return `${CALLBACK_VERSION}:admin:bcprev`;
}

export function callbackDataForAdminBroadcastSave(): string {
  return `${CALLBACK_VERSION}:admin:bcsave`;
}

export function callbackDataForAdminBroadcastStart(reference: string): string {
  return `${CALLBACK_VERSION}:admin:bcgo:${reference}`;
}

export function callbackDataForAdminBroadcastCancel(reference: string): string {
  return `${CALLBACK_VERSION}:admin:bccancel:${reference}`;
}

export function callbackDataForAdminBroadcastRetry(reference: string): string {
  return `${CALLBACK_VERSION}:admin:bcretry:${reference}`;
}

export function callbackDataForAdminBroadcastReport(reference: string): string {
  return `${CALLBACK_VERSION}:admin:bcreport:${reference}`;
}

export function callbackDataForAdminAudit(page: number): string {
  return `${CALLBACK_VERSION}:admin:audit:${page}`;
}

/**
 * Parse an administrative action. Everything is validated here (closed token lists, id formats,
 * bounded page numbers) *before* it can reach the admin service, exactly like the other namespaces:
 * an out-of-shape payload is simply an expired callback (§12.1).
 */
function parseAdminAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  switch (head) {
    case 'hub':
      return rest.length === 0 ? { kind: 'admin-hub' } : null;
    case 'dict':
      return rest.length === 0 ? { kind: 'admin-dict' } : null;
    case 'stats': {
      const [preset, ...extra] = rest;

      if (preset === 'custom' && extra.length === 0) {
        return { kind: 'admin-stats-custom' };
      }

      const section = extra.length === 0 ? 0 : Number(extra[0]);

      return extra.length <= 1 &&
        preset !== undefined &&
        (ADMIN_PERIODS as readonly string[]).includes(preset) &&
        Number.isInteger(section) &&
        section >= 0 &&
        section <= 9
        ? {
            kind: 'admin-stats',
            preset: preset as 'today' | '7d' | '30d' | 'all',
            section,
          }
        : null;
    }
    case 'users': {
      const [filter, page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 &&
        filter !== undefined &&
        (ADMIN_USER_FILTERS as readonly string[]).includes(filter) &&
        Number.isInteger(parsed) &&
        parsed >= 1
        ? {
            kind: 'admin-users',
            filter: filter as AdminUserFilterToken,
            page: parsed,
          }
        : null;
    }
    case 'user': {
      const [userId, ...extra] = rest;

      return extra.length === 0 &&
        userId !== undefined &&
        isSafeInternalId(userId)
        ? { kind: 'admin-user', userId }
        : null;
    }
    case 'usearch':
      return rest.length === 0 ? { kind: 'admin-user-search' } : null;
    case 'channels':
      return rest.length === 0 ? { kind: 'admin-channels' } : null;
    case 'pubhist':
      return rest.length === 0 ? { kind: 'admin-channel-history' } : null;
    case 'pub': {
      const [op, ...extra] = rest;

      if (op !== 'enable' && op !== 'disable') {
        return null;
      }

      const confirmed = extra.length === 1 && extra[0] === 'yes';

      return extra.length <= 1 && (extra.length === 0 || confirmed)
        ? { kind: 'admin-publishing', op, confirmed }
        : null;
    }
    case 'test': {
      const [destination, ...extra] = rest;
      const parsed = Number(destination);

      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 9) {
        return null;
      }

      const confirmed = extra.length === 1 && extra[0] === 'yes';

      return extra.length <= 1 && (extra.length === 0 || confirmed)
        ? { kind: 'admin-test-message', destination: parsed, confirmed }
        : null;
    }
    case 'alerts': {
      const [filter, page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 &&
        filter !== undefined &&
        (ADMIN_ALERT_FILTERS as readonly string[]).includes(filter) &&
        Number.isInteger(parsed) &&
        parsed >= 1
        ? {
            kind: 'admin-alerts',
            filter: filter as AdminAlertFilterToken,
            page: parsed,
          }
        : null;
    }
    case 'alert': {
      const [alertId, ...extra] = rest;

      return extra.length === 0 &&
        alertId !== undefined &&
        isSafeAlertId(alertId)
        ? { kind: 'admin-alert', alertId }
        : null;
    }
    case 'alertset': {
      const [alertId, op, ...extra] = rest;

      if (
        alertId === undefined ||
        !isSafeAlertId(alertId) ||
        (op !== 'disable' && op !== 'enable')
      ) {
        return null;
      }

      const confirmed = extra.length === 1 && extra[0] === 'yes';

      return extra.length <= 1 && (extra.length === 0 || confirmed)
        ? { kind: 'admin-alert-state', alertId, op, confirmed }
        : null;
    }
    case 'leads': {
      const [filter, page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 &&
        filter !== undefined &&
        (ADMIN_LEAD_FILTERS as readonly string[]).includes(filter) &&
        Number.isInteger(parsed) &&
        parsed >= 1
        ? {
            kind: 'admin-leads',
            filter: filter as AdminLeadFilterToken,
            page: parsed,
          }
        : null;
    }
    case 'campaigns': {
      const [page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 && Number.isInteger(parsed) && parsed >= 1
        ? { kind: 'admin-campaigns', page: parsed }
        : null;
    }
    case 'cfunnel': {
      const [campaignId, ...extra] = rest;

      return extra.length === 0 &&
        campaignId !== undefined &&
        isSafeCampaignId(campaignId)
        ? { kind: 'admin-campaign-funnel', campaignId }
        : null;
    }
    case 'errors': {
      const [filter, page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 &&
        filter !== undefined &&
        (ADMIN_INCIDENT_FILTERS as readonly string[]).includes(filter) &&
        Number.isInteger(parsed) &&
        parsed >= 1
        ? {
            kind: 'admin-errors',
            filter: filter as AdminIncidentFilterToken,
            page: parsed,
          }
        : null;
    }
    case 'error': {
      const [incidentId, ...extra] = rest;

      return extra.length === 0 &&
        incidentId !== undefined &&
        isSafeInternalId(incidentId)
        ? { kind: 'admin-error', incidentId }
        : null;
    }
    case 'erract': {
      const [incidentId, op, ...extra] = rest;

      if (
        incidentId === undefined ||
        !isSafeInternalId(incidentId) ||
        (op !== 'review' && op !== 'resolve' && op !== 'reopen')
      ) {
        return null;
      }

      return extra.length === 0
        ? { kind: 'admin-error-act', incidentId, op }
        : null;
    }
    case 'errretry': {
      const [incidentId, ...extra] = rest;

      return extra.length === 0 &&
        incidentId !== undefined &&
        isSafeInternalId(incidentId)
        ? { kind: 'admin-error-retry', incidentId }
        : null;
    }
    case 'broadcast':
      return rest.length === 0 ? { kind: 'admin-broadcast' } : null;
    case 'bclist':
      return rest.length === 0 ? { kind: 'admin-broadcast-list' } : null;
    case 'bcaud': {
      const [audience, days, ...extra] = rest;

      if (
        audience === undefined ||
        !(ADMIN_AUDIENCES as readonly string[]).includes(audience)
      ) {
        return null;
      }

      if (extra.length > 0) {
        return null;
      }

      if (days === undefined) {
        return {
          kind: 'admin-broadcast-audience',
          audience: audience as AdminAudienceToken,
          days: null,
        };
      }

      const parsed = Number(days);

      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365
        ? {
            kind: 'admin-broadcast-audience',
            audience: audience as AdminAudienceToken,
            days: parsed,
          }
        : null;
    }
    case 'bctext':
      return rest.length === 0 ? { kind: 'admin-broadcast-text' } : null;
    case 'bcprev':
      return rest.length === 0 ? { kind: 'admin-broadcast-preview' } : null;
    case 'bcsave':
      return rest.length === 0 ? { kind: 'admin-broadcast-save' } : null;
    case 'bcgo':
    case 'bccancel':
    case 'bcretry':
    case 'bcreport': {
      const [reference, ...extra] = rest;

      if (
        extra.length > 0 ||
        reference === undefined ||
        !isSafeBroadcastReference(reference)
      ) {
        return null;
      }

      switch (head) {
        case 'bcgo':
          return { kind: 'admin-broadcast-start', reference };
        case 'bccancel':
          return { kind: 'admin-broadcast-cancel', reference };
        case 'bcretry':
          return { kind: 'admin-broadcast-retry', reference };
        default:
          return { kind: 'admin-broadcast-report', reference };
      }
    }
    case 'audit': {
      const [page, ...extra] = rest;
      const parsed = Number(page);

      return extra.length === 0 && Number.isInteger(parsed) && parsed >= 1
        ? { kind: 'admin-audit', page: parsed }
        : null;
    }
    default:
      return null;
  }
}

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

/** Lead ids are generated internally (`lead_<n>`); this is the shape a callback may carry. */
export function isSafeLeadId(value: string): boolean {
  return /^lead_\d{1,10}$/.test(value);
}

const SALES_STATUS_TOKENS: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'LOST',
];

function isStatusToken(value: string): value is LeadStatus {
  return (SALES_STATUS_TOKENS as readonly string[]).includes(value);
}

/**
 * Sales actions. Every token is validated here — the category against the product registry, the
 * status against the state machine's vocabulary, the loss reason against the fixed list and the lead
 * id against its generated shape — so nothing malformed can reach the domain layer.
 */
function parseSalesAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  switch (head) {
    case 'hub':
      return rest.length === 0 ? { kind: 'sales-hub' } : null;
    case 'skip':
      return rest.length === 0 ? { kind: 'sales-skip-description' } : null;
    case 'confirm':
      return rest.length === 0 ? { kind: 'sales-confirm' } : null;
    case 'edit':
      return rest.length === 0 ? { kind: 'sales-edit' } : null;
    case 'cancel':
      return rest.length === 0 ? { kind: 'sales-cancel' } : null;
    case 'track':
      return rest.length === 0 ? { kind: 'sales-track' } : null;
    case 'cat': {
      const [category, ...extra] = rest;

      return extra.length === 0 &&
        category !== undefined &&
        isProductCategory(category)
        ? { kind: 'sales-category', category }
        : null;
    }
    default:
      return null;
  }
}

/** Admin (lead management) actions inside the same versioned namespace. */
function parseSalesAdminAction(tail: readonly string[]): CallbackAction | null {
  const [head, ...rest] = tail;

  if (head === 'list') {
    const [page, ...extra] = rest;
    const parsed = Number(page);

    return extra.length === 0 && Number.isInteger(parsed) && parsed >= 1
      ? { kind: 'sales-list', page: parsed }
      : null;
  }

  const [leadId, ...extra] = rest;

  if (leadId === undefined || !isSafeLeadId(leadId)) {
    return null;
  }

  switch (head) {
    case 'view':
      return extra.length === 0 ? { kind: 'sales-lead-view', leadId } : null;
    case 'conv':
      return extra.length === 0 ? { kind: 'sales-lead-convert', leadId } : null;
    case 'convyes':
      return extra.length === 0
        ? { kind: 'sales-lead-convert-confirm', leadId }
        : null;
    case 'sale':
      return extra.length === 0 ? { kind: 'sales-lead-sale', leadId } : null;
    case 'salen':
      return extra.length === 0
        ? { kind: 'sales-lead-sale-note', leadId }
        : null;
    case 'contact':
      return extra.length === 0 ? { kind: 'sales-lead-contact', leadId } : null;
    case 'note':
      return extra.length === 0 ? { kind: 'sales-lead-note', leadId } : null;
    case 'assign':
      return extra.length === 0 ? { kind: 'sales-lead-assign', leadId } : null;
    case 'hist':
      return extra.length === 0 ? { kind: 'sales-lead-history', leadId } : null;
    case 'loss':
      return extra.length === 0
        ? { kind: 'sales-lead-loss-menu', leadId }
        : null;
    case 'st': {
      const [status, ...statusExtra] = extra;

      return statusExtra.length === 0 &&
        status !== undefined &&
        isStatusToken(status)
        ? { kind: 'sales-lead-status', leadId, status }
        : null;
    }
    case 'lost': {
      const [reason, ...reasonExtra] = extra;

      return reasonExtra.length === 0 &&
        reason !== undefined &&
        isLossReason(reason)
        ? { kind: 'sales-lead-lost', leadId, reason }
        : null;
    }
    case 'asto': {
      const [index, ...indexExtra] = extra;
      const parsed = Number(index);

      return indexExtra.length === 0 && Number.isInteger(parsed) && parsed >= 0
        ? { kind: 'sales-lead-assign-to', leadId, index: parsed }
        : null;
    }
    default:
      return null;
  }
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
    case 'sales': {
      return parseSalesAction(tail);
    }
    case 'salesadm': {
      return parseSalesAdminAction(tail);
    }
    case 'admin': {
      return parseAdminAction(tail);
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

const ADMIN_ACTION_KINDS: readonly AdminCallbackAction['kind'][] = [
  'admin-hub',
  'admin-stats',
  'admin-stats-custom',
  'admin-dict',
  'admin-users',
  'admin-user',
  'admin-user-search',
  'admin-channels',
  'admin-publishing',
  'admin-test-message',
  'admin-channel-history',
  'admin-alerts',
  'admin-alert',
  'admin-alert-state',
  'admin-leads',
  'admin-campaigns',
  'admin-campaign-funnel',
  'admin-errors',
  'admin-error',
  'admin-error-act',
  'admin-error-retry',
  'admin-broadcast',
  'admin-broadcast-list',
  'admin-broadcast-audience',
  'admin-broadcast-text',
  'admin-broadcast-preview',
  'admin-broadcast-save',
  'admin-broadcast-start',
  'admin-broadcast-cancel',
  'admin-broadcast-retry',
  'admin-broadcast-report',
  'admin-audit',
];

/** Narrow a parsed callback to an administrative action (used by the router's dispatch). */
export function isAdminAction(
  action: CallbackAction,
): action is AdminCallbackAction {
  return (ADMIN_ACTION_KINDS as readonly string[]).includes(action.kind);
}

const SALES_ACTION_KINDS: readonly SalesCallbackAction['kind'][] = [
  'sales-hub',
  'sales-category',
  'sales-skip-description',
  'sales-confirm',
  'sales-edit',
  'sales-cancel',
  'sales-track',
  'sales-list',
  'sales-lead-view',
  'sales-lead-status',
  'sales-lead-lost',
  'sales-lead-loss-menu',
  'sales-lead-convert',
  'sales-lead-convert-confirm',
  'sales-lead-sale',
  'sales-lead-sale-note',
  'sales-lead-contact',
  'sales-lead-note',
  'sales-lead-assign',
  'sales-lead-assign-to',
  'sales-lead-history',
];

/** Narrow a parsed callback to a sales action (used by the router's dispatch). */
export function isSalesAction(
  action: CallbackAction,
): action is SalesCallbackAction {
  return (SALES_ACTION_KINDS as readonly string[]).includes(action.kind);
}

/** `true` for the lead-management half of the sales namespace (admin surface only). */
export function isSalesAdminAction(action: SalesCallbackAction): boolean {
  return (
    action.kind.startsWith('sales-list') ||
    action.kind.startsWith('sales-lead-')
  );
}

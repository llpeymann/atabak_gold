import { Injectable, Logger } from '@nestjs/common';

import { Platform } from '../../platform/platform.types';

/**
 * Minimal product event log (Phase 2 §48).
 *
 * Deliberately *not* an analytics system: one structured log line per interaction, enough to
 * answer "which screens do users actually open" after Phase 3 arrives. Nothing is persisted and
 * no dashboards/funnels/attribution are built (§2).
 *
 * Logged fields never contain platform profile data: only the internal user id, the platform,
 * the screen and the symbol — never a raw platform user id, never message text.
 */
export type UxEvent =
  | 'start'
  // Phase 6 — deep links: a recognized route, and a payload the product does not define.
  | 'start_route'
  | 'start_unknown_payload'
  | 'menu_open'
  | 'prices_view'
  | 'gold_view'
  | 'coin_view'
  | 'market_view'
  // Phase 4 — market intelligence screens.
  | 'market_report_view'
  | 'market_movement_view'
  | 'market_last_update_view'
  | 'favorites_view'
  | 'favorites_manage_open'
  | 'favorite_added'
  | 'favorite_removed'
  | 'favorite_duplicate'
  | 'favorite_limit_reached'
  | 'favorite_unknown_symbol'
  | 'alerts_clicked'
  | 'alerts_view'
  | 'alert_create_started'
  | 'alert_created'
  | 'alert_updated'
  | 'alert_enabled'
  | 'alert_disabled'
  | 'alert_deleted'
  | 'alert_detail_view'
  | 'alert_create_cancelled'
  | 'alert_limit_reached'
  | 'alert_duplicate'
  | 'alert_invalid_target'
  | 'alert_wizard_input'
  | 'channel_clicked'
  // Phase 7 — growth engine: a referral screen was opened, or a referral payload was handled.
  // Only facts are recorded (never a code, a link or another user's identity).
  | 'referral_open'
  | 'referral_join_recorded'
  | 'referral_join_rejected'
  | 'referral_reward_granted'
  // Phase 8 — campaign tracking: only facts (never a token, a link or a private note). The `screen`
  // field carries a status word (recorded/rejected/attributed/unavailable), never user content.
  | 'start_campaign'
  | 'start_campaign_route'
  | 'campaign_start_recorded'
  | 'campaign_start_rejected'
  | 'campaign_membership_checked'
  | 'campaign_alert_recorded'
  | 'back'
  | 'home'
  | 'invalid_callback'
  | 'update_ignored'
  | 'unknown_command';

export interface UxEventContext {
  platform: Platform;
  /** Internal user id (never the platform user id). */
  userId?: string;
  screen?: string;
  symbol?: string;
}

@Injectable()
export class UxEventLogService {
  private readonly logger = new Logger('BotUx');

  record(event: UxEvent, context: UxEventContext): void {
    const parts = [`event=${event}`, `platform=${context.platform}`];

    if (context.userId) {
      parts.push(`user=${context.userId}`);
    }
    if (context.screen) {
      parts.push(`screen=${context.screen}`);
    }
    if (context.symbol) {
      parts.push(`symbol=${context.symbol}`);
    }

    this.logger.log(parts.join(' '));
  }
}

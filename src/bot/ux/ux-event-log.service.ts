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
  | 'menu_open'
  | 'prices_view'
  | 'gold_view'
  | 'coin_view'
  | 'market_view'
  | 'favorites_view'
  | 'favorites_manage_open'
  | 'favorite_added'
  | 'favorite_removed'
  | 'favorite_duplicate'
  | 'favorite_limit_reached'
  | 'favorite_unknown_symbol'
  | 'alerts_clicked'
  | 'channel_clicked'
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

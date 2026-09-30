import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { BotApiClient } from './bot-api.client';
import { createAdapter, PlatformAdapter } from './platform-adapter';
import { Platform } from './platform.types';

/**
 * Resolves the adapter for a platform.
 *
 * Bale is the primary (always configured) platform. Telegram does **not** require a separate
 * bot token for *inbound* interaction: the bot reaches Telegram users through the same token
 * the channel mirroring already uses, while Bale users keep using the Bale token. Both share
 * the same UX core; only the adapter differs (§10).
 */
@Injectable()
export class PlatformRegistry {
  private readonly logger = new Logger(PlatformRegistry.name);
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  constructor(
    private readonly config: AppConfigService,
    private readonly client: BotApiClient,
  ) {
    this.adapters.set('bale', this.build('bale'));

    if (this.config.telegram) {
      this.adapters.set('telegram', this.build('telegram'));
    } else {
      this.logger.log(
        'Telegram inbound is disabled (TELEGRAM_BOT_TOKEN is not configured) — Bale only.',
      );
    }
  }

  getInboundPlatforms(): Platform[] {
    return [...this.adapters.keys()];
  }

  /** Adapter for a platform, or `null` when only one platform is configured (§47). */
  resolve(platform: Platform): PlatformAdapter | null {
    return this.adapters.get(platform) ?? null;
  }

  /** Adapter used for operational (admin) notifications. */
  primary(): PlatformAdapter {
    const bale = this.adapters.get('bale');

    if (!bale) {
      throw new Error('No platform adapter is configured.');
    }

    return bale;
  }

  private build(platform: Platform): PlatformAdapter {
    return createAdapter(platform, this.client, {
      // Editing keeps the chat clean, but no behaviour depends on it (§9).
      supportsMessageEditing: true,
      supportsCallbackAnswer: true,
      pollTimeoutSeconds: this.config.botPollTimeoutSeconds,
    });
  }
}

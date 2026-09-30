import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import { AppConfigService } from '../config/app-config.service';
import { normalizeHtmlForDelivery } from '../common/html';
import { describeError, redactSecrets, truncate } from '../common/log-safety';
import { DeliveryPlatform, DeliveryResult } from './delivery-result';

interface DeliveryTarget {
  platform: DeliveryPlatform;
  apiBaseUrl: string;
  channelId: string;
}

/**
 * Message delivery to the configured channels.
 *
 * Phase 0 guarantees implemented here:
 *  - a request timeout on every delivery call (no indefinitely hanging cron),
 *  - failures are *returned* as structured results instead of being swallowed: the caller
 *    receives `success: false` plus a sanitized error for the affected platform,
 *  - bot tokens never reach the logs (`redactSecrets`).
 */
@Injectable()
export class BaleService {
  private readonly logger = new Logger(BaleService.name);
  private readonly targets: DeliveryTarget[];

  constructor(
    private readonly httpService: HttpService,
    private readonly config: AppConfigService,
  ) {
    const bale = this.config.bale;
    const targets: DeliveryTarget[] = [
      {
        platform: 'bale',
        apiBaseUrl: `https://tapi.bale.ai/bot${bale.botToken}`,
        channelId: bale.channelId,
      },
    ];

    const telegram = this.config.telegram;
    if (telegram) {
      targets.push({
        platform: 'telegram',
        apiBaseUrl: `https://api.telegram.org/bot${telegram.botToken}`,
        channelId: telegram.channelId,
      });
    } else {
      this.logger.log('Telegram delivery is not configured — Bale only.');
    }

    this.targets = targets;
  }

  get platforms(): DeliveryPlatform[] {
    return this.targets.map((target) => target.platform);
  }

  /**
   * Publish the same text to every enabled platform.
   * Never rejects: a failing platform yields a result with `success: false`.
   */
  async sendMessage(text: string): Promise<DeliveryResult[]> {
    const payloadText = normalizeHtmlForDelivery(text);

    const settled = await Promise.allSettled(
      this.targets.map((target) => this.deliver(target, payloadText)),
    );

    return settled.map((entry, index) => {
      if (entry.status === 'fulfilled') {
        return entry.value;
      }

      // Defensive: `deliver` never rejects, but an unexpected rejection must still be
      // reported as a failure instead of being lost.
      const target = this.targets[index];
      return this.failureResult(target, describeError(entry.reason));
    });
  }

  private async deliver(
    target: DeliveryTarget,
    text: string,
  ): Promise<DeliveryResult> {
    const startedAt = Date.now();

    try {
      await firstValueFrom(
        this.httpService.post(
          `${target.apiBaseUrl}/sendMessage`,
          {
            chat_id: target.channelId,
            text,
            parse_mode: 'HTML',
          },
          { timeout: this.config.deliveryTimeoutMs },
        ),
      );

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `✅ Message delivered to ${target.platform} (channel ${target.channelId}) in ${durationMs}ms`,
      );

      return {
        platform: target.platform,
        channel: target.channelId,
        messageType: 'text',
        timestamp: new Date().toISOString(),
        durationMs,
        success: true,
      };
    } catch (error) {
      const description = this.describeDeliveryError(error);
      this.logger.error(
        `❌ Message delivery failed on ${target.platform} (channel ${target.channelId}): ${description}`,
      );

      return this.failureResult(target, description, startedAt);
    }
  }

  private failureResult(
    target: DeliveryTarget,
    error: string,
    startedAt = Date.now(),
  ): DeliveryResult {
    return {
      platform: target.platform,
      channel: target.channelId,
      messageType: 'text',
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      success: false,
      error: redactSecrets(error, this.secrets()),
    };
  }

  private describeDeliveryError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      if (status !== undefined) {
        const body = truncate(JSON.stringify(error.response?.data ?? ''));
        return `HTTP ${status}${body ? ` — ${body}` : ''}`;
      }
    }

    return describeError(error);
  }

  private secrets(): (string | undefined)[] {
    return [this.config.bale.botToken, this.config.telegram?.botToken];
  }
}

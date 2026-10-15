import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { BotApiClient } from '../platform/bot-api.client';
import { Platform } from '../platform/platform.types';
import {
  DeliveryStatus,
  FailureCategory,
  MediaStatus,
  PublicationPayload,
} from './channel.types';

/**
 * Phase 5 delivery adapter (§14).
 *
 * The Channel Engine never talks HTTP: it hands a fully rendered `PublicationPayload` to one of the
 * configured destinations and receives a *normalized* outcome — per destination, with the platform's
 * own message id, the classified failure (retryable / permanent / ambiguous) and the media outcome.
 *
 * Platform specifics live behind `BotApiClient` (transport) and this class (destination/target
 * selection + media rules), so the engine's business logic contains no platform branch at all.
 */

export interface ChannelDestination {
  platform: Platform;
  /** Channel/chat the payload is delivered to (never a token). */
  destination: string;
}

export interface ChannelDeliveryOutcome {
  platform: Platform;
  destination: string;
  status: DeliveryStatus;
  failureKind: FailureCategory | null;
  /** Platform message id of the textual payload (kept for traceability). */
  messageId: string | null;
  /** Platform message id of the media message, when one was sent separately. */
  mediaMessageId: string | null;
  mediaStatus: MediaStatus;
  mediaError: string | null;
  error: string | null;
  durationMs: number;
}

@Injectable()
export class ChannelPublisher {
  private readonly logger = new Logger(ChannelPublisher.name);
  private readonly targets: ChannelDestination[];
  private readonly captionLimit: number;

  constructor(
    private readonly config: AppConfigService,
    private readonly client: BotApiClient,
  ) {
    this.captionLimit = this.config.channelMediaCaptionLimit;

    const targets: ChannelDestination[] = [
      { platform: 'bale', destination: this.config.bale.channelId },
    ];

    const telegram = this.config.telegram;
    if (telegram) {
      targets.push({ platform: 'telegram', destination: telegram.channelId });
    }

    this.targets = targets;
  }

  /** Every enabled destination, in a stable order. */
  get destinations(): readonly ChannelDestination[] {
    return this.targets;
  }

  /**
   * Identity of the destination set — part of every idempotency key, so a publication that was
   * already delivered to this exact set is not repeated (§12).
   */
  get destinationKey(): string {
    return this.targets
      .map((target) => target.platform)
      .sort()
      .join('+');
  }

  /**
   * Deliver one payload to one destination.
   *
   * Media rule (§14): text-only when there is no media; with media, the text is used as the caption
   * when it fits the platform caption limit, otherwise the text is sent first and the media follows
   * as its own message. A media failure never discards the textual payload — it is recorded
   * separately (`mediaStatus`/`mediaError`) and, when a photo is rejected permanently, the payload
   * is still delivered as text.
   */
  async publish(
    destination: ChannelDestination,
    payload: PublicationPayload,
  ): Promise<ChannelDeliveryOutcome> {
    const startedAt = Date.now();

    if (payload.media === null) {
      const text = await this.client.publishText(
        destination.platform,
        destination.destination,
        payload.text,
      );

      return this.toOutcome(destination, text.success, {
        messageId: text.messageId,
        failureKind: text.failureKind,
        error: text.error,
        mediaStatus: 'NOT_ATTACHED',
        mediaMessageId: null,
        mediaError: null,
        startedAt,
      });
    }

    const caption = payload.text;
    const fits = caption.length <= this.captionLimit;

    if (fits) {
      const photo = await this.client.publishPhoto(
        destination.platform,
        destination.destination,
        payload.media.url,
        caption,
      );

      if (photo.success) {
        return this.toOutcome(destination, true, {
          messageId: photo.messageId,
          failureKind: null,
          error: null,
          mediaStatus: 'SENT',
          mediaMessageId:
            photo.messageId === null ? null : String(photo.messageId),
          mediaError: null,
          startedAt,
        });
      }

      // Permanent media rejection (unsupported type, bad URL): fall back to text so the payload is
      // still delivered, and record the media failure instead of hiding it.
      if (photo.failureKind === 'PERMANENT') {
        this.logger.warn(
          `Media rejected on ${destination.platform} (${photo.error ?? 'unknown reason'}) — ` +
            'falling back to a text-only publication.',
        );

        const fallback = await this.client.publishText(
          destination.platform,
          destination.destination,
          payload.text,
        );

        return this.toOutcome(destination, fallback.success, {
          messageId: fallback.messageId,
          failureKind: fallback.failureKind,
          error: fallback.error,
          mediaStatus: 'FAILED',
          mediaMessageId: null,
          mediaError: photo.error,
          startedAt,
        });
      }

      return this.toOutcome(destination, false, {
        messageId: null,
        failureKind: photo.failureKind,
        error: photo.error,
        mediaStatus: 'NOT_ATTACHED',
        mediaMessageId: null,
        mediaError: null,
        startedAt,
      });
    }

    // Long editorial text: text message first, then the media as its own message.
    const text = await this.client.publishText(
      destination.platform,
      destination.destination,
      payload.text,
    );

    if (!text.success) {
      return this.toOutcome(destination, false, {
        messageId: null,
        failureKind: text.failureKind,
        error: text.error,
        mediaStatus: 'NOT_ATTACHED',
        mediaMessageId: null,
        mediaError: null,
        startedAt,
      });
    }

    const photo = await this.client.publishPhoto(
      destination.platform,
      destination.destination,
      payload.media.url,
    );

    return this.toOutcome(destination, true, {
      messageId: text.messageId,
      failureKind: null,
      error: null,
      mediaStatus: photo.success ? 'SENT' : 'FAILED',
      mediaMessageId:
        photo.success && photo.messageId !== null
          ? String(photo.messageId)
          : null,
      mediaError: photo.success ? null : photo.error,
      startedAt,
    });
  }

  private toOutcome(
    destination: ChannelDestination,
    success: boolean,
    details: {
      messageId: number | null;
      failureKind: FailureCategory | null;
      error: string | null;
      mediaStatus: MediaStatus;
      mediaMessageId: string | null;
      mediaError: string | null;
      startedAt: number;
    },
  ): ChannelDeliveryOutcome {
    return {
      platform: destination.platform,
      destination: destination.destination,
      status: this.statusOf(success, details.failureKind),
      failureKind: success ? null : (details.failureKind ?? 'AMBIGUOUS'),
      messageId: details.messageId === null ? null : String(details.messageId),
      mediaMessageId: details.mediaMessageId,
      mediaStatus: details.mediaStatus,
      mediaError: details.mediaError,
      error: details.error,
      durationMs: Date.now() - details.startedAt,
    };
  }

  /**
   * A failed call is only `FAILED` when the platform answered; an unanswered call stays `UNKNOWN`,
   * so the ambiguity is preserved instead of being rounded to success or failure (§10).
   */
  private statusOf(
    success: boolean,
    failureKind: FailureCategory | null,
  ): DeliveryStatus {
    if (success) {
      return 'SENT';
    }

    return failureKind === 'AMBIGUOUS' ? 'UNKNOWN' : 'FAILED';
  }
}

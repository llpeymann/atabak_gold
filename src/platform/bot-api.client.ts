import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';

import { AppConfigService } from '../config/app-config.service';
import { describeError, redactSecrets, truncate } from '../common/log-safety';
import {
  isPlatform,
  InboundUpdate,
  Platform,
  PlatformSendResult,
  PollResult,
} from './platform.types';

/**
 * Thin client for the Telegram-compatible Bot API that both Bale and Telegram expose.
 *
 * This is the *only* place that knows about HTTP endpoints, 429 handling or the raw update
 * envelope. It is transport-only: it never decides what a message means and never builds user
 * text. Every method returns a structured result instead of throwing, so a network problem can
 * never crash the bot loop.
 */
@Injectable()
export class BotApiClient {
  private readonly logger = new Logger(BotApiClient.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly config: AppConfigService,
  ) {}

  /** Which platforms have a usable bot token. */
  configuredPlatforms(): Platform[] {
    return this.config.botTokens.map((entry) => entry.platform);
  }

  async getUpdates(
    platform: Platform,
    offset: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<PollResult> {
    const response = await this.call(
      platform,
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
    );

    if (!response.ok) {
      throw new Error(response.error);
    }

    return this.parseUpdates(platform, response.result);
  }

  async sendMessage(
    platform: Platform,
    chatId: string,
    text: string,
    replyMarkup?: unknown,
  ): Promise<PlatformSendResult> {
    const response = await this.call(platform, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

    return this.toSendResult(platform, chatId, response, false);
  }

  async editMessageText(
    platform: Platform,
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: unknown,
  ): Promise<PlatformSendResult> {
    const response = await this.call(platform, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

    return this.toSendResult(platform, chatId, response, true);
  }

  /**
   * Loading feedback for a button press. A failure here is cosmetic, so it is logged at debug
   * level and never treated as a user-visible error.
   */
  async answerCallbackQuery(
    platform: Platform,
    callbackId: string,
    text?: string,
  ): Promise<void> {
    const response = await this.call(platform, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text ? { text } : {}),
    });

    if (!response.ok) {
      this.logger.debug(
        `Could not answer callback on ${platform}: ${response.error}`,
      );
    }
  }

  // --- internals -------------------------------------------------------------

  private async call(
    platform: Platform,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result: unknown; error: string }> {
    const token = this.tokenFor(platform);

    if (!token) {
      return {
        ok: false,
        result: null,
        error: `Platform ${platform} is not configured (missing bot token)`,
      };
    }

    const url = `${this.baseUrlFor(platform, token)}/${method}`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(url, body, {
          timeout: this.timeoutMs(method),
          ...(signal ? { signal } : {}),
        }),
      );

      const data = response.data as
        { ok?: boolean; result?: unknown; description?: string } | undefined;

      if (data?.ok === false) {
        return {
          ok: false,
          result: null,
          error: this.sanitize(
            platform,
            `HTTP 200 / ok=false — ${data.description ?? 'unknown API error'}`,
          ),
        };
      }

      return { ok: true, result: data?.result ?? null, error: '' };
    } catch (error) {
      return { ok: false, result: null, error: this.describe(platform, error) };
    }
  }

  private toSendResult(
    platform: Platform,
    chatId: string,
    response: { ok: boolean; result: unknown; error: string },
    edited: boolean,
  ): PlatformSendResult {
    if (!response.ok) {
      this.logger.error(
        `❌ ${edited ? 'Edit' : 'Send'} failed on ${platform} (chat ${chatId}): ${response.error}`,
      );

      return {
        platform,
        chatId,
        success: false,
        edited,
        messageId: null,
        error: response.error,
      };
    }

    return {
      platform,
      chatId,
      success: true,
      edited,
      messageId: this.readMessageId(response.result),
    };
  }

  private parseUpdates(platform: Platform, result: unknown): PollResult {
    const raw = Array.isArray(result) ? result : [];
    const updates: InboundUpdate[] = [];
    let nextOffset: number | null = null;

    for (const entry of raw) {
      const update = this.parseUpdate(platform, entry);

      if (!update) {
        continue;
      }

      updates.push(update);
      nextOffset = Math.max(
        nextOffset ?? update.updateId + 1,
        update.updateId + 1,
      );
    }

    return { updates, nextOffset: nextOffset ?? 0 };
  }

  private parseUpdate(
    platform: Platform,
    entry: unknown,
  ): InboundUpdate | null {
    if (typeof entry !== 'object' || entry === null) {
      this.logger.warn(`Ignored a malformed update from ${platform}.`);
      return null;
    }

    const raw = entry as Record<string, unknown>;
    const updateId = Number(raw.update_id);

    if (!Number.isInteger(updateId)) {
      this.logger.warn(
        `Ignored an update without a usable update_id on ${platform}.`,
      );
      return null;
    }

    const message = raw.message;
    if (typeof message === 'object' && message !== null) {
      const inbound = this.parseMessage(platform, updateId, message);
      if (inbound) {
        return inbound;
      }
    }

    const callback = raw.callback_query;
    if (typeof callback === 'object' && callback !== null) {
      const inbound = this.parseCallback(platform, updateId, callback);
      if (inbound) {
        return inbound;
      }
    }

    return {
      kind: 'ignored',
      updateId,
      platform,
      reason: 'unsupported update type',
    };
  }

  private parseMessage(
    platform: Platform,
    updateId: number,
    message: object,
  ): InboundUpdate | null {
    const raw = message as Record<string, unknown>;
    const from = raw.from;
    const sender =
      typeof from === 'object' && from !== null
        ? (from as Record<string, unknown>)
        : null;
    const chat = raw.chat;
    const chatObject =
      typeof chat === 'object' && chat !== null
        ? (chat as Record<string, unknown>)
        : null;

    const platformUserId = asIdString(sender?.id);
    // The chat is always answered through the platform-provided id, never through user input.
    const chatId = asIdString(chatObject?.id) ?? platformUserId;

    if (platformUserId === null || chatId === null) {
      this.logger.warn(`Ignored a message without a sender on ${platform}.`);
      return null;
    }

    return {
      kind: 'message',
      updateId,
      platform,
      chatId,
      platformUserId,
      messageId: this.readMessageId(raw),
      text: typeof raw.text === 'string' ? raw.text : null,
    };
  }

  private parseCallback(
    platform: Platform,
    updateId: number,
    callback: object,
  ): InboundUpdate | null {
    const raw = callback as Record<string, unknown>;
    const from = raw.from;
    const sender =
      typeof from === 'object' && from !== null
        ? (from as Record<string, unknown>)
        : null;
    const message = raw.message;
    const messageObject =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : null;

    const platformUserId = asIdString(sender?.id);

    if (platformUserId === null) {
      this.logger.warn(`Ignored a callback without a sender on ${platform}.`);
      return null;
    }

    const callbackChat =
      typeof messageObject?.chat === 'object' && messageObject.chat !== null
        ? asIdString((messageObject.chat as Record<string, unknown>).id)
        : null;

    return {
      kind: 'callback',
      updateId,
      platform,
      // A callback is always answered into the chat the button message belongs to.
      chatId: callbackChat ?? platformUserId,
      platformUserId,
      messageId: this.readMessageId(messageObject ?? {}),
      callbackId: asIdString(raw.id) ?? '',
      data: typeof raw.data === 'string' ? raw.data : '',
    };
  }

  private readMessageId(value: unknown): number | null {
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const id = (value as { message_id?: unknown }).message_id;

    return typeof id === 'number' ? id : null;
  }

  private tokenFor(platform: Platform): string | null {
    const entry = this.config.botTokens.find(
      (candidate) => candidate.platform === platform,
    );

    return entry?.botToken ?? null;
  }

  private baseUrlFor(platform: Platform, token: string): string {
    return platform === 'telegram'
      ? `https://api.telegram.org/bot${token}`
      : `https://tapi.bale.ai/bot${token}`;
  }

  /** Long-poll rounds may wait for the platform; ordinary calls stay short. */
  private timeoutMs(method: string): number {
    return method === 'getUpdates'
      ? (this.config.botPollTimeoutSeconds + 10) * 1_000
      : this.config.deliveryTimeoutMs;
  }

  private describe(platform: Platform, error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const body = truncate(JSON.stringify(error.response?.data ?? ''));

      if (status !== undefined) {
        return this.sanitize(
          platform,
          `HTTP ${status}${body ? ` — ${body}` : ''}`,
        );
      }
    }

    return this.sanitize(platform, describeError(error));
  }

  private sanitize(platform: Platform, text: string): string {
    const token = this.tokenFor(platform);

    return redactSecrets(text, [token ?? undefined]);
  }
}

/** Safe platform id conversion: objects never become `[object Object]` ids. */
export function asIdString(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}

/** Re-export for adapters that need the guard without importing the union twice. */
export { isPlatform };

/**
 * Demo harness — transport doubles.
 *
 * The demo runs the **real** application services; only the two places that would talk to the
 * outside world are replaced, and both replacements *record* instead of sending:
 *
 *   * `DemoBotApiClient` — every outbound Bot API call (screens, edits, channel publications,
 *     callback acknowledgements) is captured with the exact text and keyboard the project built.
 *   * `DemoBaleService` — the Phase 1 publication path (channel text delivery) is captured too.
 *   * `DemoPriceService` — refuses to fetch the external price provider at all: in demo mode the
 *     market pipeline is fed with an explicitly labelled DEMO payload instead of live data.
 *
 * There is therefore no code path from a demo run to Bale, Telegram or the price provider, and no
 * scenario can accidentally publish anything — while every decision, validation, rendering and
 * persistence step still executes the production implementation.
 */

import { HttpService } from '@nestjs/axios';

import { BaleService } from '../bale/bale.service';
import type { DeliveryResult } from '../bale/delivery-result';
import { AppConfigService } from '../config/app-config.service';
import { PriceService, type RawPriceFetch } from '../price/price.service';
import { BotApiClient } from '../platform/bot-api.client';
import type {
  InboundUpdate,
  Keyboard,
  Platform,
  PlatformPublishResult,
  PlatformSendResult,
  PollResult,
} from '../platform/platform.types';
import type { CapturedCall } from './demo.types';

/** Records what the application *would* have sent. */
export class DemoCapture {
  private readonly calls: CapturedCall[] = [];
  private sequence = 0;
  /** Platforms that the demo makes fail on purpose (used by the failure-isolation scenario). */
  private readonly failing = new Set<Platform>();

  record(entry: Omit<CapturedCall, 'at'>): void {
    this.calls.push({ at: new Date().toISOString(), ...entry });
  }

  list(): CapturedCall[] {
    return [...this.calls];
  }

  clear(): void {
    this.calls.length = 0;
  }

  /** Next message id handed out to a captured send (never collides with a real id). */
  nextMessageId(): number {
    this.sequence += 1;
    return 900_000 + this.sequence;
  }

  failOn(platform: Platform): void {
    this.failing.add(platform);
  }

  heal(platform: Platform): void {
    this.failing.delete(platform);
  }

  isFailing(platform: Platform): boolean {
    return this.failing.has(platform);
  }
}

/** Counts the keyboard rows that travelled with a message (0 = no keyboard). */
function keyboardRows(keyboard: Keyboard | null | undefined): number {
  return keyboard && keyboard.length > 0 ? keyboard.length : 0;
}

/** The single capture instance of a demo process. */
export const demoCapture = new DemoCapture();

/**
 * A `BotApiClient` that never performs a request.
 *
 * It extends the real client so the two stay signature-compatible: if the production client gains a
 * method, the demo fails to compile instead of silently drifting away from it.
 */
export class DemoBotApiClient extends BotApiClient {
  constructor(config: AppConfigService) {
    super(new HttpService(), config);
  }

  override getUpdates(): Promise<PollResult> {
    // Polling is disabled in demo mode; this keeps the loop (if it were ever started) idle.
    return Promise.resolve({ updates: [] as InboundUpdate[], nextOffset: 0 });
  }

  override sendMessage(
    platform: Platform,
    chatId: string,
    text: string,
    replyMarkup?: unknown,
  ): Promise<PlatformSendResult> {
    const failing = demoCapture.isFailing(platform);
    const rows = Array.isArray(replyMarkup)
      ? replyMarkup.length
      : replyMarkup
        ? 1
        : 0;

    demoCapture.record({
      platform,
      method: 'sendMessage',
      chatId,
      text,
      keyboardRows: rows,
      success: !failing,
      simulatedFailure: failing,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });

    return Promise.resolve({
      platform,
      chatId,
      success: !failing,
      edited: false,
      messageId: failing ? null : demoCapture.nextMessageId(),
      ...(failing ? { error: 'SIMULATED_FAILURE (demo toggle)' } : {}),
    });
  }

  override editMessageText(
    platform: Platform,
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: unknown,
  ): Promise<PlatformSendResult> {
    const failing = demoCapture.isFailing(platform);
    const rows = Array.isArray(replyMarkup)
      ? replyMarkup.length
      : replyMarkup
        ? 1
        : 0;

    demoCapture.record({
      platform,
      method: 'editMessageText',
      chatId,
      text,
      keyboardRows: rows,
      success: !failing,
      simulatedFailure: failing,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });

    return Promise.resolve({
      platform,
      chatId,
      success: !failing,
      edited: true,
      messageId,
      ...(failing ? { error: 'SIMULATED_FAILURE (demo toggle)' } : {}),
    });
  }

  override answerCallbackQuery(): Promise<void> {
    // Cosmetic in the real client as well: nothing is recorded, nothing is sent.
    return Promise.resolve();
  }

  override publishText(
    platform: Platform,
    chatId: string,
    text: string,
    keyboard?: Keyboard | null,
  ): Promise<PlatformPublishResult> {
    const failing = demoCapture.isFailing(platform);

    demoCapture.record({
      platform,
      method: 'publishText',
      chatId,
      text,
      keyboardRows: keyboardRows(keyboard),
      success: !failing,
      simulatedFailure: failing,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });

    return Promise.resolve({
      platform,
      chatId,
      success: !failing,
      messageId: failing ? null : demoCapture.nextMessageId(),
      failureKind: failing ? 'RETRYABLE' : null,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });
  }

  override publishPhoto(
    platform: Platform,
    chatId: string,
    photoUrl: string,
    caption?: string,
    keyboard?: Keyboard | null,
  ): Promise<PlatformPublishResult> {
    const failing = demoCapture.isFailing(platform);

    demoCapture.record({
      platform,
      method: 'publishPhoto',
      chatId,
      text: caption ?? '',
      keyboardRows: keyboardRows(keyboard),
      success: !failing,
      simulatedFailure: failing,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });

    // The photo itself is never fetched: the demo records the reference instead of the image.
    void photoUrl;

    return Promise.resolve({
      platform,
      chatId,
      success: !failing,
      messageId: failing ? null : demoCapture.nextMessageId(),
      failureKind: failing ? 'RETRYABLE' : null,
      error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
    });
  }
}

/** The Phase 1 channel-delivery path, captured instead of delivered. */
export class DemoBaleService extends BaleService {
  constructor(config: AppConfigService) {
    super(new HttpService(), config);
  }

  override sendMessage(text: string): Promise<DeliveryResult[]> {
    const targets: Platform[] = ['bale', 'telegram'];

    return Promise.resolve(
      targets.map((platform) => {
        const failing = demoCapture.isFailing(platform);

        demoCapture.record({
          platform,
          method: 'sendMessage (channel)',
          chatId: '(channel)',
          text,
          keyboardRows: 0,
          success: !failing,
          simulatedFailure: failing,
          error: failing ? 'SIMULATED_FAILURE (demo toggle)' : null,
        });

        return {
          platform,
          channel: '(demo channel — nothing was sent)',
          messageType: 'text' as const,
          timestamp: new Date().toISOString(),
          durationMs: 0,
          success: !failing,
          ...(failing ? { error: 'SIMULATED_FAILURE (demo toggle)' } : {}),
        };
      }),
    );
  }
}

/**
 * The price provider is deliberately **not** called in demo mode.
 *
 * The market pipeline is real from the payload onwards (`MarketEngineService.evaluateCycle` runs
 * parser → normalizer → sanity → state → publishable update); only the external fetch is replaced,
 * so a demo run can never depend on a third-party service being up.
 */
export class DemoPriceService extends PriceService {
  constructor(config: AppConfigService) {
    super(new HttpService(), config);
  }

  override fetchRawPayload(): Promise<RawPriceFetch> {
    return Promise.reject(
      new Error(
        'DEMO: external price fetch is disabled — scenarios inject a labelled DEMO payload through the real pipeline instead.',
      ),
    );
  }
}

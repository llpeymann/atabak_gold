import { BotApiClient } from './bot-api.client';
import {
  InboundMessage,
  Keyboard,
  OutboundMessage,
  Platform,
  PlatformCapabilities,
  PlatformSendResult,
  PollResult,
} from './platform.types';

/**
 * A platform adapter translates the neutral UX layer into one platform's mechanics.
 *
 * Everything that is genuinely platform-specific (editing support, button rendering) is
 * decided here — and only here. The bot core never branches on the platform (§10, §47).
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;
  /** Long-poll wait handed to the platform on each `getUpdates` call. */
  readonly pollTimeoutSeconds: number;

  /** `signal` cancels an in-flight long poll during shutdown. */
  poll(offset: number, signal?: AbortSignal): Promise<PollResult>;

  /** Deliver a screen; edits the referenced message when the platform supports it. */
  render(message: OutboundMessage): Promise<PlatformSendResult>;

  /** Loading feedback for a button press (no-op on platforms without callback answers). */
  acknowledge(callbackId: string, text?: string): Promise<void>;
}

/**
 * Shared implementation of the adapter contract. Only capability flags and the platform id
 * differ between Bale and Telegram, which keeps the two adapters free of duplicated logic.
 */
export class BotApiPlatformAdapter implements PlatformAdapter {
  constructor(
    readonly platform: Platform,
    readonly capabilities: PlatformCapabilities,
    readonly pollTimeoutSeconds: number,
    private readonly client: BotApiClient,
  ) {}

  async poll(offset: number, signal?: AbortSignal): Promise<PollResult> {
    return this.client.getUpdates(
      this.platform,
      offset,
      this.pollTimeoutSeconds,
      signal,
    );
  }

  async render(message: OutboundMessage): Promise<PlatformSendResult> {
    const markup = toReplyMarkup(message.keyboard ?? null);

    if (
      this.capabilities.supportsMessageEditing &&
      typeof message.editMessageId === 'number'
    ) {
      const edited = await this.client.editMessageText(
        this.platform,
        message.chatId,
        message.editMessageId,
        message.text,
        markup,
      );

      if (edited.success) {
        return edited;
      }
      // Editing is an optimisation only: the user always receives an answer, even when the
      // platform refuses to edit (message too old, deleted, or unsupported markup).
    }

    return this.client.sendMessage(
      this.platform,
      message.chatId,
      message.text,
      markup,
    );
  }

  async acknowledge(callbackId: string, text?: string): Promise<void> {
    if (!this.capabilities.supportsCallbackAnswer) {
      return;
    }

    await this.client.answerCallbackQuery(this.platform, callbackId, text);
  }
}

export interface AdapterOptions {
  supportsMessageEditing: boolean;
  supportsCallbackAnswer: boolean;
  pollTimeoutSeconds: number;
}

/** Factory used by the registry (keeps adapter construction in one place). */
export function createAdapter(
  platform: Platform,
  client: BotApiClient,
  options: AdapterOptions,
): BotApiPlatformAdapter {
  return new BotApiPlatformAdapter(
    platform,
    {
      supportsMessageEditing: options.supportsMessageEditing,
      supportsCallbackAnswer: options.supportsCallbackAnswer,
    },
    options.pollTimeoutSeconds,
    client,
  );
}

/**
 * Render a neutral keyboard as an inline keyboard. Both Bale and Telegram accept the
 * Telegram-compatible `inline_keyboard` shape; URL buttons are supported by both.
 */
export function toReplyMarkup(keyboard: Keyboard | null): unknown {
  if (!keyboard || keyboard.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => {
        if (button.url) {
          return { text: button.text, url: button.url };
        }

        return { text: button.text, callback_data: button.callbackData ?? '' };
      }),
    ),
  };
}

/** Narrow a message to a command (`/start`, `/menu`, …) — returns `null` when it is not one. */
export function asCommand(message: InboundMessage): string | null {
  const text = message.text?.trim();

  if (!text || !text.startsWith('/')) {
    return null;
  }

  // Commands may carry a bot mention (`/start@atabak_bot`) and arguments.
  const command = text.split(/\s+/)[0]?.slice(1).split('@')[0]?.toLowerCase();

  return command && command.length > 0 ? command : null;
}

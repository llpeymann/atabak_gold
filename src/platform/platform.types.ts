/**
 * Platform-neutral model of everything that crosses the Telegram/Bale boundary.
 *
 * The Bot UX layer speaks only in these types: no Telegram/Bale SDK type, no raw update
 * payload and no platform-specific branch ever reaches the business logic. Each platform
 * adapter is responsible for translating its own wire format into this model.
 */

/** Supported delivery/interaction platforms. Single source of truth for platform ids. */
export type Platform = 'bale' | 'telegram';

export const PLATFORMS: readonly Platform[] = ['bale', 'telegram'];

export function isPlatform(value: unknown): value is Platform {
  return value === 'bale' || value === 'telegram';
}

/** An inbound text message (including commands). */
export interface InboundMessage {
  kind: 'message';
  updateId: number;
  platform: Platform;
  /** Destination chat of the answer (comes from the platform, never from user data). */
  chatId: string;
  /** Identifies the sender inside the platform. */
  platformUserId: string;
  /** Id of the inbound message, when the platform reports one. */
  messageId: number | null;
  text: string | null;
}

/** An inbound inline-keyboard callback. */
export interface InboundCallback {
  kind: 'callback';
  updateId: number;
  platform: Platform;
  chatId: string;
  platformUserId: string;
  /** Message the pressed button belongs to (needed for edit-in-place). */
  messageId: number | null;
  callbackId: string;
  data: string;
}

/** An update the bot deliberately ignores (unsupported type) — logged, never crashed on. */
export interface IgnoredUpdate {
  kind: 'ignored';
  updateId: number;
  platform: Platform;
  reason: string;
}

export type InboundUpdate = InboundMessage | InboundCallback | IgnoredUpdate;

/** A neutral keyboard button: a callback button, a URL button, or a label-only row header. */
export interface KeyboardButton {
  text: string;
  /** Action executed by the bot (exactly one of `callbackData`/`url` may be set). */
  callbackData?: string;
  /** External link (used by the channel CTA). */
  url?: string;
}

export type KeyboardRow = readonly KeyboardButton[];
export type Keyboard = readonly KeyboardRow[];

export interface OutboundMessage {
  chatId: string;
  text: string;
  keyboard?: Keyboard | null;
  /**
   * When set and the platform supports it, the adapter may edit this message instead of
   * sending a new one. A failed edit never loses the answer: the bot falls back to a send.
   */
  editMessageId?: number | null;
}

export interface PlatformCapabilities {
  /** Whether the platform can edit a previously sent message. */
  supportsMessageEditing: boolean;
  /** Whether the platform can answer callback queries (loading feedback). */
  supportsCallbackAnswer: boolean;
}

/**
 * Why a publishing call failed (Phase 5 §13/§14).
 *
 * `RETRYABLE` — the platform explicitly refused the attempt (HTTP 5xx/429): retrying cannot
 * duplicate a message that was never accepted.
 * `PERMANENT` — the request itself is wrong (4xx / API `ok:false`): retrying would fail again.
 * `AMBIGUOUS` — there was no answer at all (timeout, socket reset): the message *may* have been
 * delivered, so callers must not blindly retry it.
 */
export type PlatformFailureKind = 'RETRYABLE' | 'PERMANENT' | 'AMBIGUOUS';

/** Result of a channel publication call, with the failure classified (§14). */
export interface PlatformPublishResult {
  platform: Platform;
  chatId: string;
  success: boolean;
  messageId: number | null;
  failureKind: PlatformFailureKind | null;
  /** Sanitized failure description (secrets redacted). `null` on success. */
  error: string | null;
}

export interface PlatformSendResult {
  platform: Platform;
  chatId: string;
  success: boolean;
  /** Edited an existing message instead of sending a new one. */
  edited: boolean;
  messageId: number | null;
  /** Sanitized failure description (secrets redacted). Absent on success. */
  error?: string;
}

/**
 * Result of a `getChatMember` query (Phase 8 §8.4).
 *
 * `status` is the raw platform value (`member`, `administrator`, `creator`, `restricted`, `left`,
 * `kicked`) translated into a tri-state by the caller. `supported: false` means *this platform was
 * never claimed to answer the query* — the honest answer for Bale, whose support for `getChatMember`
 * is not verified by this project.
 */
export interface PlatformMembershipResult {
  platform: Platform;
  supported: boolean;
  /** `true` only when the platform answered the query successfully. */
  answered: boolean;
  /** Raw membership status as reported by the platform (`null` when it did not answer). */
  status: string | null;
  error: string | null;
}

/** Polling result of one long-poll round. */
export interface PollResult {
  updates: InboundUpdate[];
  /** Offset to send on the next round (max seen update id + 1). */
  nextOffset: number;
}

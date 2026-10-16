import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { Keyboard } from '../platform/platform.types';
import { referralPayloadFor } from '../referrals/referral-code';
import { BotRoute } from './deep-link';

/**
 * Phase 6 — the *only* place where a public bot/channel destination is turned into a URL (§7, §8).
 *
 * Everything here is derived from configuration; nothing is guessed. When the configuration for a
 * destination is missing the builder returns `null`, and every caller treats `null` as “this link
 * does not exist” (omit the button, or answer with an explanation) — a fabricated or placeholder URL
 * can therefore never reach a user or a channel.
 */

/**
 * What each platform supports, per its own documentation:
 *
 *  * Telegram — bot deep links `https://t.me/<username>?start=<payload>`; inline URL buttons.
 *  * Bale — bot deep links `ble.ir/<username>?start=<parameter>` (the parameter arrives as
 *    `/start <parameter>`), inline URL buttons with `url`/`callback_data`.
 *
 * Both platforms are therefore capable of the same two mechanics; they differ only in the link host,
 * which is why the platform table below exists instead of a Telegram-shaped assumption.
 */
export interface PlatformLinkCapabilities {
  /** The platform can open a bot with a start payload. */
  readonly deepLinks: boolean;
  /** The platform renders inline URL buttons in channel messages. */
  readonly urlButtons: boolean;
}

/**
 * The username shape the startup validation enforces (`env.validation.ts`). It is re-checked here so
 * that a value which somehow bypassed boot validation (a hand-built config in a script, a value with a
 * stray `@` or a space) can never produce a malformed link — the builder then behaves exactly like the
 * "not configured" case instead of publishing something broken (§4.1 rule 9).
 */
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export function withCapabilities(): Record<
  'bale' | 'telegram',
  PlatformLinkCapabilities
> {
  return {
    bale: { deepLinks: true, urlButtons: true },
    telegram: { deepLinks: true, urlButtons: true },
  };
}

@Injectable()
export class BotDestinationService {
  private readonly logger = new Logger(BotDestinationService.name);
  private readonly capabilities = withCapabilities();

  constructor(private readonly config: AppConfigService) {}

  /**
   * Public bot username of a platform, normalized (a leading `@` is accepted), or `null` when it is not
   * configured or not a usable username.
   */
  botUsername(platform: 'bale' | 'telegram'): string | null {
    const configured =
      platform === 'telegram'
        ? this.config.telegramBotUsername
        : this.config.baleBotUsername;
    const normalized = configured.trim().replace(/^@/, '');

    if (normalized.length === 0) {
      return null;
    }

    if (!USERNAME_PATTERN.test(normalized)) {
      // Diagnosable without echoing the (already public) value into the log line unnecessarily.
      this.logger.warn(
        `Bot username configured for ${platform} is not a valid username; deep links stay disabled.`,
      );

      return null;
    }

    return normalized;
  }

  /** Capabilities of the platform (documented above), used by callers that need a safe fallback. */
  linkCapabilities(platform: 'bale' | 'telegram'): PlatformLinkCapabilities {
    return this.capabilities[platform];
  }

  /**
   * Public bot username used for *referral* links of a platform (Phase 7 §4.2).
   *
   * Kept separately from the Phase 6 destination username because a product may point referral links at
   * a different bot than the channel call-to-action. Empty or invalid = no referral link at all: the
   * referral screen then explains what is missing instead of showing a guessed address.
   */
  referralBotUsername(platform: 'bale' | 'telegram'): string | null {
    const configured =
      platform === 'telegram'
        ? this.config.telegramReferralBotUsername
        : this.config.baleReferralBotUsername;
    const normalized = configured.trim().replace(/^@/, '');

    if (normalized.length === 0) {
      return null;
    }

    if (!USERNAME_PATTERN.test(normalized)) {
      this.logger.warn(
        `Referral bot username configured for ${platform} is not a valid username; referral links stay disabled.`,
      );

      return null;
    }

    return normalized;
  }

  /**
   * Referral link of a user code on one platform, or `null` when it cannot be built.
   *
   * The payload is `ref_<code>` — the same `?start=` mechanism Phase 6 already uses, so no platform
   * semantics are invented here (Bale sends it as `/start ref_<code>`, Telegram as the deep-link
   * parameter, §4.2).
   */
  referralLink(platform: 'bale' | 'telegram', code: string): string | null {
    const username = this.referralBotUsername(platform);

    if (!username || !this.capabilities[platform].deepLinks) {
      return null;
    }

    const host = platform === 'telegram' ? 'https://t.me' : 'https://ble.ir';

    return `${host}/${username}?start=${encodeURIComponent(referralPayloadFor(code))}`;
  }

  /**
   * Deep link that opens this platform's bot on one of the five routes.
   * `null` when the payload cannot be built — either the bot username is not configured or the
   * platform does not support start payloads.
   */
  deepLink(platform: 'bale' | 'telegram', route: BotRoute): string | null {
    const username = this.botUsername(platform);

    if (!username || !this.capabilities[platform].deepLinks) {
      return null;
    }

    const host = platform === 'telegram' ? 'https://t.me' : 'https://ble.ir';

    return `${host}/${username}?start=${encodeURIComponent(route)}`;
  }

  /**
   * Public channel destination of a platform.
   * Bale uses `CHANNEL_URL` (the existing key); Telegram needs its own link, because a Bale channel
   * address is not a Telegram destination (`TELEGRAM_CHANNEL_URL`).
   */
  channelUrl(platform: 'bale' | 'telegram'): string | null {
    const url =
      platform === 'telegram'
        ? this.config.telegramChannelUrl
        : this.config.channelUrl;

    return url.length > 0 ? url : null;
  }

  /**
   * Inline keyboard that carries a channel → bot CTA for one destination, or `null` when the CTA
   * cannot be built for this platform (§4.1 rules 8–9). The label always describes the destination.
   */
  ctaKeyboard(
    platform: 'bale' | 'telegram',
    cta: { route: BotRoute; labelFa: string },
  ): Keyboard | null {
    if (
      !this.config.channelCtaEnabled ||
      !this.capabilities[platform].urlButtons
    ) {
      return null;
    }

    const url = this.deepLink(platform, cta.route);

    if (!url) {
      this.logger.debug(
        `CTA for route "${cta.route}" skipped on ${platform}: no public bot username is configured for that platform.`,
      );

      return null;
    }

    return [[{ text: cta.labelFa, url }]];
  }

  /** The single channel-invitation row used by the bot screens (`null` when it must be omitted). */
  channelInviteRow(platform: 'bale' | 'telegram'): Keyboard | null {
    if (!this.config.botChannelInviteEnabled) {
      return null;
    }

    const url = this.channelUrl(platform);

    return url ? [[{ text: '📢 دیدن تحلیل در کانال', url }]] : null;
  }
}

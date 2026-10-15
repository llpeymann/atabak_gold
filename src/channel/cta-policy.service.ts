import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { BotRoute } from '../bot/deep-link';
import { ContentItem, MessageType } from './channel.types';
import { specFor } from './message-registry';

/**
 * Phase 6 — call-to-action policy (§4.1).
 *
 * The policy answers exactly one question: *may this publication carry a button to the bot, and where
 * should it lead?* It never touches market data, never builds a URL (that is
 * `BotDestinationService`, which is platform- and configuration-aware) and never publishes anything.
 *
 * Eligibility is decided by three layers, in this order:
 *
 *   1. **explicit content choice** — an editorial item marked by an admin (`ctaRoute` on the item),
 *      which is the only way an *alert-promotion* post can exist, because the seven Phase 5 message
 *      types contain no promotion type and inventing an eighth one would break the registry;
 *   2. **configured override** — `CHANNEL_CTA_ROUTES` (`TYPE=route|none`);
 *   3. **registry default** — the type's default intent, optionally refined by the subject group of
 *      the publication (a gold-only price post links to gold prices, a coin-only one to coins, and a
 *      mixed or general post to the full price list).
 *
 * Consequences that are deliberate:
 *   * routine price updates never carry the alert CTA (they resolve to a price route);
 *   * educational/branded content carries no CTA by default — unrelated content must not receive a
 *     promotional button;
 *   * a type or content item can always be silenced with `none`.
 */

/** CTA intents a policy may return, including the "no button" decision. */
export type CtaDecision = { route: BotRoute; labelFa: string } | null;

/** Persian labels — the label always describes the real destination (§4.1). */
export const CTA_LABELS: Record<BotRoute, string> = {
  alert: '🔔 فعال‌سازی هشدار قیمت',
  prices: '💰 مشاهده قیمت‌ها',
  coin: '🪙 مشاهده قیمت سکه',
  gold: '🟡 مشاهده قیمت طلا',
  channel: '📢 ورود به کانال طلای اتابک',
};

/**
 * Subject groups that refine a price CTA: when every symbol of a publication belongs to one group, the
 * button points at that group's screen. Symbols come from the Phase 1 registry groups, not from text
 * matching, so an unknown subject can never invent a route.
 */
const GOLD_SUBJECT_PREFIXES = ['IR_GOLD', 'XAU'];
const COIN_SUBJECT_PREFIXES = ['IR_COIN'];

export function groupOfSubject(subject: string): 'gold' | 'coin' | null {
  if (GOLD_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
    return 'gold';
  }

  if (COIN_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
    return 'coin';
  }

  return null;
}

@Injectable()
export class CtaPolicyService {
  private readonly logger = new Logger(CtaPolicyService.name);

  constructor(private readonly config: AppConfigService) {}

  /** Whether channel CTAs are switched on at all. */
  get enabled(): boolean {
    return this.config.channelCtaEnabled;
  }

  /** Resolved CTA of one publication, or `null` when it must not carry a button. */
  decide(input: {
    messageType: MessageType;
    subjects?: readonly string[];
    content?: ContentItem | null;
  }): CtaDecision {
    if (!this.enabled) {
      return null;
    }

    // 1) an explicit admin choice on the content item wins (it is the only way to promote alerts)
    const explicit = this.explicitChoice(input.content ?? null);

    if (explicit === 'none') {
      return null;
    }

    if (explicit) {
      return { route: explicit, labelFa: CTA_LABELS[explicit] };
    }

    // 2) configuration override for the type
    const override = this.config.channelCtaRouteOverrides[input.messageType];

    if (override === 'none') {
      return null;
    }

    if (override && override !== '') {
      const route = override as BotRoute;

      return { route, labelFa: CTA_LABELS[route] };
    }

    // 3) registry default, refined by the subject group
    const fallback = specFor(input.messageType).defaultCta;

    if (fallback === null) {
      return null;
    }

    const route =
      fallback === 'subject-group'
        ? this.routeForSubjects(input.subjects ?? [])
        : fallback;

    return { route, labelFa: CTA_LABELS[route] };
  }

  /**
   * The admin-facing explanation of what a type does by default (management screens, logs).
   * It reports the *policy*, never a live decision.
   */
  describeDefault(type: MessageType): string {
    const fallback = specFor(type).defaultCta;

    if (fallback === null) {
      return 'بدون دکمه (پیش‌فرض)';
    }

    if (fallback === 'subject-group') {
      return 'گروه نمادها (طلا/سکه) یا فهرست قیمت‌ها';
    }

    return `${fallback} (${CTA_LABELS[fallback]})`;
  }

  /** The CTA route stored on a content item, normalized (`auto`/absent = registry default). */
  private explicitChoice(
    content: ContentItem | null,
  ): BotRoute | 'none' | null {
    const choice = content?.ctaRoute;

    if (choice === undefined || choice === null || choice === 'auto') {
      return null;
    }

    return choice;
  }

  /**
   * Refine a price CTA by the publication's subjects: only when *every* subject belongs to one group.
   * An empty subject list (for example a general report) resolves to the full price list.
   */
  private routeForSubjects(subjects: readonly string[]): BotRoute {
    if (subjects.length === 0) {
      return 'prices';
    }

    const groups = new Set(subjects.map((subject) => groupOfSubject(subject)));

    if (groups.size === 1) {
      const [group] = [...groups];

      if (group === 'gold' || group === 'coin') {
        return group;
      }
    }

    return 'prices';
  }

  /** Operational log line: what this policy will attach (no secrets, no per-message spam). */
  logPolicy(): void {
    const overrides = this.config.channelCtaRouteOverrides;
    const summary = Object.keys(overrides)
      .map((type) => `${type}=${overrides[type]}`)
      .join(', ');

    const defaults = (
      [
        'PRICE_UPDATE',
        'MARKET_MOVEMENT',
        'DAILY_RANGE',
        'DAILY_REPORT',
        'EDUCATIONAL',
        'BRANDED',
        'NIGHTLY_ANALYSIS',
      ] as MessageType[]
    )
      .map((type) => `${type}: ${this.describeDefault(type)}`)
      .join(' | ');

    this.logger.log(
      `Channel CTAs: ${this.enabled ? 'enabled' : 'disabled'}${summary ? ` | overrides ${summary}` : ''} | ${defaults}`,
    );
  }
}

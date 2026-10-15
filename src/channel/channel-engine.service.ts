import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { describeError } from '../common/log-safety';
import {
  tehranDayKey,
  tehranHourMinute,
  TEHRAN_TIME_ZONE,
} from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import { MarketIntelligenceSnapshot } from '../intelligence/market-intelligence.types';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { PublishableMarketUpdate } from '../market/market.types';
import { PriceMessageBuilder } from '../bot/price-message.builder';
import { PosterService } from '../poster/poster.service';
import {
  formatterNameFor,
  formatDailyRangeMessage,
  formatDailyReportMessage,
  formatMovementMessage,
  formatNightlyAnalysisMessage,
  formatBrandedMessage,
  formatEditorialMessage,
} from './channel-format';
import {
  ChannelPolicyService,
  MovementCandidate,
  RangeCandidate,
} from './channel-policy.service';
import { CtaPolicyService } from './cta-policy.service';
import {
  ChannelDestination,
  ChannelPublisher,
} from './channel-publisher.service';
import {
  ChannelEntityPrefix,
  ContentItem,
  createChannelId,
  MessageType,
  PriceUpdateVariant,
  PublicationDelivery,
  PublicationJob,
  PublicationOutcome,
  PublicationPayload,
  PublicationStatus,
  SkipReason,
} from './channel.types';
import { isEditorialType } from './message-registry';
import { PublicationStore } from './publication.store';

/** Optional per-execution inputs that cannot be re-derived after a restart (§23). */
export interface ExecutionInputs {
  /** Phase 1 publishable update behind a `PRICE_UPDATE` job. */
  priceUpdate?: PublishableMarketUpdate;
  /** Movement candidates selected for a `MARKET_MOVEMENT` job. */
  movement?: readonly MovementCandidate[];
  /** Range candidates selected for an event-driven `DAILY_RANGE` job. */
  range?: readonly RangeCandidate[];
}

/**
 * Phase 5 — Channel Engine (§1, §9–§13, §23).
 *
 * One place that turns "something should be published" into a publication: a job with a logical
 * identity, an eligibility decision, rendered content, per-destination delivery records and a
 * traceable history. It reuses Phase 1 for price truth and Phase 4 for descriptive market data, and
 * it never fetches, validates or recomputes a market value.
 *
 * Overlap and duplicate prevention are *state transitions* in the publication store (job creation
 * `create-if-absent` by idempotency key, and `PENDING → PUBLISHING` inside one non-yielding critical
 * section), not an in-memory boolean — a restart cannot lead to a second delivery of a message whose
 * delivery is already recorded.
 */
@Injectable()
export class ChannelEngineService implements OnModuleInit {
  private readonly logger = new Logger(ChannelEngineService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: PublicationStore,
    private readonly publisher: ChannelPublisher,
    private readonly policy: ChannelPolicyService,
    private readonly ctaPolicy: CtaPolicyService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly priceMessageBuilder: PriceMessageBuilder,
    private readonly posterService: PosterService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureLoaded();
    this.policy.logPolicy();
    this.ctaPolicy.logPolicy();
    this.logger.log(
      `Channel Engine ready: destinations ${this.publisher.destinationKey || 'none'} | ` +
        `history ${this.store.jobCount} job(s) | data file ${this.store.path ?? 'disabled'}`,
    );
    await this.recover();
  }

  // --- entry points ------------------------------------------------------------

  /**
   * Publish the channel price update for one market cycle (the existing half-hourly / closing
   * crons call this instead of sending directly, so there is exactly one publication path).
   */
  async publishPriceUpdate(
    update: PublishableMarketUpdate,
    variant: PriceUpdateVariant,
    now = new Date(),
  ): Promise<PublicationOutcome> {
    const windowKey = `${update.dayKey}T${tehranHourMinute(now)}`;
    const subjects = update.prices.map((price) => price.symbol);
    const idempotencyKey = [
      'PRICE_UPDATE',
      variant,
      windowKey,
      [...subjects].sort().join(','),
      this.publisher.destinationKey,
    ].join('|');

    return this.runJob(
      {
        messageType: 'PRICE_UPDATE',
        idempotencyKey,
        subjects,
        reportingDate: update.dayKey,
        variant,
        scheduledAt: now.toISOString(),
      },
      now,
      { priceUpdate: update },
    );
  }

  /** Publish movement events for the symbols that crossed their threshold (§17). */
  async publishMovementEvents(now = new Date()): Promise<PublicationOutcome[]> {
    const snapshot = this.intelligence.build(now);
    const candidates = this.policy.selectMovementCandidates(snapshot, now);

    if (candidates.length === 0) {
      return [];
    }

    const subjects = candidates.map((candidate) => candidate.symbol).sort();
    const windowKey = `${tehranDayKey(now)}T${tehranHourMinute(now)}`;
    const idempotencyKey = [
      'MARKET_MOVEMENT',
      windowKey,
      subjects.join(','),
      this.publisher.destinationKey,
    ].join('|');

    const outcome = await this.runJob(
      {
        messageType: 'MARKET_MOVEMENT',
        idempotencyKey,
        subjects,
        reportingDate: tehranDayKey(now),
        variant: null,
        scheduledAt: now.toISOString(),
      },
      now,
      { movement: candidates },
    );

    if (outcome.status === 'PUBLISHED') {
      for (const candidate of candidates) {
        await this.policy.recordMovementEvent(candidate, now);
      }
    }

    // Advance re-arm flags for the next cycle (deterministic, day-scoped).
    await this.policy.updateMovementReArm(snapshot, now);

    return [outcome];
  }

  /** Scheduled daily high/low publication (§5.3). */
  async publishDailyRange(
    now = new Date(),
    mode: 'scheduled' | 'event' = 'scheduled',
  ): Promise<PublicationOutcome> {
    const dayKey = tehranDayKey(now);
    const candidates =
      mode === 'event'
        ? this.policy.selectRangeCandidates(this.intelligence.build(now), now)
        : [];

    if (mode === 'event' && candidates.length === 0) {
      return this.skipOutcome('DAILY_RANGE', 'RANGE_EVENT_SUPPRESSED');
    }

    const subjects =
      mode === 'event'
        ? candidates.map((candidate) => candidate.symbol).sort()
        : this.intelligence
            .build(now)
            .symbols.filter(
              (symbol) => symbol.high !== null && symbol.low !== null,
            )
            .map((symbol) => symbol.symbol);

    const idempotencyKey = [
      'DAILY_RANGE',
      mode,
      dayKey,
      subjects.join(','),
      this.publisher.destinationKey,
    ].join('|');

    const outcome = await this.runJob(
      {
        messageType: 'DAILY_RANGE',
        idempotencyKey,
        subjects,
        reportingDate: dayKey,
        variant: null,
        scheduledAt: now.toISOString(),
      },
      now,
      { range: candidates },
    );

    if (outcome.status === 'PUBLISHED' && mode === 'event') {
      await this.policy.recordRangeEvents(candidates, now);
    }

    return outcome;
  }

  /** Scheduled daily market report (§5.4). */
  async publishDailyReport(now = new Date()): Promise<PublicationOutcome> {
    const dayKey = tehranDayKey(now);

    return this.runJob(
      {
        messageType: 'DAILY_REPORT',
        idempotencyKey: [
          'DAILY_REPORT',
          dayKey,
          this.publisher.destinationKey,
        ].join('|'),
        subjects: [],
        reportingDate: dayKey,
        variant: null,
        scheduledAt: now.toISOString(),
      },
      now,
    );
  }

  /**
   * Publish one editorial content item immediately (admin action) or when its schedule is due.
   * The approval is re-checked *inside* the execution, never only when the job was created (§7).
   */
  async publishContent(
    contentId: string,
    now = new Date(),
  ): Promise<PublicationOutcome> {
    const content = this.store.findContent(contentId);

    if (!content) {
      return this.skipOutcome('EDUCATIONAL', 'CONTENT_NOT_PUBLISHABLE');
    }

    const scheduledAt = content.scheduledAt ?? now.toISOString();
    // Logical identity of an editorial publication is exactly (content, revision, destinations) —
    // §12. The scheduled time is deliberately *not* part of it: publishing the same revision by hand
    // after a scheduled job already delivered it must be detected as a duplicate, not sent again.
    const idempotencyKey = [
      content.messageType,
      content.id,
      `r${content.revision}`,
      this.publisher.destinationKey,
    ].join('|');

    return this.runJob(
      {
        messageType: content.messageType,
        idempotencyKey,
        subjects: [],
        reportingDate: content.reportingDate ?? tehranDayKey(now),
        variant: null,
        scheduledAt,
        contentId: content.id,
        contentRevision: content.revision,
      },
      now,
    );
  }

  /** All editorial items that are due right now (scheduler tick, §7). */
  async publishDueContent(now = new Date()): Promise<PublicationOutcome[]> {
    const due = this.store.listDueContents(now);
    const outcomes: PublicationOutcome[] = [];
    const graceMs = this.config.channelMissedJobGraceMs;

    for (const content of due) {
      const scheduledAt = content.scheduledAt;

      if (
        scheduledAt !== null &&
        now.getTime() - Date.parse(scheduledAt) > graceMs
      ) {
        // Too late to be useful for its reporting date: recorded, never silently dropped (§11).
        await this.markContentMissed(content, now);
        outcomes.push(this.skipOutcome(content.messageType, 'MISSED_WINDOW'));
        continue;
      }

      outcomes.push(await this.publishContent(content.id, now));
    }

    return outcomes;
  }

  // --- scheduling tick ---------------------------------------------------------

  /**
   * One scheduler tick per minute (§11, §24).
   *
   * It exists instead of one cron per configurable time because the publication times are
   * configuration values, not decorators: a single deterministic tick compares the configured
   * `HH:MM` (Asia/Tehran) with the current minute and relies on the persisted idempotency key for
   * "exactly one publication per reporting day". `@nestjs/schedule` executes a named cron at most
   * once per minute, so no overlap is possible inside the process.
   */
  @Cron('5 * * * * *', {
    name: 'channel-engine-tick',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async schedulerTick(): Promise<void> {
    const now = new Date();

    try {
      const due = await this.publishDueContent(now);

      for (const outcome of due) {
        if (outcome.status !== 'PUBLISHED') {
          this.logger.debug(
            `Tick: content publication ${outcome.status} (${outcome.skipReason ?? 'no reason'}).`,
          );
        }
      }

      if (
        this.config.channelDailyRangeEnabled &&
        tehranHourMinute(now) === this.config.channelDailyRangeTime
      ) {
        await this.publishDailyRange(now, 'scheduled');
      }

      if (
        this.config.channelDailyReportEnabled &&
        tehranHourMinute(now) === this.config.channelDailyReportTime
      ) {
        await this.publishDailyReport(now);
      }

      if (this.policy.rangeEventsEnabled) {
        await this.policy.recordRangeBaseline(
          this.intelligence.build(now),
          now,
        );
      }
    } catch (error) {
      // A tick must never crash the process; the next tick retries the same logical work.
      this.logger.error(
        `Channel scheduler tick failed: ${describeError(error)}`,
      );
    }
  }

  // --- job execution -----------------------------------------------------------

  private async runJob(
    input: {
      messageType: MessageType;
      idempotencyKey: string;
      subjects: string[];
      reportingDate: string | null;
      variant: PriceUpdateVariant | null;
      scheduledAt: string | null;
      contentId?: string;
      contentRevision?: number;
    },
    now: Date,
    inputs: ExecutionInputs = {},
  ): Promise<PublicationOutcome> {
    const created = await this.store.transact((tx) => {
      const existing = tx.findJobByIdempotencyKey(input.idempotencyKey);

      if (existing) {
        return { job: existing, isNew: false };
      }

      const job: PublicationJob = {
        id: this.nextId('pub'),
        messageType: input.messageType,
        status: 'PENDING',
        idempotencyKey: input.idempotencyKey,
        destinationKey: this.publisher.destinationKey,
        scheduledAt: input.scheduledAt,
        createdAt: now.toISOString(),
        startedAt: null,
        completedAt: null,
        contentId: input.contentId ?? null,
        contentRevision: input.contentRevision ?? null,
        reportingDate: input.reportingDate,
        subjects: input.subjects,
        variant: input.variant,
        attemptCount: 0,
        lastError: null,
        skipReason: null,
      };

      tx.saveJob(job);

      if (input.contentId) {
        const content = tx.findContent(input.contentId);

        if (content) {
          tx.saveContent({
            ...content,
            lastJobId: job.id,
            updatedAt: now.toISOString(),
          });
        }
      }

      return { job, isNew: true };
    });

    if (!created.isNew) {
      this.logger.log(
        `Duplicate publication prevented: ${input.messageType} ` +
          `(key ${input.idempotencyKey}) already exists as ${created.job.id} ` +
          `[${created.job.status}].`,
      );

      if (created.job.status === 'PUBLISHED') {
        return this.outcomeOf(created.job, 'DUPLICATE_PUBLICATION');
      }

      if (
        created.job.status === 'PENDING' ||
        created.job.status === 'FAILED' ||
        // A skipped attempt delivered nothing (no destination is ever recorded as SENT without a
        // real send), so it stays retryable under the *same* logical identity — which is what makes
        // "approve after a failed attempt, then publish" work without weakening the duplicate guard
        // for a message that was really delivered (§12, §19).
        created.job.status === 'SKIPPED'
      ) {
        return this.execute(created.job.id, now, inputs);
      }

      return this.outcomeOf(created.job, created.job.skipReason);
    }

    return this.execute(created.job.id, now, inputs);
  }

  /** Execute (or resume) a job. Delivery is per destination and never merged across platforms. */
  async execute(
    jobId: string,
    now: Date,
    inputs: ExecutionInputs = {},
  ): Promise<PublicationOutcome> {
    const claim = await this.store.transact((tx) => {
      const job = tx.findJob(jobId);

      if (!job) {
        return null;
      }

      if (job.status === 'PUBLISHED') {
        return {
          job,
          claimed: false as const,
          reason: 'DUPLICATE_PUBLICATION' as SkipReason,
        };
      }

      if (job.status === 'PUBLISHING') {
        return {
          job,
          claimed: false as const,
          reason: 'DUPLICATE_PUBLICATION' as SkipReason,
        };
      }

      const claimed: PublicationJob = {
        ...job,
        status: 'PUBLISHING',
        startedAt: job.startedAt ?? now.toISOString(),
        attemptCount: job.attemptCount + 1,
        skipReason: null,
      };

      tx.saveJob(claimed);

      return { job: claimed, claimed: true as const, reason: null };
    });

    if (!claim) {
      return this.skipOutcome('PRICE_UPDATE', 'CONTENT_NOT_PUBLISHABLE', jobId);
    }

    if (!claim.claimed) {
      this.logger.log(
        `Publication ${jobId} is not executable (${claim.reason}) — skipping without a new attempt.`,
      );

      return this.outcomeOf(claim.job, claim.reason);
    }

    const job = claim.job;

    try {
      const decision = await this.decide(job, now, inputs);

      if (!decision.ok) {
        const finished = await this.finish(job.id, 'SKIPPED', {
          skipReason: decision.reason,
          lastError: decision.detail ?? null,
          completedAt: now.toISOString(),
        });

        this.logger.warn(
          `Publication ${job.id} (${job.messageType}) skipped: ${decision.reason}` +
            (decision.detail ? ` — ${decision.detail}` : ''),
        );

        return this.outcomeOf(finished, decision.reason);
      }

      const deliveryOutcomes = await this.deliverAll(
        job,
        decision.payload,
        now,
      );
      const sent = deliveryOutcomes.filter(
        (delivery) => delivery.status === 'SENT',
      );
      const unknown = deliveryOutcomes.filter(
        (delivery) => delivery.status === 'UNKNOWN',
      );
      const status: PublicationStatus =
        sent.length > 0 ? 'PUBLISHED' : 'FAILED';
      const lastError =
        sent.length > 0
          ? null
          : unknown.length > 0
            ? `DELIVERY_OUTCOME_UNKNOWN: ${unknown
                .map((delivery) => `${delivery.platform}`)
                .join(', ')}`
            : (deliveryOutcomes[0]?.lastError ?? 'ALL_DESTINATIONS_FAILED');

      const finished = await this.finish(job.id, status, {
        skipReason: null,
        lastError,
        completedAt: new Date().toISOString(),
      });

      if (status === 'PUBLISHED') {
        await this.afterSuccess(job, now);
        this.logger.log(
          `✅ Publication ${job.id} (${job.messageType}) delivered to ` +
            `${sent.map((delivery) => delivery.platform).join(', ')}` +
            (deliveryOutcomes.length > sent.length
              ? ` | not delivered to ${deliveryOutcomes
                  .filter((delivery) => delivery.status !== 'SENT')
                  .map((delivery) => `${delivery.platform}:${delivery.status}`)
                  .join(', ')}`
              : ''),
        );
      } else {
        this.logger.error(
          `❌ Publication ${job.id} (${job.messageType}) was NOT delivered: ${lastError}`,
        );
      }

      return {
        jobId: finished.id,
        messageType: finished.messageType,
        status: finished.status,
        skipReason: null,
        deliveries: deliveryOutcomes,
      };
    } catch (error) {
      // An unexpected failure never leaves the job stuck in PUBLISHING and is never reported as
      // success (§28: no false-success logging).
      const message = describeError(error);
      const failed = await this.finish(job.id, 'FAILED', {
        skipReason: null,
        lastError: message,
        completedAt: now.toISOString(),
      });

      await this.markContentFailed(job, message, now);
      this.logger.error(
        `Publication ${job.id} failed unexpectedly: ${message}`,
      );

      return this.outcomeOf(failed, null);
    }
  }

  // --- eligibility + rendering -------------------------------------------------

  private async decide(
    job: PublicationJob,
    now: Date,
    inputs: ExecutionInputs,
  ): Promise<
    | { ok: true; payload: PublicationPayload }
    | { ok: false; reason: SkipReason; detail?: string }
  > {
    if (isEditorialType(job.messageType)) {
      return Promise.resolve(this.decideEditorial(job, now));
    }

    const snapshot = this.intelligence.build(now);
    const gate = this.policy.evaluateMarketGate(job.messageType, snapshot);

    if (!gate.ok) {
      return { ok: false, reason: gate.reason ?? 'INVALID_MARKET_SNAPSHOT' };
    }

    // A scheduled market job that lost its reporting day is obsolete, never replayed (§11).
    if (
      job.reportingDate !== null &&
      job.reportingDate !== tehranDayKey(now) &&
      job.messageType !== 'PRICE_UPDATE'
    ) {
      return {
        ok: false,
        reason: 'MISSED_WINDOW',
        detail: `reporting date ${job.reportingDate} is not today`,
      };
    }

    return this.renderMarket(job, snapshot, now, inputs);
  }

  private renderMarket(
    job: PublicationJob,
    snapshot: MarketIntelligenceSnapshot,
    now: Date,
    inputs: ExecutionInputs,
  ):
    | { ok: true; payload: PublicationPayload }
    | { ok: false; reason: SkipReason; detail?: string } {
    const displayUnit = this.config.displayUnit;

    switch (job.messageType) {
      case 'PRICE_UPDATE': {
        const update = inputs.priceUpdate;

        if (!update || !update.publishable || update.prices.length === 0) {
          // Without the Phase 1 publishable update there is nothing that may be published — a
          // price message is never re-rendered from a persisted copy (§23).
          return {
            ok: false,
            reason: 'INVALID_MARKET_SNAPSHOT',
            detail: 'no publishable market update available for this execution',
          };
        }

        const text =
          job.variant === 'poster'
            ? this.posterService.generatePricePoster(update)
            : this.priceMessageBuilder.build(update);

        return {
          ok: true,
          payload: this.payloadOf(job, text, null, {
            reportingDate: update.dayKey,
            symbols: update.prices.map((price) => price.symbol),
            variant: job.variant,
            contentRevision: null,
          }),
        };
      }

      case 'MARKET_MOVEMENT': {
        const candidates = inputs.movement ?? [];

        if (candidates.length === 0) {
          return {
            ok: false,
            reason: 'MOVEMENT_BELOW_THRESHOLD',
            detail: 'no movement candidates for this execution',
          };
        }

        return {
          ok: true,
          payload: this.payloadOf(
            job,
            formatMovementMessage(candidates, now, displayUnit),
            null,
            {
              reportingDate: job.reportingDate,
              symbols: candidates.map((candidate) => candidate.symbol),
              variant: null,
              contentRevision: null,
            },
          ),
        };
      }

      case 'DAILY_RANGE': {
        const candidates = inputs.range ?? [];
        const withRange = snapshot.symbols.filter(
          (symbol) => symbol.high !== null && symbol.low !== null,
        );

        if (withRange.length === 0) {
          return { ok: false, reason: 'INVALID_DAILY_STATISTICS' };
        }

        return {
          ok: true,
          payload: this.payloadOf(
            job,
            formatDailyRangeMessage({
              snapshot,
              mode: candidates.length > 0 ? 'event' : 'scheduled',
              candidates,
              now,
              displayUnit,
            }),
            null,
            {
              reportingDate: job.reportingDate,
              symbols: withRange.map((symbol) => symbol.symbol),
              variant: null,
              contentRevision: null,
            },
          ),
        };
      }

      case 'DAILY_REPORT': {
        return {
          ok: true,
          payload: this.payloadOf(
            job,
            formatDailyReportMessage(snapshot, now, displayUnit),
            null,
            {
              reportingDate: job.reportingDate,
              symbols: snapshot.symbols.map((symbol) => symbol.symbol),
              variant: null,
              contentRevision: null,
            },
          ),
        };
      }

      case 'EDUCATIONAL':
      case 'BRANDED':
      case 'NIGHTLY_ANALYSIS': {
        // Editorial types are routed to `decideEditorial` before this point; reaching the market
        // renderer with one of them is a programming error, never a silent fallback (§27.1).
        throw new Error(
          `Market renderer called for editorial type ${job.messageType} — routing bug.`,
        );
      }

      default: {
        // Exhaustiveness: a registered market type without a formatter must fail loudly instead of
        // silently falling back to an unrelated renderer (§27.1).
        const unreachable: never = job.messageType;
        throw new Error(
          `No market formatter registered for ${String(unreachable)}`,
        );
      }
    }
  }

  private decideEditorial(
    job: PublicationJob,
    now: Date,
  ):
    | { ok: true; payload: PublicationPayload }
    | { ok: false; reason: SkipReason; detail?: string } {
    const content =
      job.contentId === null ? null : this.store.findContent(job.contentId);

    if (!content) {
      return {
        ok: false,
        reason: 'CONTENT_NOT_PUBLISHABLE',
        detail: 'content not found',
      };
    }

    return this.decideEditorialContent(job, content, now);
  }

  /** Approval is re-validated at execution time (§7, §19). */
  private decideEditorialContent(
    job: PublicationJob,
    content: ContentItem,
    now: Date,
  ):
    | { ok: true; payload: PublicationPayload }
    | { ok: false; reason: SkipReason; detail?: string } {
    if (content.status === 'CANCELLED') {
      return { ok: false, reason: 'PUBLICATION_CANCELLED' };
    }

    if (content.revision !== job.contentRevision) {
      // Material edit after approval: the previous approval no longer applies (§19).
      return {
        ok: false,
        reason: 'CONTENT_NOT_APPROVED',
        detail: `content revision changed (${job.contentRevision} → ${content.revision}); re-approval required`,
      };
    }

    if (content.status === 'DRAFT') {
      return {
        ok: false,
        reason: 'CONTENT_NOT_APPROVED',
        detail: 'content is still a draft',
      };
    }

    if (content.approvedAt === null) {
      return {
        ok: false,
        reason: 'CONTENT_NOT_APPROVED',
        detail: 'content was never approved',
      };
    }

    if (
      content.messageType === 'NIGHTLY_ANALYSIS' &&
      content.reportingDate !== null &&
      content.reportingDate !== tehranDayKey(now)
    ) {
      // A nightly analysis must never be published on the wrong reporting date (§5.7, §11).
      return {
        ok: false,
        reason: 'MISSED_WINDOW',
        detail: `reporting date ${content.reportingDate} is not today`,
      };
    }

    const snapshot = this.intelligence.build(now);

    const text =
      content.messageType === 'NIGHTLY_ANALYSIS'
        ? formatNightlyAnalysisMessage(
            content,
            snapshot,
            this.config.displayUnit,
          )
        : content.messageType === 'BRANDED'
          ? formatBrandedMessage(content)
          : formatEditorialMessage(content);

    return {
      ok: true,
      payload: this.payloadOf(
        job,
        text,
        content.mediaUrl === null ? null : { url: content.mediaUrl },
        {
          reportingDate: content.reportingDate,
          symbols: content.includeMarketData
            ? snapshot.symbols
                .filter((symbol) => symbol.currentPrice !== null)
                .map((symbol) => symbol.symbol)
            : [],
          variant: null,
          contentRevision: content.revision,
        },
      ),
    };
  }

  private payloadOf(
    job: PublicationJob,
    text: string,
    media: PublicationPayload['media'],
    meta: PublicationPayload['meta'],
  ): PublicationPayload {
    this.logger.debug(
      `Rendered ${formatterNameFor(job.messageType)} for ${job.id} ` +
        `(${text.length} chars, media ${media ? 'yes' : 'no'}).`,
    );

    const cta = this.ctaPolicy.decide({
      messageType: job.messageType,
      subjects: job.subjects,
      content: job.contentId ? this.store.findContent(job.contentId) : null,
    });

    return {
      publicationId: job.id,
      messageType: job.messageType,
      text,
      parseMode: 'HTML',
      // Phase 6: only the *intent* travels in the payload; the publisher turns it into the correct
      // platform-specific URL (or omits it when that platform has no public bot username, §7 rule 8).
      cta,
      media,
      destinationKey: this.publisher.destinationKey,
      meta,
    };
  }

  // --- delivery ----------------------------------------------------------------

  /**
   * Deliver to every destination independently (§8, §13): one platform failing never blocks the
   * other, and each destination keeps its own status, attempt count and error.
   */
  private async deliverAll(
    job: PublicationJob,
    payload: PublicationPayload,
    now: Date,
  ): Promise<PublicationDelivery[]> {
    const destinations = this.publisher.destinations;

    if (destinations.length === 0) {
      this.logger.error(
        `No destination is configured — publication ${job.id} cannot be delivered.`,
      );

      return [];
    }

    const results = await Promise.all(
      destinations.map((destination) =>
        this.deliverTo(job, destination, payload, now),
      ),
    );

    return results;
  }

  private async deliverTo(
    job: PublicationJob,
    destination: ChannelDestination,
    payload: PublicationPayload,
    now: Date,
  ): Promise<PublicationDelivery> {
    const existing = this.store
      .listDeliveries(job.id)
      .find(
        (delivery) =>
          delivery.platform === destination.platform &&
          delivery.destination === destination.destination,
      );

    // A destination that is already confirmed SENT is never sent again — not even after a restart.
    if (existing && existing.status === 'SENT') {
      this.logger.log(
        `Destination ${destination.platform} already delivered for ${job.id} — not repeated.`,
      );

      return existing;
    }

    // An ambiguous outcome is never retried automatically (it may already be delivered, §13).
    if (existing && existing.status === 'UNKNOWN') {
      this.logger.warn(
        `Destination ${destination.platform} of ${job.id} has an ambiguous outcome — ` +
          'not retried automatically.',
      );

      return existing;
    }

    const maxAttempts = this.config.channelPublicationMaxAttempts;
    const baseDelay = this.config.channelPublicationRetryDelayMs;
    // Phase 6 — the CTA decision is recorded with the delivery so an operator can see *which* button
    // (if any) went out with which message, without re-deriving the policy later.
    const ctaRoute = payload.cta?.route ?? null;
    let record: PublicationDelivery = existing ?? {
      id: this.nextId('dlv'),
      publicationJobId: job.id,
      platform: destination.platform,
      destination: destination.destination,
      status: 'PENDING',
      attemptCount: 0,
      failureCategory: null,
      externalMessageId: null,
      mediaMessageId: null,
      mediaStatus: 'NOT_ATTACHED',
      mediaError: null,
      createdAt: now.toISOString(),
      sentAt: null,
      lastAttemptAt: null,
      lastError: null,
    };

    await this.saveDelivery({ ...record, status: 'SENDING' });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.publisher.publish(destination, payload);

      record = {
        ...record,
        status: outcome.status,
        attemptCount: record.attemptCount + 1,
        failureCategory: outcome.failureKind,
        // `ctaRoute` is `null` when the button could not be built for this platform (§7 rule 8).
        ctaRoute: outcome.status === 'SENT' ? outcome.ctaRoute : ctaRoute,
        externalMessageId: outcome.messageId,
        mediaMessageId: outcome.mediaMessageId,
        mediaStatus: outcome.mediaStatus,
        mediaError: outcome.mediaError,
        lastAttemptAt: new Date().toISOString(),
        sentAt: outcome.status === 'SENT' ? new Date().toISOString() : null,
        lastError: outcome.error ?? outcome.mediaError,
      };

      await this.saveDelivery(record);

      if (outcome.status !== 'FAILED' || outcome.failureKind !== 'RETRYABLE') {
        // SENT, UNKNOWN or a permanent failure: no further attempt for this destination.
        if (outcome.mediaError && outcome.status === 'SENT') {
          this.logger.warn(
            `Media for ${job.id} failed on ${destination.platform}: ${outcome.mediaError}`,
          );
        }

        return record;
      }

      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        this.logger.warn(
          `Retrying ${job.id} on ${destination.platform} in ${delay}ms ` +
            `(attempt ${attempt + 1}/${maxAttempts}): ${outcome.error ?? 'unknown error'}`,
        );

        await this.sleep(delay);
      }
    }

    this.logger.error(
      `Destination ${destination.platform} of ${job.id} permanently failed after ` +
        `${record.attemptCount} attempt(s): ${record.lastError ?? 'unknown error'}`,
    );

    return record;
  }

  private async saveDelivery(delivery: PublicationDelivery): Promise<void> {
    await this.store.transact((tx) => {
      tx.saveDelivery(delivery);
    });
  }

  // --- state transitions -------------------------------------------------------

  private async finish(
    jobId: string,
    status: PublicationStatus,
    patch: {
      skipReason: SkipReason | null;
      lastError: string | null;
      completedAt: string;
    },
  ): Promise<PublicationJob> {
    return this.store.transact((tx) => {
      const job = tx.findJob(jobId);

      if (!job) {
        throw new Error(
          `Publication job ${jobId} disappeared during execution.`,
        );
      }

      const finished: PublicationJob = {
        ...job,
        status,
        skipReason: patch.skipReason,
        lastError: patch.lastError,
        completedAt: patch.completedAt,
      };

      tx.saveJob(finished);

      return finished;
    });
  }

  private async afterSuccess(job: PublicationJob, now: Date): Promise<void> {
    if (job.contentId === null) {
      return;
    }

    await this.store.transact((tx) => {
      const content = tx.findContent(job.contentId as string);

      if (!content) {
        return;
      }

      tx.saveContent({
        ...content,
        status: 'PUBLISHED',
        lastJobId: job.id,
        lastError: null,
        updatedAt: now.toISOString(),
      });
    });
  }

  private async markContentFailed(
    job: PublicationJob,
    error: string,
    now: Date,
  ): Promise<void> {
    if (job.contentId === null) {
      return;
    }

    await this.store.transact((tx) => {
      const content = tx.findContent(job.contentId as string);

      if (!content) {
        return;
      }

      tx.saveContent({
        ...content,
        status: 'FAILED',
        lastError: error,
        updatedAt: now.toISOString(),
      });
    });
  }

  private async markContentMissed(
    content: ContentItem,
    now: Date,
  ): Promise<void> {
    await this.store.transact((tx) => {
      const current = tx.findContent(content.id);

      if (!current || current.status !== 'SCHEDULED') {
        return;
      }

      tx.saveContent({
        ...current,
        status: 'FAILED',
        lastError:
          'MISSED_WINDOW: the scheduled time passed while the service was down',
        updatedAt: now.toISOString(),
      });
    });

    this.logger.warn(
      `Scheduled content ${content.id} (${content.messageType}) missed its window ` +
        `(${content.scheduledAt ?? 'no time'}) — marked as missed, not published.`,
    );
  }

  // --- recovery (§11, §23) -----------------------------------------------------

  /**
   * Restart recovery.
   *
   * Jobs interrupted mid-flight are resolved from their delivery records — a delivery that was
   * already confirmed as SENT is never repeated — and obsolete market messages are skipped instead
   * of being replayed. Nothing is published here: recovery only records the truth.
   */
  async recover(now = new Date()): Promise<void> {
    const interrupted = this.store.listInterruptedJobs();

    for (const job of interrupted) {
      const deliveries = this.store.listDeliveries(job.id);
      const sent = deliveries.filter((delivery) => delivery.status === 'SENT');
      const unknown = deliveries.filter(
        (delivery) => delivery.status === 'UNKNOWN',
      );

      if (sent.length > 0) {
        await this.finish(job.id, 'PUBLISHED', {
          skipReason: null,
          lastError: null,
          completedAt: now.toISOString(),
        });
        this.logger.warn(
          `Recovered publication ${job.id}: ${sent.length} destination(s) had already ` +
            'delivered — recorded as PUBLISHED, nothing re-sent.',
        );
        continue;
      }

      if (unknown.length > 0) {
        await this.finish(job.id, 'FAILED', {
          skipReason: null,
          lastError: `DELIVERY_OUTCOME_UNKNOWN: ${unknown
            .map((delivery) => delivery.platform)
            .join(', ')}`,
          completedAt: now.toISOString(),
        });
        this.logger.error(
          `Recovered publication ${job.id}: delivery outcome was ambiguous — recorded as ` +
            'FAILED/UNKNOWN and NOT retried automatically.',
        );
        continue;
      }

      // No destination confirmed anything: the message was interrupted before/while sending.
      await this.finish(job.id, 'SKIPPED', {
        skipReason: 'MISSED_WINDOW',
        lastError: 'interrupted by a restart before any delivery was confirmed',
        completedAt: now.toISOString(),
      });

      await this.markContentFailed(
        job,
        'interrupted by a restart before any delivery was confirmed',
        now,
      );
      this.logger.warn(
        `Publication ${job.id} (${job.messageType}) was interrupted before delivery — ` +
          'skipped, never replayed automatically.',
      );
    }

    // Scheduled editorial content that is still waiting stays scheduled; the tick publishes it if
    // it is still within its window, and marks it as missed otherwise.
    const pendingContent = this.store
      .listContents()
      .filter((content) => content.status === 'SCHEDULED');

    if (pendingContent.length > 0) {
      this.logger.log(
        `${pendingContent.length} scheduled content item(s) restored — ` +
          'their window is evaluated on the next tick.',
      );
    }

    const pendingJobs = this.store
      .listJobs()
      .filter((job) => job.status === 'PENDING');

    for (const job of pendingJobs) {
      await this.finish(job.id, 'SKIPPED', {
        skipReason: 'MISSED_WINDOW',
        lastError: 'never executed before the restart',
        completedAt: now.toISOString(),
      });
    }

    if (pendingJobs.length > 0) {
      this.logger.warn(
        `${pendingJobs.length} pending publication job(s) from a previous run were marked as ` +
          'skipped — no backlog of obsolete market messages is replayed.',
      );
    }
  }

  /** Enabled destinations — used by the scheduling service for its startup log. */
  get destinations(): readonly ChannelDestination[] {
    return this.publisher.destinations;
  }

  /** True when event-driven daily high/low messages are enabled (§18). */
  get rangeEventsEnabled(): boolean {
    return this.policy.rangeEventsEnabled;
  }

  // --- introspection -----------------------------------------------------------

  /** Publication history (newest last), for operations and tests. */
  history(limit = 50): PublicationJob[] {
    const jobs = this.store.listJobs();

    return jobs.slice(Math.max(0, jobs.length - limit));
  }

  deliveriesOf(jobId: string): PublicationDelivery[] {
    return this.store.listDeliveries(jobId);
  }

  findJob(jobId: string): PublicationJob | null {
    return this.store.findJob(jobId);
  }

  get storeReadyPath(): string | null {
    return this.store.path;
  }

  // --- helpers -----------------------------------------------------------------

  private skipOutcome(
    messageType: MessageType,
    reason: SkipReason,
    jobId = '',
  ): PublicationOutcome {
    return {
      jobId,
      messageType,
      status: 'SKIPPED',
      skipReason: reason,
      deliveries: [],
    };
  }

  private outcomeOf(
    job: PublicationJob,
    reason: SkipReason | null,
    status?: PublicationStatus,
  ): PublicationOutcome {
    return {
      jobId: job.id,
      messageType: job.messageType,
      status: status ?? job.status,
      skipReason: reason ?? job.skipReason,
      deliveries: this.store.listDeliveries(job.id),
    };
  }

  private nextId(prefix: ChannelEntityPrefix): string {
    return createChannelId(prefix);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

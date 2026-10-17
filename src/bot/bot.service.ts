import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ChannelEngineService } from '../channel/channel-engine.service';
import { PublicationOutcome } from '../channel/channel.types';
import { describeError } from '../common/log-safety';
import { TEHRAN_TIME_ZONE } from '../common/tehran-time';
import { MarketEngineService } from '../market/market-engine.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { PublishableMarketUpdate } from '../market/market.types';
import { PriceService } from '../price/price.service';

/**
 * Scheduling and publication orchestration.
 *
 * Phase 1: prices are never published directly from the API. Every job runs the market
 * reliability pipeline first (`MarketEngineService`), and only a `publishable` update — built
 * exclusively from accepted, validated prices — reaches the publishers.
 *
 * Phase 0 guarantees kept: Asia/Tehran schedules, one in-flight publication at a time,
 * truthful delivery reporting, no publication after a failed fetch.
 *
 * Phase 5: this service no longer renders or sends anything itself. It keeps the market pipeline and
 * the three original schedules, and hands every publication to the Channel Engine, which owns
 * identity, approval, duplicate prevention, retries and delivery records (§9–§14).
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly priceService: PriceService,
    private readonly marketEngine: MarketEngineService,
    private readonly channelEngine: ChannelEngineService,
    /**
     * Phase 11 — this service is a *signal producer* only: it reports what the cycle actually did
     * (fetch failure, rejected payload, publishable data, per-destination delivery) and never
     * decides severity, retries or resolution itself.
     */
    private readonly monitoring: MonitoringService,
  ) {}

  onModuleInit(): void {
    const destinations = this.channelEngine.destinations
      .map((destination) => destination.platform)
      .join(', ');

    this.logger.log(
      `Scheduled jobs (${TEHRAN_TIME_ZONE}): price update — every 30 min 08:00→21:30; ` +
        'daily closing price — 22:00; poster report — 12:15, 16:15, 19:15 ' +
        `(channel destinations: ${destinations || 'none'})`,
    );
  }

  /** Price update every 30 minutes between 08:00 and 21:30 (Asia/Tehran). */
  @Cron('0 0,30 8-21 * * *', {
    name: 'price-update-half-hourly',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handleHalfHourlyPriceUpdate(): Promise<void> {
    await this.runCycle('Price update (half-hourly)', 'full');
  }

  /** Last price message of the day at 22:00 (Asia/Tehran). */
  @Cron('0 0 22 * * *', {
    name: 'price-update-daily-closing',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handleDailyClosingPriceUpdate(): Promise<void> {
    await this.runCycle('Price update (daily closing)', 'full');
  }

  /**
   * Poster report three times a day at 12:15, 16:15 and 19:15 (moved in Phase 0 so it no longer
   * shares a minute with the half-hourly price update).
   */
  @Cron('15 12,16,19 * * *', {
    name: 'poster-report',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handlePosterReport(): Promise<void> {
    await this.runCycle('Poster report', 'poster');
  }

  /**
   * Runs the reliability pipeline and publishes only an approved update.
   *
   * `variant: 'full' | 'poster'` decides how the approved data is rendered — the validation path is
   * identical for both, and both go through the same Channel Engine job identity, so the same minute
   * can never be published twice (§12).
   */
  private async runCycle(
    job: string,
    variant: 'full' | 'poster',
  ): Promise<void> {
    // Phase 11 — the cycle is a monitored job: its start, end and duration are recorded so a job
    // that stops running can be detected from evidence instead of from its silence (§9.1).
    await this.monitoring.recordJobStart({
      name: 'market-price-cycle',
      expectedIntervalMs: 30 * 60_000,
      graceMs: 10 * 60_000,
    });

    try {
      const fetch = await this.priceService.fetchRawPayload();
      const now = new Date(fetch.receivedAt);
      const { update, staleSymbols } = await this.marketEngine.evaluateCycle(
        fetch.payload,
        now,
      );

      this.reportCycle(job, update, staleSymbols.length);

      if (!update.publishable) {
        // A transport success that produced nothing usable is *not* a healthy cycle (§5.1).
        await this.monitoring.onPriceCycleFailure({
          reasonCode: update.blockingReason ?? 'NO_PUBLISHABLE_PRICES',
          error: `no publishable prices (${update.blockingReason ?? 'unknown reason'})`,
          transport: false,
          at: now,
        });
        await this.monitoring.recordJobEnd({
          name: 'market-price-cycle',
          ok: false,
          error: `no publishable prices (${update.blockingReason ?? 'unknown reason'})`,
          at: now,
        });

        this.logger.error(
          `❌ ${job}: no publishable prices (${update.blockingReason ?? 'unknown reason'}) — ` +
            'nothing was published.',
        );
        return;
      }

      // Valid, usable market data: the only evidence that recovers the price/staleness watches.
      await this.monitoring.onPriceCycleSuccess(now);

      const outcome = await this.channelEngine.publishPriceUpdate(
        update,
        variant,
        now,
      );
      this.reportOutcome(job, outcome);
      await this.reportDeliveries(outcome, now);

      // Movement/range events reuse this cycle: no additional provider call is made, and the
      // policy decides whether a fresh threshold crossing really is news (§17, §18).
      await this.publishMarketEvents(now);

      await this.monitoring.recordJobEnd({
        name: 'market-price-cycle',
        ok: true,
        at: now,
      });
    } catch (error) {
      // Fetch failures, schema failures and unexpected errors land here: no publication, no
      // success log, market state untouched (a rejected price never reaches it).
      this.logger.error(`❌ ${job} failed: ${describeError(error)}`);

      await this.monitoring.onPriceCycleFailure({
        reasonCode: 'CYCLE_THREW',
        error: describeError(error),
        transport: true,
      });
      await this.monitoring.recordJobEnd({
        name: 'market-price-cycle',
        ok: false,
        error: describeError(error),
      });
    }
  }

  /**
   * Phase 11 — report each destination's real outcome.
   *
   * `SENT` means the platform accepted the message; `UNKNOWN` (an ambiguous call) is reported as a
   * delivery *failure* with the ambiguous classification, so the monitor never counts it as success
   * (§6.1) and never retries it on its own.
   */
  private async reportDeliveries(
    outcome: PublicationOutcome,
    at: Date,
  ): Promise<void> {
    for (const delivery of outcome.deliveries) {
      await this.monitoring.onDelivery({
        platform: delivery.platform,
        destination: 'channel',
        target: delivery.destination,
        operation: 'channel-publication',
        ok: delivery.status === 'SENT',
        error: delivery.lastError,
        failureKind: delivery.failureCategory,
        at,
      });
    }

    if (outcome.deliveries.length === 0) {
      return;
    }

    const sent = outcome.deliveries.filter(
      (delivery) => delivery.status === 'SENT',
    ).length;

    await this.monitoring.onPublicationOutcome({
      sent,
      failed: outcome.deliveries.filter(
        (delivery) => delivery.status === 'FAILED',
      ).length,
      unknown: outcome.deliveries.filter(
        (delivery) => delivery.status === 'UNKNOWN',
      ).length,
      reason: outcome.skipReason,
      at,
    });
  }

  /**
   * Publish movement and daily-range events for the cycle that was just evaluated.
   * A failure here is isolated from the price message: the price publication is already recorded.
   */
  private async publishMarketEvents(now: Date): Promise<void> {
    try {
      for (const outcome of await this.channelEngine.publishMovementEvents(
        now,
      )) {
        this.reportOutcome('Market movement', outcome);
      }

      if (this.channelEngine.rangeEventsEnabled) {
        this.reportOutcome(
          'Daily range event',
          await this.channelEngine.publishDailyRange(now, 'event'),
        );
      }
    } catch (error) {
      this.logger.error(
        `Market event publication failed: ${describeError(error)}`,
      );
    }
  }

  private reportCycle(
    job: string,
    update: PublishableMarketUpdate,
    staleCount: number,
  ): void {
    const { accepted, rejected, publishable, blockingReason } = update;

    if (rejected.length > 0) {
      const summary = rejected
        .map(
          (evaluation) =>
            `${evaluation.symbol}:${evaluation.reason ?? 'UNKNOWN'}`,
        )
        .join(', ');
      this.logger.warn(
        `${job}: ${rejected.length} symbol(s) not published — ${summary}`,
      );
    }

    // The count is only called "approved for publication" when the cycle really is publishable;
    // a blocked cycle never reports success.
    const status = publishable
      ? `${accepted.length} validated price(s) approved for publication`
      : `${accepted.length} validated price(s) accepted but NOT published (` +
        `${blockingReason ?? 'unknown reason'})`;

    this.logger.log(
      `${job}: ${status}` +
        (staleCount > 0 ? `, ${staleCount} symbol(s) currently stale` : ''),
    );
  }

  /** Delivery is reported per destination — a Telegram failure never hides a Bale success (§8). */
  private reportOutcome(job: string, outcome: PublicationOutcome): void {
    if (outcome.deliveries.length === 0) {
      const reason = outcome.skipReason ?? outcome.status;
      const level = outcome.status === 'SKIPPED' ? 'warn' : 'error';

      if (level === 'warn') {
        this.logger.warn(`⚠️ ${job}: not published — ${reason}.`);
      } else {
        this.logger.error(`❌ ${job}: nothing was delivered — ${reason}.`);
      }
      return;
    }

    const sent = outcome.deliveries.filter(
      (delivery) => delivery.status === 'SENT',
    );
    const failed = outcome.deliveries.filter(
      (delivery) => delivery.status !== 'SENT',
    );

    if (failed.length === 0) {
      this.logger.log(
        `✅ ${job}: delivered to ${sent
          .map(
            (delivery) =>
              `${delivery.platform} (#${delivery.externalMessageId ?? '?'})`,
          )
          .join(', ')}.`,
      );
      return;
    }

    const details = failed
      .map(
        (delivery) =>
          `${delivery.platform}: ${delivery.status} — ${delivery.lastError ?? 'unknown error'}`,
      )
      .join(' | ');

    if (sent.length === 0) {
      this.logger.error(
        `❌ ${job}: delivery FAILED on every destination — ${details}`,
      );
      return;
    }

    this.logger.warn(
      `⚠️ ${job}: delivered to ${sent.map((delivery) => delivery.platform).join(', ')}, ` +
        `FAILED on ${details}`,
    );
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { BaleService } from '../bale/bale.service';
import { DeliveryResult, summarizeDelivery } from '../bale/delivery-result';
import { describeError } from '../common/log-safety';
import { TEHRAN_TIME_ZONE } from '../common/tehran-time';
import { MarketEngineService } from '../market/market-engine.service';
import { PublishableMarketUpdate } from '../market/market.types';
import { PosterService } from '../poster/poster.service';
import { PriceService } from '../price/price.service';
import { PriceMessageBuilder } from './price-message.builder';

/**
 * Scheduling and publication orchestration.
 *
 * Phase 1: prices are never published directly from the API. Every job runs the market
 * reliability pipeline first (`MarketEngineService`), and only a `publishable` update — built
 * exclusively from accepted, validated prices — reaches the publishers.
 *
 * Phase 0 guarantees kept: Asia/Tehran schedules, one in-flight publication at a time,
 * truthful delivery reporting, no publication after a failed fetch.
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  /** Name of the publication currently in flight, or `null`. */
  private publishing: string | null = null;

  constructor(
    private readonly priceService: PriceService,
    private readonly marketEngine: MarketEngineService,
    private readonly baleService: BaleService,
    private readonly posterService: PosterService,
    private readonly priceMessageBuilder: PriceMessageBuilder,
  ) {}

  onModuleInit(): void {
    this.logger.log(
      `Scheduled jobs (${TEHRAN_TIME_ZONE}): price update — every 30 min 08:00→21:30; ` +
        'daily closing price — 22:00; poster report — 12:15, 16:15, 19:15 ' +
        `(delivery targets: ${this.baleService.platforms.join(', ') || 'none'})`,
    );
  }

  /** Price update every 30 minutes between 08:00 and 21:30 (Asia/Tehran). */
  @Cron('0 0,30 8-21 * * *', {
    name: 'price-update-half-hourly',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handleHalfHourlyPriceUpdate(): Promise<void> {
    await this.runPublication('Price update (half-hourly)', 'channel-message');
  }

  /** Last price message of the day at 22:00 (Asia/Tehran). */
  @Cron('0 0 22 * * *', {
    name: 'price-update-daily-closing',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handleDailyClosingPriceUpdate(): Promise<void> {
    await this.runPublication(
      'Price update (daily closing)',
      'channel-message',
    );
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
    await this.runPublication('Poster report', 'poster');
  }

  /**
   * Runs the reliability pipeline and publishes only an approved update.
   * `source: 'channel-message' | 'poster'` decides how the approved data is rendered — the
   * validation path is identical for both.
   */
  private async runPublication(
    job: string,
    renderer: 'channel-message' | 'poster',
  ): Promise<void> {
    if (this.publishing !== null) {
      this.logger.warn(
        `Skipping "${job}": "${this.publishing}" is still in progress — no duplicate publication.`,
      );
      return;
    }

    this.publishing = job;

    try {
      const fetch = await this.priceService.fetchRawPayload();
      const { update, staleSymbols } = await this.marketEngine.evaluateCycle(
        fetch.payload,
        new Date(fetch.receivedAt),
      );

      this.reportCycle(job, update, staleSymbols.length);

      if (!update.publishable) {
        this.logger.error(
          `❌ ${job}: no publishable prices (${update.blockingReason ?? 'unknown reason'}) — ` +
            'nothing was published.',
        );
        return;
      }

      const text =
        renderer === 'poster'
          ? this.posterService.generatePricePoster(update)
          : this.priceMessageBuilder.build(update);

      const results = await this.baleService.sendMessage(text);
      this.reportDelivery(job, results);
    } catch (error) {
      // Fetch failures, schema failures and unexpected errors land here: no publication, no
      // success log, market state untouched (a rejected price never reaches it).
      this.logger.error(`❌ ${job} failed: ${describeError(error)}`);
    } finally {
      this.publishing = null;
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

  private reportDelivery(
    job: string,
    results: readonly DeliveryResult[],
  ): void {
    const summary = summarizeDelivery(results);

    if (summary.allFailed) {
      const details = results
        .map(
          (result) => `${result.platform}: ${result.error ?? 'unknown error'}`,
        )
        .join(' | ');
      this.logger.error(
        `❌ ${job}: delivery FAILED on every platform — ${details}`,
      );
      return;
    }

    if (summary.failed.length > 0) {
      this.logger.warn(
        `⚠️ ${job}: delivered to ${summary.succeeded.join(', ')}, ` +
          `FAILED on ${summary.failed.join(', ')}`,
      );
      return;
    }

    this.logger.log(`✅ ${job}: delivered to ${summary.succeeded.join(', ')}.`);
  }
}

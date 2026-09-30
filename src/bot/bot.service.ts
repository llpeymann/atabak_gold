import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { BaleService } from '../bale/bale.service';
import { DeliveryResult, summarizeDelivery } from '../bale/delivery-result';
import { describeError } from '../common/log-safety';
import {
  tehranDateFa,
  tehranDayKey,
  tehranTimeFa,
  TEHRAN_TIME_ZONE,
} from '../common/tehran-time';
import { PosterService } from '../poster/poster.service';
import { PriceService } from '../price/price.service';
import { PriceMessageBuilder } from './price-message.builder';
import { TrendTracker } from './trend-tracker';

/**
 * Scheduling and publication orchestration.
 *
 * Phase 0 behaviour:
 *  - every job publishes through `runPublication()`, which refuses to start a second
 *    publication while one is still running (no duplicated message from overlapping runs),
 *  - the price jobs and the poster job no longer share a minute (see the cron table below),
 *  - a failed price API call publishes nothing and logs an error — never a fake success,
 *  - the trend baseline is only advanced after a message was actually delivered somewhere.
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  /** Name of the publication currently in flight, or `null`. */
  private publishing: string | null = null;

  constructor(
    private readonly priceService: PriceService,
    private readonly baleService: BaleService,
    private readonly posterService: PosterService,
    private readonly priceMessageBuilder: PriceMessageBuilder,
    private readonly trends: TrendTracker,
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
    await this.runPriceUpdate('Price update (half-hourly)');
  }

  /** Last price message of the day at 22:00 (Asia/Tehran). */
  @Cron('0 0 22 * * *', {
    name: 'price-update-daily-closing',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handleDailyClosingPriceUpdate(): Promise<void> {
    await this.runPriceUpdate('Price update (daily closing)');
  }

  /**
   * Poster report three times a day at 12:15, 16:15 and 19:15.
   *
   * The report used to run at 12:00/16:00/19:00, i.e. in the exact same minute as the
   * half-hourly price update, which published two messages to the channel simultaneously.
   * The times were moved by 15 minutes — the business function itself is unchanged.
   */
  @Cron('15 12,16,19 * * *', {
    name: 'poster-report',
    timeZone: TEHRAN_TIME_ZONE,
  })
  async handlePosterReport(): Promise<void> {
    await this.runPosterReport('Poster report');
  }

  private async runPriceUpdate(job: string): Promise<void> {
    await this.runPublication(job, async () => {
      const marketData = await this.priceService.getMarketData();

      const now = new Date();
      const dayKey = tehranDayKey(now);

      if (this.trends.resetForNewDay(dayKey)) {
        this.logger.log(
          `New Tehran trading day (${dayKey}): trend baseline reset — the first message ` +
            'of the day is not compared with yesterday.',
        );
      }

      const message = this.priceMessageBuilder.build(marketData, {
        dayKey,
        dateFa: tehranDateFa(now),
        timeFa: tehranTimeFa(now),
      });

      const results = await this.baleService.sendMessage(message.text);

      // Only advance the trend baseline when the message actually reached a channel.
      if (summarizeDelivery(results).anySucceeded) {
        this.trends.commit(message.snapshot, dayKey);
      } else {
        this.logger.error(
          `${job}: nothing was delivered, trend baseline left unchanged.`,
        );
      }

      return results;
    });
  }

  private async runPosterReport(job: string): Promise<void> {
    await this.runPublication(job, async () => {
      const marketData = await this.priceService.getMarketData();
      const posterText = this.posterService.generatePricePoster(marketData);

      return this.baleService.sendMessage(posterText);
    });
  }

  /**
   * Single publication gate: guarantees a job is not started twice concurrently and that
   * delivery results are always reported truthfully.
   */
  private async runPublication(
    job: string,
    publish: () => Promise<DeliveryResult[]>,
  ): Promise<void> {
    if (this.publishing !== null) {
      this.logger.warn(
        `Skipping "${job}": "${this.publishing}" is still in progress — ` +
          'no duplicate publication.',
      );
      return;
    }

    this.publishing = job;

    try {
      const results = await publish();
      this.reportDelivery(job, results);
    } catch (error) {
      // Covers a failed price API call or any unexpected failure: no publication,
      // no success log.
      this.logger.error(`❌ ${job} failed: ${describeError(error)}`);
    } finally {
      this.publishing = null;
    }
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

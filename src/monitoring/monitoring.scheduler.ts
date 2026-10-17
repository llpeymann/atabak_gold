/**
 * Phase 11 — the monitoring heartbeat (§9.3, §12.2).
 *
 * One interval, two bounded jobs: re-evaluate conditions (staleness, missed runs) and drain the
 * notification outbox. It never runs a business job to “check” it, never fetches a price, and never
 * overlaps itself — a slow sweep is simply skipped, and the next tick continues where it stopped.
 *
 * The interval is configurable and validated at startup; `MONITORING_SWEEP_INTERVAL_SECONDS=0`
 * disables the heartbeat while leaving the rest of the subsystem usable from tests and admin
 * actions.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { MonitoringDispatchService } from './monitoring-dispatch.service';
import { MonitoringService } from './monitoring.service';

@Injectable()
export class MonitoringScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly monitoring: MonitoringService,
    private readonly dispatcher: MonitoringDispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.config.monitoringEnabled) {
      this.logger.warn(
        'Monitoring is disabled by configuration (MONITORING_ENABLED=false): no incidents will be ' +
          'detected. The admin surface reports this state explicitly.',
      );

      return;
    }

    const intervalMs = this.config.monitoringSweepIntervalMs;

    if (intervalMs <= 0) {
      this.logger.warn(
        'Monitoring sweep is disabled (MONITORING_SWEEP_INTERVAL_SECONDS=0): signals are still ' +
          'recorded, but staleness/missed-run detection and notification delivery need a tick.',
      );

      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    // Never keep the process alive only for the monitoring tick.
    this.timer.unref?.();

    this.logger.log(
      `Monitoring sweep every ${Math.round(intervalMs / 1000)}s.`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep. Public so tests and the admin surface can drive it deterministically. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.monitoring.enabled || this.sweeping) {
      return;
    }

    this.sweeping = true;

    try {
      await this.monitoring.sweep(now);
      await this.dispatcher.processDue(now);
    } catch (error) {
      // A failing sweep must not kill the interval; it is reported through the same pipeline.
      this.logger.error(`Monitoring sweep failed: ${describeError(error)}`);
      await this.monitoring.onApplicationError({
        service: 'MonitoringScheduler',
        operation: 'sweep',
        error: describeError(error),
        at: now,
      });
    } finally {
      this.sweeping = false;
    }
  }
}

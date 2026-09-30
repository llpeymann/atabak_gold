import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { describeError } from '../common/log-safety';
import { BotUxService } from '../bot/ux/bot-ux.service';
import { PlatformRegistry } from './platform-registry.service';
import { InboundUpdate, Platform } from './platform.types';

/**
 * Inbound update loop.
 *
 * Phase 2 needs a way to receive user interactions. The chosen approach is long polling —
 * no webhook endpoint, no public URL, no extra infrastructure, and no new dependency (§60).
 * One loop runs per configured platform; each loop:
 *
 *   1. asks the platform for updates after the last seen offset,
 *   2. hands them to the UX layer (which never throws for a bad update),
 *   3. advances the offset so the same update is never processed twice,
 *   4. on transport failure waits `BOT_POLL_RETRY_DELAY_MS` before retrying — no hot retry loop
 *      and no infinite tight loop of log spam (§43, §49).
 *
 * Polling is disabled in tests and can be disabled in production via `BOT_POLLING_ENABLED`.
 */
@Injectable()
export class UpdatePollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdatePollerService.name);
  private readonly offsets = new Map<Platform, number>();
  private readonly loops = new Map<Platform, Promise<void>>();
  /** Aborts an in-flight long poll during shutdown, so a deploy never hangs. */
  private readonly abortController = new AbortController();
  private stopping = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: PlatformRegistry,
    private readonly botUx: BotUxService,
  ) {}

  onModuleInit(): void {
    if (!this.config.botPollingEnabled) {
      this.logger.log(
        'Inbound polling is disabled (BOT_POLLING_ENABLED=false) — the bot only publishes to channels.',
      );
      return;
    }

    const platforms = this.registry.getInboundPlatforms();

    if (platforms.length === 0) {
      this.logger.warn('No platform is configured for inbound polling.');
      return;
    }

    this.logger.log(
      `Inbound polling started for: ${platforms.join(', ')} (long poll ${this.config.botPollTimeoutSeconds}s).`,
    );

    for (const platform of platforms) {
      this.loops.set(platform, this.runLoop(platform));
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    // Cancels the currently pending getUpdates; the loops then exit between rounds.
    this.abortController.abort();
    await Promise.allSettled([...this.loops.values()]);
  }

  /**
   * One polling round for a platform. Exposed for tests: the loop body is fully deterministic
   * and can be driven without timers or a real network.
   */
  async pollOnce(platform: Platform): Promise<number> {
    const adapter = this.registry.resolve(platform);

    if (!adapter) {
      return 0;
    }

    const offset = this.offsets.get(platform) ?? 0;
    const result = await adapter.poll(offset, this.abortController.signal);

    let handled = 0;

    for (const update of result.updates) {
      await this.handleSafely(platform, update);
      handled += 1;
    }

    if (result.nextOffset > 0) {
      this.offsets.set(platform, result.nextOffset);
    }

    return handled;
  }

  private async handleSafely(
    platform: Platform,
    update: InboundUpdate,
  ): Promise<void> {
    try {
      await this.botUx.handleUpdate(update);
    } catch (error) {
      // A single bad interaction must never stop the loop or leak to the user.
      this.logger.error(
        `Unhandled error while processing update ${update.updateId} on ${platform}: ${describeError(error)}`,
      );
    }
  }

  private async runLoop(platform: Platform): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce(platform);
      } catch (error) {
        if (this.stopping) {
          return;
        }

        this.logger.error(
          `Polling ${platform} failed: ${describeError(error)} — retrying in ${this.config.botPollRetryDelayMs}ms.`,
        );

        await this.wait(this.config.botPollRetryDelayMs);
      }
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Never keep the process alive just for a retry delay.
      timer.unref?.();
    });
  }
}

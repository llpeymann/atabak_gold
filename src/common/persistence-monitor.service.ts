import { Injectable, Logger } from '@nestjs/common';

import { describeError } from './log-safety';

/**
 * Phase 11 — the single seam between durable stores and the monitoring engine.
 *
 * Every store already swallows (or rethrows) its own write errors, which keeps the product running
 * when the disk is full — but until Phase 11 nobody *systematically* noticed. Rather than changing
 * seven constructors into a promise-chain refactor, each store reports here:
 *
 *  - `failure(component, operation, error)` on a failed write,
 *  - `success(component)` after a write that actually reached the disk.
 *
 * Two deliberate properties:
 *
 *  1. **Recovery evidence is only emitted after a failure.** A healthy deployment does not push one
 *     "write succeeded" event per save into the engine (that would be thousands of no-ops per hour);
 *     the component is remembered as failing and the *next* successful write clears it.
 *  2. **No recursion.** A listener is invoked asynchronously and its rejection is swallowed; the
 *     monitoring document itself never reports through this monitor, so a failing monitoring write
 *     cannot trigger another monitoring write.
 */
@Injectable()
export class PersistenceMonitor {
  private readonly logger = new Logger(PersistenceMonitor.name);

  private readonly failing = new Set<string>();

  private listener: PersistenceListener | null = null;

  /** Serialises deliveries so two failing documents in the same tick both reach the engine. */
  private queue: Promise<void> = Promise.resolve();

  /** Wired once by the monitoring engine (see `MonitoringService`). */
  attach(listener: PersistenceListener): void {
    this.listener = listener;
  }

  get failingComponents(): string[] {
    return [...this.failing].sort();
  }

  /** A write did not reach the disk. Never throws. */
  failure(component: string, operation: string, error: unknown): void {
    this.failing.add(component);
    this.notify({
      kind: 'failure',
      component,
      operation,
      error: describeError(error),
    });
  }

  /** A write reached the disk. Only reported while the component is marked as failing. */
  success(component: string): void {
    if (!this.failing.delete(component)) {
      return;
    }

    this.notify({ kind: 'success', component });
  }

  private notify(event: PersistenceEvent): void {
    const listener = this.listener;

    if (!listener) {
      return;
    }

    // Fire-and-forget by design: a store must never wait for (or fail because of) monitoring.
    // Events are queued rather than dropped, so two documents failing in the same tick are two
    // incidents — while a slow listener still cannot make a store block.
    this.queue = this.queue
      .then(() => listener(event))
      .catch((error: unknown) => {
        this.logger.warn(
          `PersistenceMonitor listener failed for ${event.component}: ${describeError(error)}`,
        );
      });
  }
}

export type PersistenceEvent =
  | { kind: 'failure'; component: string; operation: string; error: string }
  | { kind: 'success'; component: string };

export type PersistenceListener = (
  event: PersistenceEvent,
) => void | Promise<void>;

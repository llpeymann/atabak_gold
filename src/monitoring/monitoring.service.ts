/**
 * Phase 11 — the monitoring engine (§3.1–§3.5, §5–§9, §13).
 *
 * One place decides what is an incident, how severe it is, when a human is told, and when the
 * condition is genuinely over. Producers (the market cycle, the publisher, the scheduler, the bot
 * router) *report observations*; they never decide severity, never talk to the platform, and never
 * mark anything resolved.
 *
 * Truthfulness rules enforced here:
 *
 *  * A failed request, an invalid payload and an anomaly rejection are different observations with
 *    different reason codes — a `200` that carried unusable data is never treated as a success.
 *  * A recovery needs *positive evidence* of the same operation (valid data / a delivered message /
 *    a completed job). One unrelated success changes nothing.
 *  * An open incident is resolved only by that evidence (never by a human reading a message) or by
 *    an explicit, separately-audited manual resolution in the admin surface.
 *  * Every write goes to the Phase 10 incident table, so there is exactly one incident list.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';

import { AdminAccessService } from '../admin/admin-access.service';
import { AdminErrorService } from '../admin/admin-error.service';
import { IncidentSeverity, IncidentSource } from '../admin/admin.types';
import { describeError, redactSecrets, truncate } from '../common/log-safety';
import { tehranDateFa, tehranTimeFa } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import {
  PersistenceEvent,
  PersistenceMonitor,
} from '../common/persistence-monitor.service';
import { MarketStateService } from '../market/market-state.service';
import { UserStore } from '../users/user.store';
import { MonitoringStore } from './monitoring.store';
import {
  evaluateMissedJob,
  evaluateStaleness,
  fingerprintFor,
  mayNotify,
  normalizeReason,
  retryDelayMs,
  severityFor,
  thresholdFor,
  MonitoringPolicy,
} from './monitoring.rules';
import {
  DeliveryObservation,
  JobEndInput,
  JobStartInput,
  MonitorWatch,
  MonitoredJob,
  MonitoringCategory,
  MonitoringSnapshot,
  ObservationOutcome,
} from './monitoring.types';

/** Reason codes that map to an incident source the admin error center already understands. */
const SOURCE_BY_CATEGORY: Record<MonitoringCategory, IncidentSource> = {
  PRICE_API: 'price-api',
  MARKET_DATA_STALE: 'market',
  MARKET_DATA_INVALID: 'market',
  DELIVERY_FAILURE: 'platform-bale',
  CHANNEL_PUBLISHING: 'channel-publisher',
  APPLICATION_ERROR: 'bot-router',
  PERSISTENCE_FAILURE: 'persistence',
  SCHEDULED_JOB_FAILURE: 'scheduler',
  HEALTH_FAILURE: 'monitoring',
  MONITORING_NOTIFICATION_FAILURE: 'monitoring',
};

export interface FailureObservation {
  category: MonitoringCategory;
  reasonCode: string;
  /** Short, human-readable but *sanitized* description. */
  summary: string;
  platform?: 'bale' | 'telegram' | null;
  target?: string | null;
  retryable?: boolean;
  /**
   * Severity inputs beyond the streak (used by channel publishing, where “all destinations failed”
   * is worse than one). Never taken from the caller's opinion of the error text.
   */
  gateFailures?: number;
  at?: Date;
}

export interface SuccessObservation {
  category: MonitoringCategory;
  reasonCode?: string;
  platform?: 'bale' | 'telegram' | null;
  target?: string | null;
  /** Evidence quoted in the recovery notification and stored on the incident. */
  evidence: string;
  at?: Date;
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly startedAt = new Date();

  constructor(
    private readonly config: AppConfigService,
    private readonly store: MonitoringStore,
    private readonly errors: AdminErrorService,
    private readonly marketState: MarketStateService,
    private readonly access: AdminAccessService,
    private readonly users: UserStore,
    // Phase 11 — every durable store reports its real write outcomes here (see PersistenceMonitor).
    // Optional so a unit test can build the engine without a live monitor; production always has one.
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    this.persistence?.attach((event) => this.observePersistence(event));
  }

  /**
   * One durable write succeeded or failed.
   *
   * This is the only producer of `PERSISTENCE_FAILURE` in production: a failed write opens an
   * incident with `CRITICAL` severity immediately (losing a write is never "one of three"), and the
   * next successful write of the *same* document is the positive evidence that closes it (§8).
   */
  private async observePersistence(event: PersistenceEvent): Promise<void> {
    if (event.kind === 'failure') {
      await this.onPersistenceFailure({
        component: event.component,
        operation: event.operation,
        error: event.error,
      });

      return;
    }

    await this.onPersistenceSuccess({ component: event.component });
  }

  // --- policy -------------------------------------------------------------------

  get policy(): MonitoringPolicy {
    return {
      enabled: this.config.monitoringEnabled,
      priceFailureThreshold: this.config.monitoringPriceFailureThreshold,
      deliveryFailureThreshold: this.config.monitoringDeliveryFailureThreshold,
      applicationErrorThreshold:
        this.config.monitoringApplicationErrorThreshold,
      staleAfterMs: this.config.monitoringStaleAfterMs,
      cooldownMs: this.config.monitoringNotificationCooldownMs,
      repeatAfterMs: this.config.monitoringRepeatAfterMs,
      maxAttempts: this.config.monitoringNotificationMaxAttempts,
      retryBackoffMs: this.config.monitoringNotificationRetryBackoffMs,
      batchSize: this.config.monitoringNotificationBatchSize,
      recoveryNotifications: this.config.monitoringRecoveryNotifications,
      recoveryStabilityMs: this.config.monitoringRecoveryStabilityMs,
    };
  }

  get enabled(): boolean {
    return this.config.monitoringEnabled;
  }

  get processStartedAt(): Date {
    return this.startedAt;
  }

  // --- price pipeline -----------------------------------------------------------

  /**
   * A cycle that produced *valid, usable* market data.
   *
   * This is the only success evidence for `PRICE_API` and `MARKET_DATA_STALE` — an HTTP 200 that
   * carried nothing usable never reaches this method (§5.1).
   */
  async onPriceCycleSuccess(
    at: Date = new Date(),
  ): Promise<ObservationOutcome> {
    const evidence = `valid market data accepted at ${tehranTimeFa(at)} (${tehranDateFa(at)})`;

    const price = await this.recordSuccess({
      category: 'PRICE_API',
      reasonCode: 'CYCLE_FAILED',
      evidence,
      at,
    });
    const stale = await this.recordSuccess({
      category: 'MARKET_DATA_STALE',
      reasonCode: 'STALE_BEYOND_THRESHOLD',
      evidence,
      at,
    });

    await this.store.transact((tx) => {
      const job = tx.findJob('market-price-cycle');

      if (job) {
        tx.saveJob({
          ...job,
          lastSuccessAt: at.toISOString(),
          updatedAt: at.toISOString(),
        });
      }
    });

    return price === 'RECOVERED' || stale === 'RECOVERED' ? 'RECOVERED' : price;
  }

  /**
   * A cycle that did not produce usable market data.
   *
   * `reasonCode` distinguishes transport failures, schema failures and deliberate rejections —
   * they are counted separately, and an anomaly rejection is *not* an API outage (§5.2).
   */
  async onPriceCycleFailure(input: {
    reasonCode: string;
    error: string;
    transport: boolean;
    at?: Date;
  }): Promise<ObservationOutcome> {
    const at = input.at ?? new Date();

    return this.recordFailure({
      category: input.transport ? 'PRICE_API' : 'MARKET_DATA_INVALID',
      reasonCode: input.transport ? 'CYCLE_FAILED' : input.reasonCode,
      summary: `Market cycle failed: ${truncate(redactSecrets(input.error, []), 160)}`,
      retryable: input.transport,
      at,
    });
  }

  /** A deliberate rejection (sanity/anomaly rule). Counted, never treated as an API success. */
  async onMarketDataRejected(input: {
    reasonCode: string;
    detail: string;
    at?: Date;
  }): Promise<ObservationOutcome> {
    return this.recordFailure({
      category: 'MARKET_DATA_INVALID',
      reasonCode: input.reasonCode,
      summary: `Market data rejected: ${truncate(redactSecrets(input.detail, []), 160)}`,
      retryable: false,
      at: input.at ?? new Date(),
    });
  }

  // --- delivery -----------------------------------------------------------------

  /**
   * One delivery attempt, with the platform's own classification.
   *
   * Success clears the streak for that destination; failure counts toward it. `AMBIGUOUS` results
   * are reported as such by the publisher and are *not* retried here (§6.5).
   */
  async onDelivery(
    observation: DeliveryObservation,
  ): Promise<ObservationOutcome> {
    const at = observation.at ?? new Date();
    const target = `${observation.destination}:${observation.target}`;

    if (observation.ok) {
      return this.recordSuccess({
        category: 'DELIVERY_FAILURE',
        platform: observation.platform,
        target,
        evidence: `${observation.operation} accepted by ${observation.platform} at ${tehranTimeFa(at)}`,
        at,
      });
    }

    return this.recordFailure({
      category: 'DELIVERY_FAILURE',
      platform: observation.platform,
      target,
      reasonCode: observation.failureKind ?? 'DELIVERY_FAILED',
      summary: `${observation.operation} failed on ${observation.platform} [${
        observation.failureKind ?? 'UNCLASSIFIED'
      }]: ${truncate(
        redactSecrets(observation.error ?? 'unknown platform failure', []),
        140,
      )}`,
      retryable: observation.failureKind === 'RETRYABLE',
      at,
    });
  }

  /** Result of a publication job across all destinations (§6.2). */
  async onPublicationOutcome(input: {
    sent: number;
    failed: number;
    unknown: number;
    reason?: string | null;
    at?: Date;
  }): Promise<void> {
    const at = input.at ?? new Date();

    if (input.sent > 0 && input.failed === 0 && input.unknown === 0) {
      await this.recordSuccess({
        category: 'CHANNEL_PUBLISHING',
        reasonCode: 'PUBLICATION_FAILED',
        evidence: `${input.sent} destination(s) accepted the publication at ${tehranTimeFa(at)}`,
        at,
      });

      return;
    }

    if (input.failed === 0 && input.unknown === 0) {
      return;
    }

    await this.recordFailure({
      category: 'CHANNEL_PUBLISHING',
      reasonCode: 'PUBLICATION_FAILED',
      summary: `Publication failed on ${input.failed} destination(s), ${input.unknown} unknown${
        input.reason
          ? ` — ${truncate(redactSecrets(input.reason, []), 100)}`
          : ''
      }`,
      gateFailures: input.failed + input.unknown,
      retryable: false,
      at,
    });
  }

  // --- application / persistence ------------------------------------------------

  async onApplicationError(input: {
    service: string;
    operation: string;
    error: string;
    retryable?: boolean;
    at?: Date;
  }): Promise<ObservationOutcome> {
    const reasonCode = normalizeReason(`${input.service}_${input.operation}`);

    return this.recordFailure({
      category: 'APPLICATION_ERROR',
      reasonCode,
      target: input.service,
      summary: `${input.service}.${input.operation}: ${truncate(
        redactSecrets(input.error, []),
        140,
      )}`,
      retryable: input.retryable ?? false,
      at: input.at ?? new Date(),
    });
  }

  async onPersistenceFailure(input: {
    component: string;
    operation: string;
    error: string;
    at?: Date;
  }): Promise<ObservationOutcome> {
    return this.recordFailure({
      category: 'PERSISTENCE_FAILURE',
      reasonCode: normalizeReason(`${input.component}_${input.operation}`),
      target: input.component,
      summary: `Persistence failure in ${input.component}.${input.operation}: ${truncate(
        redactSecrets(input.error, []),
        140,
      )}`,
      retryable: true,
      at: input.at ?? new Date(),
    });
  }

  async onPersistenceSuccess(input: {
    component: string;
    at?: Date;
  }): Promise<ObservationOutcome> {
    return this.recordSuccess({
      category: 'PERSISTENCE_FAILURE',
      target: input.component,
      evidence: `write to ${input.component} succeeded`,
      at: input.at ?? new Date(),
    });
  }

  // --- scheduled jobs -----------------------------------------------------------

  /** Mark a job as running. Overlap protection stays where it already lives (§9.3). */
  async recordJobStart(input: JobStartInput): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const at = input.at ?? new Date();

    await this.store.transact((tx) => {
      const existing = tx.findJob(input.name);
      const job: MonitoredJob = {
        name: input.name,
        expectedIntervalMs:
          input.expectedIntervalMs ?? existing?.expectedIntervalMs ?? null,
        graceMs: input.graceMs ?? existing?.graceMs ?? 5 * 60_000,
        status: 'RUNNING',
        lastStartedAt: at.toISOString(),
        lastCompletedAt: existing?.lastCompletedAt ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        lastDurationMs: existing?.lastDurationMs ?? null,
        consecutiveFailures: existing?.consecutiveFailures ?? 0,
        lastError: existing?.lastError ?? null,
        missedReportedAt: existing?.missedReportedAt ?? null,
        updatedAt: at.toISOString(),
      };

      tx.saveJob(job);
    });
  }

  /** Mark a job as finished, and turn a failure streak into an incident once it matters (§9.1). */
  async recordJobEnd(input: JobEndInput): Promise<ObservationOutcome> {
    const at = input.at ?? new Date();

    if (!this.enabled) {
      return 'IGNORED';
    }

    const duration = await this.store.transact((tx) => {
      const existing = tx.findJob(input.name);

      if (!existing) {
        return 0;
      }

      const durationMs = existing.lastStartedAt
        ? Math.max(0, at.getTime() - Date.parse(existing.lastStartedAt))
        : 0;

      tx.saveJob({
        ...existing,
        status: input.ok ? 'SUCCEEDED' : 'FAILED',
        lastCompletedAt: at.toISOString(),
        lastSuccessAt: input.ok ? at.toISOString() : existing.lastSuccessAt,
        lastFailureAt: input.ok ? existing.lastFailureAt : at.toISOString(),
        lastDurationMs: durationMs,
        consecutiveFailures: input.ok ? 0 : existing.consecutiveFailures + 1,
        lastError: input.ok
          ? null
          : truncate(
              redactSecrets(input.error ?? 'unknown job failure', []),
              160,
            ),
        updatedAt: at.toISOString(),
      });

      return durationMs;
    });

    if (input.ok) {
      return this.recordSuccess({
        category: 'SCHEDULED_JOB_FAILURE',
        target: input.name,
        evidence: `job ${input.name} completed in ${Math.round(duration / 1000)}s`,
        at,
      });
    }

    return this.recordFailure({
      category: 'SCHEDULED_JOB_FAILURE',
      target: input.name,
      reasonCode: 'JOB_FAILED',
      summary: `Scheduled job ${input.name} failed: ${truncate(
        redactSecrets(input.error ?? 'unknown error', []),
        140,
      )}`,
      retryable: false,
      at,
    });
  }

  // --- periodic sweep -----------------------------------------------------------

  /**
   * The periodic self-check: stale market data, missed job runs, notification retention.
   *
   * Deliberately cheap: it reads state, never fetches a price (§3.1) and never runs a business job
   * (§9.3). Bounded work only — one stale evaluation, one pass over the (small) job list.
   */
  async sweep(now: Date = new Date()): Promise<{
    stale: boolean;
    missedJobs: string[];
  }> {
    if (!this.enabled) {
      return { stale: false, missedJobs: [] };
    }

    const stale = await this.evaluateStaleness(now);
    const missedJobs = await this.evaluateJobs(now);

    await this.store.transact((tx) => {
      tx.pruneNotifications(this.config.monitoringNotificationHistoryLimit);
    });

    return { stale, missedJobs };
  }

  private async evaluateStaleness(now: Date): Promise<boolean> {
    const lastValid = this.lastValidUpdateIso(now);
    const evaluation = evaluateStaleness({
      now,
      lastValidUpdateAt: lastValid,
      staleAfterMs: this.config.monitoringStaleAfterMs,
      scheduledWindowOnly: this.config.monitoringActiveHoursOnly,
      inActiveWindow: this.config.isWithinPriceSchedule(now),
    });

    if (!evaluation.stale) {
      return false;
    }

    await this.recordFailure({
      category: 'MARKET_DATA_STALE',
      reasonCode: 'STALE_BEYOND_THRESHOLD',
      summary: `Valid market data is ${
        evaluation.ageMs === null
          ? 'missing'
          : `${Math.round(evaluation.ageMs / 60_000)} minutes old`
      } (limit ${Math.round(this.config.monitoringStaleAfterMs / 60_000)} minutes)`,
      retryable: false,
      at: now,
    });

    return true;
  }

  private async evaluateJobs(now: Date): Promise<string[]> {
    const inWindow = this.config.isWithinPriceSchedule(now);
    const missed: string[] = [];

    for (const job of this.store.listJobs()) {
      const evaluation = evaluateMissedJob({
        job,
        now,
        processStartedAt: this.startedAt,
        inActiveWindow: inWindow,
      });

      if (!evaluation.missed) {
        continue;
      }

      missed.push(job.name);

      await this.recordFailure({
        category: 'SCHEDULED_JOB_FAILURE',
        target: job.name,
        reasonCode: 'MISSED_EXPECTED_RUN',
        summary: `Scheduled job ${job.name} did not start as expected (due ${evaluation.dueAt ?? 'unknown'})`,
        retryable: false,
        at: now,
      });

      await this.store.transact((tx) => {
        const current = tx.findJob(job.name);

        if (current) {
          tx.saveJob({
            ...current,
            status: 'MISSED',
            missedReportedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });
        }
      });
    }

    return missed;
  }

  // --- observations -------------------------------------------------------------

  /**
   * Count one failure. Opening an incident and notifying the administrator happen only when the
   * configured threshold is crossed for this category (§5.2, §12.4).
   */
  async recordFailure(
    observation: FailureObservation,
  ): Promise<ObservationOutcome> {
    if (!this.enabled) {
      return 'IGNORED';
    }

    const at = observation.at ?? new Date();
    const key = fingerprintFor({
      category: observation.category,
      platform: observation.platform ?? null,
      target: observation.target ?? null,
      reasonCode: observation.reasonCode,
    });
    const threshold = thresholdFor(observation.category, this.policy);
    const summary = truncate(redactSecrets(observation.summary, []), 240);

    const state = await this.store.transact((tx) => {
      const existing = tx.findWatch(key);
      const streak = (existing?.consecutiveFailures ?? 0) + 1;
      const severity = severityFor(observation.category, {
        consecutiveFailures: streak,
        gateFailures: observation.gateFailures,
      });

      const watch: MonitorWatch = existing
        ? {
            ...existing,
            consecutiveFailures: streak,
            totalFailures: existing.totalFailures + 1,
            lastFailureAt: at.toISOString(),
            lastError: summary,
            severity,
            recoveryCandidateAt: null,
            updatedAt: at.toISOString(),
            phase:
              existing.phase === 'OPEN'
                ? 'OPEN'
                : streak >= threshold
                  ? 'OPEN'
                  : 'DEGRADED',
          }
        : {
            key,
            category: observation.category,
            platform: observation.platform ?? null,
            target: observation.target ?? null,
            reasonCode: normalizeReason(observation.reasonCode),
            severity,
            phase: streak >= threshold ? 'OPEN' : 'DEGRADED',
            consecutiveFailures: streak,
            totalFailures: 1,
            lastFailureAt: at.toISOString(),
            lastSuccessAt: null,
            lastError: summary,
            incidentId: null,
            incidentGeneration: 0,
            openedAt: null,
            resolvedAt: null,
            recoveryCandidateAt: null,
            lastNotifiedAt: null,
            lastNotificationStatus: null,
            updatedAt: at.toISOString(),
          };

      tx.saveWatch(watch);

      return { watch, crossed: streak >= threshold };
    });

    if (!state.crossed) {
      return 'BELOW_THRESHOLD';
    }

    const repeated = state.watch.incidentId !== null;

    await this.openIncident({
      watch: state.watch,
      observation,
      summary,
      at,
      reopen: repeated,
    });

    return repeated ? 'INCIDENT_REPEAT' : 'INCIDENT_OPEN';
  }

  /** Positive evidence of the same operation. This is the only automatic path to recovery. */
  async recordSuccess(
    observation: SuccessObservation,
  ): Promise<ObservationOutcome> {
    if (!this.enabled) {
      return 'IGNORED';
    }

    const at = observation.at ?? new Date();
    const policy = this.policy;
    const candidates = this.candidateKeys(observation).map((key) =>
      this.store.findWatch(key),
    );

    let outcome: ObservationOutcome = 'IGNORED';

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const result = await this.store.transact((tx) => {
        const watch = tx.findWatch(candidate.key);

        if (!watch) {
          return null;
        }

        if (watch.incidentId === null && watch.consecutiveFailures === 0) {
          tx.saveWatch({
            ...watch,
            lastSuccessAt: at.toISOString(),
            updatedAt: at.toISOString(),
          });

          return { resolved: false, watch };
        }

        // Stability window: the first success after a failure is a *candidate*, not recovery yet.
        if (
          policy.recoveryStabilityMs > 0 &&
          watch.recoveryCandidateAt === null &&
          watch.incidentId !== null
        ) {
          const updated: MonitorWatch = {
            ...watch,
            consecutiveFailures: 0,
            lastSuccessAt: at.toISOString(),
            recoveryCandidateAt: at.toISOString(),
            updatedAt: at.toISOString(),
          };

          tx.saveWatch(updated);

          return { resolved: false, watch: updated };
        }

        if (policy.recoveryStabilityMs > 0 && watch.incidentId !== null) {
          const candidateAt = Date.parse(watch.recoveryCandidateAt ?? '');

          if (
            Number.isNaN(candidateAt) ||
            at.getTime() - candidateAt < policy.recoveryStabilityMs
          ) {
            const updated: MonitorWatch = {
              ...watch,
              consecutiveFailures: 0,
              lastSuccessAt: at.toISOString(),
              updatedAt: at.toISOString(),
            };

            tx.saveWatch(updated);

            return { resolved: false, watch: updated };
          }
        }

        const resolvedNow = watch.incidentId !== null;

        const updated: MonitorWatch = {
          ...watch,
          consecutiveFailures: 0,
          lastSuccessAt: at.toISOString(),
          recoveryCandidateAt: null,
          phase: resolvedNow ? 'RECOVERED' : 'HEALTHY',
          resolvedAt: resolvedNow ? at.toISOString() : watch.resolvedAt,
          updatedAt: at.toISOString(),
        };

        tx.saveWatch(updated);

        return { resolved: resolvedNow, watch: updated };
      });

      if (!result) {
        continue;
      }

      if (result.resolved && result.watch.incidentId) {
        await this.closeIncident({
          watch: result.watch,
          evidence: observation.evidence,
          at,
        });
        outcome = 'RECOVERED';
      } else if (outcome !== 'RECOVERED') {
        outcome = 'BELOW_THRESHOLD';
      }
    }

    return outcome;
  }

  // --- incidents ----------------------------------------------------------------

  private async openIncident(input: {
    watch: MonitorWatch;
    observation: FailureObservation;
    summary: string;
    at: Date;
    reopen: boolean;
  }): Promise<void> {
    const { watch, observation, summary, at } = input;

    // A resolved condition that comes back gets a *new* incident, so the history of both episodes
    // survives and the old row is never rewritten as if it had never been resolved (§4.4).
    let incidentId = watch.incidentId;
    let generation = watch.incidentGeneration;

    if (input.reopen && incidentId) {
      const existing = this.errors.find(incidentId);

      if (!existing || existing.status === 'RESOLVED') {
        generation += 1;
        incidentId = null;
      }
    }

    const incident = await this.errors.record({
      source: this.sourceFor(watch, observation),
      category: watch.category,
      severity: watch.severity,
      summary,
      reference:
        watch.target === null
          ? watch.reasonCode
          : `${watch.target} · ${watch.reasonCode}`,
      fingerprint: `${watch.key}#${generation + 1}`,
      retryable: observation.retryable ?? false,
      at,
    });

    if (!incident) {
      this.logger.warn(
        `Monitoring could not persist an incident for ${watch.key} (${watch.category}).`,
      );

      return;
    }

    await this.store.transact((tx) => {
      const current = tx.findWatch(watch.key);

      if (!current) {
        return;
      }

      tx.saveWatch({
        ...current,
        incidentId: incident.incidentId,
        incidentGeneration: generation,
        openedAt: current.openedAt ?? at.toISOString(),
        phase: 'OPEN',
        updatedAt: at.toISOString(),
      });
    });

    await this.requestNotification({
      watch,
      incidentId: incident.incidentId,
      generation,
      severity: incident.severity,
      occurrences: incident.occurrences,
      openedAt: incident.firstSeenAt,
      text: this.renderIncident(watch, incident.incidentId, summary, at),
      at,
    });
  }

  private async closeIncident(input: {
    watch: MonitorWatch;
    evidence: string;
    at: Date;
  }): Promise<void> {
    const incidentId = input.watch.incidentId;

    if (!incidentId) {
      return;
    }

    const existing = this.errors.find(incidentId);

    if (!existing || existing.status === 'RESOLVED') {
      return;
    }

    await this.errors.resolve(
      incidentId,
      'monitoring',
      `Verified recovery: ${input.evidence}`,
    );

    await this.requestNotification({
      watch: input.watch,
      incidentId,
      generation: input.watch.incidentGeneration,
      severity: existing.severity,
      occurrences: existing.occurrences,
      openedAt: existing.firstSeenAt,
      dedupeKey: `RECOVERY|${incidentId}|${input.watch.incidentGeneration}|0`,
      text: this.renderRecovery(
        input.watch,
        incidentId,
        input.evidence,
        input.at,
      ),
      at: input.at,
      kind: 'RECOVERY',
    });
  }

  /**
   * Queue a notification for an administrator.
   *
   * The dedupe key is derived from (kind, incident, generation, bucket): a second sweep inside the
   * same bucket, a restarted process re-evaluating the same watch, or a double dispatch can never
   * produce a second message (§12.4).
   */
  private async requestNotification(input: {
    watch: MonitorWatch;
    incidentId: string;
    generation: number;
    severity: IncidentSeverity;
    occurrences: number;
    openedAt: string;
    text: string;
    at: Date;
    kind?: 'INCIDENT' | 'RECOVERY';
    dedupeKey?: string;
  }): Promise<void> {
    const kind = input.kind ?? 'INCIDENT';
    const decision = mayNotify({
      kind,
      severity: input.severity,
      now: input.at,
      lastNotifiedAt: input.watch.lastNotifiedAt,
      incidentOpenedAt: input.openedAt,
      occurrences: input.occurrences,
      policy: this.policy,
    });

    if (!decision.allowed) {
      this.logger.debug(
        `Notification suppressed for ${input.watch.key}: ${decision.reason ?? 'policy'}.`,
      );

      return;
    }

    const dedupeKey =
      input.dedupeKey ??
      `${kind}|${input.incidentId}|${input.generation}|${decision.bucket}`;
    const destination = this.destination();

    // No destination is a *reported* state, not a silent success: the incident stays, and the admin
    // surface shows that notification is not configured (§12.1).
    if (destination === null) {
      await this.store.transact((tx) => {
        const watch = tx.findWatch(input.watch.key);

        if (watch) {
          tx.saveWatch({
            ...watch,
            lastNotifiedAt: input.at.toISOString(),
            lastNotificationStatus: null,
            updatedAt: input.at.toISOString(),
          });
        }
      });

      this.logger.warn(
        `Incident ${input.incidentId} is open but no monitoring notification destination is configured ` +
          '(MONITORING_ADMIN_CHAT_ID / admin allow-list).',
      );

      return;
    }

    await this.store.transact((tx) => {
      if (tx.findNotificationByKey(dedupeKey)) {
        return;
      }

      const notificationId = tx.nextId('mn');

      tx.saveNotification({
        notificationId,
        dedupeKey,
        kind,
        incidentId: input.incidentId,
        category: input.watch.category,
        severity: input.severity,
        text: input.text,
        status: 'PENDING',
        attemptCount: 0,
        platform: destination.platform,
        chatId: destination.chatId,
        createdAt: input.at.toISOString(),
        lastAttemptAt: null,
        nextAttemptAt: null,
        sentAt: null,
        lastError: null,
      });

      const watch = tx.findWatch(input.watch.key);

      if (watch) {
        tx.saveWatch({
          ...watch,
          lastNotifiedAt: input.at.toISOString(),
          lastNotificationStatus: 'PENDING',
          updatedAt: input.at.toISOString(),
        });
      }
    });
  }

  /** Called by the dispatcher with the *actual* outcome of one send attempt. */
  async recordNotificationResult(input: {
    notificationId: string;
    status: 'SENT' | 'FAILED' | 'UNKNOWN' | 'RETRY_PENDING';
    attemptCount: number;
    error?: string | null;
    at?: Date;
  }): Promise<void> {
    const at = input.at ?? new Date();

    await this.store.transact((tx) => {
      const notification = tx.findNotification(input.notificationId);

      if (!notification) {
        return;
      }

      tx.saveNotification({
        ...notification,
        status: input.status,
        attemptCount: input.attemptCount,
        lastAttemptAt: at.toISOString(),
        sentAt:
          input.status === 'SENT' ? at.toISOString() : notification.sentAt,
        nextAttemptAt:
          input.status === 'RETRY_PENDING'
            ? new Date(
                at.getTime() + retryDelayMs(input.attemptCount, this.policy),
              ).toISOString()
            : null,
        lastError: input.error
          ? truncate(redactSecrets(input.error, []), 200)
          : null,
      });
    });
  }

  /** The notification pipeline itself failing must be visible (§7, §12.4). */
  async onNotificationPipelineFailure(input: {
    notificationId: string;
    error: string;
    at?: Date;
  }): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // Never notify about a notification failure — that would loop. The incident is still durable
    // and appears in the admin error center.
    await this.errors.record({
      source: 'monitoring',
      category: 'MONITORING_NOTIFICATION_FAILURE',
      severity: 'MEDIUM',
      summary: `Monitoring could not notify the administrator: ${truncate(
        redactSecrets(input.error, []),
        160,
      )}`,
      reference: input.notificationId,
      fingerprint: `MONITORING_NOTIFICATION_FAILURE|${input.notificationId}`,
      retryable: true,
      at: input.at ?? new Date(),
    });
  }

  // --- admin surface ------------------------------------------------------------

  /**
   * Everything the admin surface and the health probe need, computed synchronously from state that
   * is already in memory — no I/O, no provider call, bounded by the configured caps (§10, §14.2).
   */
  snapshot(now: Date = new Date()): MonitoringSnapshot {
    const destination = this.destination();
    const lastValid = this.lastValidUpdateIso(now);
    const ageMs =
      lastValid === null
        ? null
        : Math.max(0, now.getTime() - Date.parse(lastValid));
    const staleAfter = this.config.monitoringStaleAfterMs;
    const notifications = this.store.listNotifications();
    const open = this.errors.list({ status: 'OPEN', limit: 1000 });

    return {
      enabled: this.enabled,
      notificationDestination: {
        configured: destination !== null,
        reason:
          destination === null
            ? 'MONITORING_ADMIN_CHAT_ID تنظیم نشده و هیچ مدیر شناخته‌شده‌ای هم پیدا نشد'
            : null,
      },
      openIncidents: open.length,
      criticalIncidents: open.filter(
        (incident) => incident.severity === 'CRITICAL',
      ).length,
      degradedWatches: this.store
        .listWatches()
        .filter((watch) => watch.consecutiveFailures > 0).length,
      stale: {
        state:
          lastValid === null
            ? 'UNKNOWN'
            : ageMs !== null && ageMs > staleAfter
              ? 'STALE'
              : 'FRESH',
        ageMinutes: ageMs === null ? null : Math.round(ageMs / 60_000),
        reason:
          lastValid === null
            ? 'هنوز هیچ به‌روزرسانی معتبری ثبت نشده است'
            : null,
      },
      jobs: this.store.listJobs(),
      notifications: {
        pending: notifications.filter((row) => row.status === 'PENDING').length,
        retryPending: notifications.filter(
          (row) => row.status === 'RETRY_PENDING',
        ).length,
        failed: notifications.filter((row) => row.status === 'FAILED').length,
        unknown: notifications.filter((row) => row.status === 'UNKNOWN').length,
        lastSentAt:
          notifications
            .filter((row) => row.status === 'SENT')
            .map((row) => row.sentAt)
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? null,
      },
      lastPriceSuccessAt: lastValid,
      lastDeliverySuccessAt: this.lastDeliverySuccessAt(),
    };
  }

  /** Alias used by synchronous callers (the metrics service renders a screen, not a promise). */
  snapshotSync(now: Date = new Date()): MonitoringSnapshot {
    return this.snapshot(now);
  }

  // --- public accessors (health endpoint, admin screen) --------------------------

  /** Open incidents; bounded by the configured incident cap (§14.1). */
  openIncidentsSync() {
    return this.errors.list({ status: 'OPEN', limit: 1000 });
  }

  /** Whether a destination exists at all — never the chat id itself (§17.2). */
  notificationDestination(): {
    configured: boolean;
    platform: 'bale' | 'telegram' | null;
    reason: string | null;
  } {
    const destination = this.destination();

    return {
      configured: destination !== null,
      platform: destination?.platform ?? null,
      reason:
        destination === null
          ? 'MONITORING_ADMIN_CHAT_ID تنظیم نشده و هیچ مدیر شناخته‌شده‌ای هم پیدا نشد'
          : null,
    };
  }

  // --- helpers ------------------------------------------------------------------

  private sourceFor(
    watch: MonitorWatch,
    observation: FailureObservation,
  ): IncidentSource {
    if (watch.category === 'DELIVERY_FAILURE') {
      return observation.platform === 'telegram'
        ? 'platform-telegram'
        : 'platform-bale';
    }

    return SOURCE_BY_CATEGORY[watch.category];
  }

  /**
   * Watches a success observation can legitimately close.
   *
   * A watch key includes the *reason code* of the failure, and one condition can be observed under
   * several codes (a delivery can fail as RETRYABLE today and PERMANENT tomorrow; a job can fail and
   * later be missed). Recovery therefore matches on category + platform + destination and closes
   * those watches, but never matches a *different* destination — one channel accepting a message
   * never proves another channel works (§13).
   */
  private candidateKeys(observation: SuccessObservation): string[] {
    const matches = this.store
      .listWatches()
      .filter((watch) => watch.category === observation.category)
      .filter((watch) =>
        observation.platform === undefined || observation.platform === null
          ? true
          : watch.platform === observation.platform,
      )
      .filter((watch) =>
        observation.target === undefined || observation.target === null
          ? true
          : watch.target === observation.target,
      )
      .map((watch) => watch.key);

    if (matches.length > 0) {
      return matches;
    }

    // Nothing is tracked yet under this condition: fall back to the canonical key so an explicit
    // success still records `lastSuccessAt` for a watch opened later.
    return [
      fingerprintFor({
        category: observation.category,
        platform: observation.platform ?? null,
        target: observation.target ?? null,
        reasonCode: observation.reasonCode ?? 'UNCLASSIFIED',
      }),
    ];
  }

  /**
   * When no destination is configured explicitly, use an administrator that the deployment already
   * trusts: the owner/administrator allow-lists resolved to a chat id through the user store.
   *
   * Nothing is invented — an id that has never interacted with the bot has no chat id and is skipped,
   * and if none resolves the caller receives `null` (the admin surface then reports the gap).
   */
  private resolveAdminFallback(): {
    platform: 'bale' | 'telegram';
    chatId: string;
  } | null {
    const candidates = [...this.access.ownerIds, ...this.access.adminIds];

    for (const candidate of candidates) {
      const match = /^(bale|telegram):(.+)$/.exec(candidate);
      const platform = (match?.[1] ?? this.config.monitoringAdminPlatform) as
        'bale' | 'telegram';
      const platformUserId = match?.[2] ?? candidate;
      const user = this.users.findUserByPlatform(platform, platformUserId);

      if (user && user.chatId && user.chatId.trim() !== '') {
        return { platform, chatId: user.chatId };
      }
    }

    return null;
  }

  private destination(): {
    platform: 'bale' | 'telegram';
    chatId: string;
  } | null {
    const configured = this.config.monitoringAdminChatId;

    if (configured !== null) {
      return {
        platform: this.config.monitoringAdminPlatform,
        chatId: configured.chatId,
      };
    }

    return this.resolveAdminFallback();
  }

  private lastValidUpdateIso(now: Date): string | null {
    let latest: string | null = null;

    for (const definition of this.config.symbolRegistry) {
      const state = this.marketState.getState(definition, now);

      if (!state) {
        continue;
      }

      if (latest === null || state.lastSuccessfulUpdate > latest) {
        latest = state.lastSuccessfulUpdate;
      }
    }

    return latest;
  }

  private lastDeliverySuccessAt(): string | null {
    const values = this.store
      .listWatches()
      .filter((watch) => watch.category === 'DELIVERY_FAILURE')
      .map((watch) => watch.lastSuccessAt)
      .filter((value): value is string => value !== null)
      .sort();

    return values.at(-1) ?? null;
  }

  private renderIncident(
    watch: MonitorWatch,
    incidentId: string,
    summary: string,
    at: Date,
  ): string {
    const lines = [
      `🚨 ${titleFor(watch.category)}`,
      '',
      `شدت: ${severityFa(watch.severity)}`,
      watch.platform ? `پلتفرم: ${watch.platform}` : null,
      watch.target ? `مقصد/مؤلفه: ${watch.target}` : null,
      `تعداد خطاهای پیوسته: ${watch.consecutiveFailures}`,
      `زمان تشخیص: ${tehranTimeFa(at)} · ${tehranDateFa(at)}`,
      `شناسهٔ رخداد: ${incidentId}`,
      `دلیل: ${summary}`,
    ].filter((line): line is string => line !== null);

    return lines.join('\n');
  }

  private renderRecovery(
    watch: MonitorWatch,
    incidentId: string,
    evidence: string,
    at: Date,
  ): string {
    return [
      '✅ بازیابی سرویس',
      '',
      `مؤلفه: ${titleFor(watch.category)}${watch.target ? ` — ${watch.target}` : ''}`,
      `زمان بازیابی: ${tehranTimeFa(at)} · ${tehranDateFa(at)}`,
      `شاهد بازیابی: ${evidence}`,
      `شناسهٔ رخداد اصلی: ${incidentId}`,
    ].join('\n');
  }
}

function titleFor(category: MonitoringCategory): string {
  switch (category) {
    case 'PRICE_API':
      return 'قطع ارتباط با API قیمت';
    case 'MARKET_DATA_STALE':
      return 'کهنه‌شدن دادهٔ بازار';
    case 'MARKET_DATA_INVALID':
      return 'دادهٔ بازار نامعتبر';
    case 'DELIVERY_FAILURE':
      return 'خطای تحویل پیام';
    case 'CHANNEL_PUBLISHING':
      return 'خطای انتشار در کانال';
    case 'APPLICATION_ERROR':
      return 'خطای داخلی برنامه';
    case 'PERSISTENCE_FAILURE':
      return 'خطای ذخیره‌سازی';
    case 'SCHEDULED_JOB_FAILURE':
      return 'خطای کار زمان‌بندی‌شده';
    case 'HEALTH_FAILURE':
      return 'اختلال سلامت سامانه';
    case 'MONITORING_NOTIFICATION_FAILURE':
      return 'خطای اطلاع‌رسانی پایش';
    default:
      return 'رخداد عملیاتی';
  }
}

function severityFa(severity: IncidentSeverity): string {
  switch (severity) {
    case 'CRITICAL':
      return 'بحرانی';
    case 'HIGH':
      return 'بالا';
    case 'MEDIUM':
      return 'متوسط';
    case 'LOW':
      return 'پایین';
    default:
      return severity;
  }
}

export function describeMonitoringError(error: unknown): string {
  return truncate(redactSecrets(describeError(error), []), 200);
}

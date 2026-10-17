/**
 * Phase 10 — the operational incident store (§10).
 *
 * This is **not** a replacement for logging, retries or error handling: it is the durable record that
 * lets an operator answer “what is broken, since when, how often, and did anybody look at it”. Every
 * producer is a real code path (`record` is called from the module that failed), and every category
 * that appears in the error center comes from an actual producer — the screen never lists an empty
 * category to look complete (§10.1).
 *
 * Honest semantics, enforced by the API:
 *
 *  * **Occurrences are aggregated, not collapsed.** Repeats of the same fingerprint inside the
 *    aggregation window increment `occurrences` and move `lastSeenAt`; the first occurrence and the
 *    count are preserved, so “12 times since 09:20” is a fact (§10.2).
 *  * **Reviewed ≠ resolved.** `review` records that a human looked at it; `resolve` records that the
 *    operator believes the problem is over, with their name and a note. Neither claims the underlying
 *    cause is fixed (§10.4).
 *  * **Retry state is evidence.** `recordRetry` stores what a retry *actually* did.
 *  * **Safe content only.** Summaries are collapsed, truncated and sanitized of token-ish strings
 *    before they are stored, and never contain customer free text or a phone number (§10.2, §12.4).
 */

import { Injectable, Logger } from '@nestjs/common';

import { describeError, truncate } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { AdminStore } from './admin.store';
import {
  IncidentRecord,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  MetricKind,
} from './admin.types';

/** Repeats of the same fingerprint inside this window are counted on one row (§10.2). */
export const INCIDENT_AGGREGATION_WINDOW_MS = 60 * 60_000;

const MAX_SUMMARY_LENGTH = 240;

export interface IncidentInput {
  source: IncidentSource;
  category: string;
  severity: IncidentSeverity;
  summary: string;
  reference?: string | null;
  correlationId?: string | null;
  retryable?: boolean;
  /**
   * Optional stable grouping key supplied by the producer.
   *
   * Phase 11 uses it because “same kind of failure” is not the same thing as “same summary text”:
   * a monitoring fingerprint is built from category/platform/destination/reason, so two unrelated
   * delivery failures cannot merge just because the platform worded the error identically.
   * Omitted ⇒ the Phase 10 default (`source|category|summary`).
   */
  fingerprint?: string;
  at?: Date;
}

export interface IncidentQuery {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  source?: IncidentSource;
  /** Free-text search over the (already sanitized) summary and the reference. */
  query?: string;
  retryable?: boolean;
  /** ISO bounds: `from` inclusive, `to` exclusive. */
  from?: string;
  to?: string;
  /** Only incidents seen at least this many times. */
  minOccurrences?: number;
  limit?: number;
  offset?: number;
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
  LOW: 0,
};

@Injectable()
export class AdminErrorService {
  private readonly logger = new Logger(AdminErrorService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: AdminStore,
  ) {}

  /**
   * Record one occurrence. Never throws: the code path that just failed must not fail again because
   * of the error recorder (§17). A failure to persist is logged.
   */
  async record(input: IncidentInput): Promise<IncidentRecord | null> {
    const at = (input.at ?? new Date()).toISOString();
    const summary = sanitizeSummary(input.summary);

    if (summary === '') {
      return null;
    }

    const fingerprint =
      input.fingerprint ?? `${input.source}|${input.category}|${summary}`;

    try {
      return await this.store.transact((tx) => {
        const existing = tx.findIncidentByFingerprint(fingerprint);
        const withinWindow =
          existing !== undefined &&
          existing !== null &&
          Date.parse(at) - Date.parse(existing.lastSeenAt) <=
            INCIDENT_AGGREGATION_WINDOW_MS;

        if (existing && withinWindow) {
          const updated: IncidentRecord = {
            ...existing,
            occurrences: existing.occurrences + 1,
            lastSeenAt: at,
            // A repeated occurrence of a *reviewed* incident re-opens it: it is clearly not over.
            status: existing.status === 'RESOLVED' ? 'OPEN' : existing.status,
            retryable: existing.retryable || (input.retryable ?? false),
            reference: existing.reference ?? input.reference ?? null,
          };

          tx.saveIncident(updated);

          return updated;
        }

        const record: IncidentRecord = {
          incidentId: tx.nextId('inc'),
          fingerprint,
          source: input.source,
          category: input.category,
          severity: input.severity,
          summary,
          reference: input.reference ?? null,
          correlationId: input.correlationId ?? null,
          retryable: input.retryable ?? false,
          firstSeenAt: at,
          lastSeenAt: at,
          occurrences: 1,
          status: 'OPEN',
          reviewedBy: null,
          reviewedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          lastRetryAt: null,
          lastRetryResult: null,
        };

        tx.saveIncident(record);

        return record;
      });
    } catch (error) {
      this.logger.error(
        `Could not record an operational incident (${input.source}/${input.category}): ${describeError(error)}`,
      );

      return null;
    }
  }

  find(incidentId: string): IncidentRecord | null {
    return this.store.findIncident(incidentId);
  }

  /** Bounded, filtered, unresolved-first listing (§10.3). */
  list(query: IncidentQuery = {}): IncidentRecord[] {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(Math.max(1, query.limit ?? 10), 50);

    return this.matched(query).slice(offset, offset + limit);
  }

  /** Everything matching the query (counts and breakdowns; never rendered row by row). */
  listAll(query: IncidentQuery = {}): IncidentRecord[] {
    return this.matched(query);
  }

  count(query: IncidentQuery = {}): number {
    return this.matched(query).length;
  }

  private matched(query: IncidentQuery): IncidentRecord[] {
    const from = query.from ? Date.parse(query.from) : null;
    const to = query.to ? Date.parse(query.to) : null;
    const needle = query.query?.trim() ?? '';

    const matched = this.store.listIncidents().filter((incident) => {
      if (query.status && incident.status !== query.status) {
        return false;
      }

      if (query.severity && incident.severity !== query.severity) {
        return false;
      }

      if (query.source && incident.source !== query.source) {
        return false;
      }

      if (
        query.retryable !== undefined &&
        incident.retryable !== query.retryable
      ) {
        return false;
      }

      if (
        query.minOccurrences !== undefined &&
        incident.occurrences < query.minOccurrences
      ) {
        return false;
      }

      const lastSeen = Date.parse(incident.lastSeenAt);

      if (from !== null && lastSeen < from) {
        return false;
      }

      if (to !== null && lastSeen >= to) {
        return false;
      }

      if (needle !== '') {
        const haystack = `${incident.summary} ${incident.category} ${incident.reference ?? ''}`;

        if (!haystack.includes(needle)) {
          return false;
        }
      }

      return true;
    });

    // Deterministic order: unresolved first, then severity, then most recent (§10.3). The list is
    // *not* re-sorted by an invented “importance score”.
    matched.sort((left, right) => {
      const statusRank = (incident: IncidentRecord): number =>
        incident.status === 'OPEN' ? 0 : incident.status === 'REVIEWED' ? 1 : 2;
      const byStatus = statusRank(left) - statusRank(right);

      if (byStatus !== 0) {
        return byStatus;
      }

      const bySeverity =
        SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];

      if (bySeverity !== 0) {
        return bySeverity;
      }

      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    });

    return matched;
  }

  countsBySeverity(
    query: IncidentQuery = {},
  ): Record<IncidentSeverity, number> {
    const counts: Record<IncidentSeverity, number> = {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0,
    };

    for (const incident of this.matched(query)) {
      counts[incident.severity] += 1;
    }

    return counts;
  }

  countsBySource(
    query: IncidentQuery = {},
  ): { source: IncidentSource; count: number }[] {
    const counts = new Map<IncidentSource, number>();

    for (const incident of this.matched(query)) {
      counts.set(incident.source, (counts.get(incident.source) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => right.count - left.count);
  }

  /** Occurrences recorded in a window — the “API errors” metric of the dashboard (§4.1, §14). */
  occurrencesIn(
    fromIso: string,
    toIso: string,
    sources?: readonly IncidentSource[],
  ): number {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);

    return this.store
      .listIncidents()
      .filter((incident) => {
        if (sources && !sources.includes(incident.source)) {
          return false;
        }

        const lastSeen = Date.parse(incident.lastSeenAt);
        const firstSeen = Date.parse(incident.firstSeenAt);

        // Counts rows that were *active* inside the window (first seen before the end, last seen
        // after the start) — a repeated incident is one row with a real occurrence count.
        return firstSeen < to && lastSeen >= from;
      })
      .reduce((total, incident) => total + incident.occurrences, 0);
  }

  openCount(): number {
    return this.store
      .listIncidents()
      .filter((incident) => incident.status === 'OPEN').length;
  }

  openBySeverity(): { severity: IncidentSeverity; count: number }[] {
    return (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
      .map((severity) => ({
        severity,
        count: this.store
          .listIncidents()
          .filter(
            (incident) =>
              incident.status === 'OPEN' && incident.severity === severity,
          ).length,
      }))
      .filter((row) => row.count > 0);
  }

  /** Occurrences grouped by source — the “which subsystem is hurting” view. */
  occurrenceBreakdown(
    fromIso: string,
    toIso: string,
  ): { source: IncidentSource; incidents: number; occurrences: number }[] {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    const rows = new Map<
      IncidentSource,
      { incidents: number; occurrences: number }
    >();

    for (const incident of this.store.listIncidents()) {
      const firstSeen = Date.parse(incident.firstSeenAt);
      const lastSeen = Date.parse(incident.lastSeenAt);

      if (firstSeen >= to || lastSeen < from) {
        continue;
      }

      const current = rows.get(incident.source) ?? {
        incidents: 0,
        occurrences: 0,
      };

      current.incidents += 1;
      current.occurrences += incident.occurrences;
      rows.set(incident.source, current);
    }

    return [...rows.entries()]
      .map(([source, value]) => ({ source, ...value }))
      .sort((left, right) => right.occurrences - left.occurrences);
  }

  // --- lifecycle (§10.4) ---------------------------------------------------------

  /**
   * Mark an incident as inspected. This states “a human looked at it” and nothing more — the
   * underlying problem is deliberately *not* declared fixed (§10.4).
   */
  async review(
    incidentId: string,
    actor: string,
    note?: string | null,
  ): Promise<IncidentRecord | null> {
    return this.update(incidentId, (incident, at) => ({
      ...incident,
      status: 'REVIEWED',
      reviewedBy: actor,
      reviewedAt: at,
      resolutionNote: note ? sanitizeSummary(note) : incident.resolutionNote,
    }));
  }

  /** Mark an incident resolved, recording who believes so and on what basis (§10.4). */
  async resolve(
    incidentId: string,
    actor: string,
    note?: string | null,
  ): Promise<IncidentRecord | null> {
    return this.update(incidentId, (incident, at) => ({
      ...incident,
      status: 'RESOLVED',
      resolvedBy: actor,
      resolvedAt: at,
      resolutionNote: note ? sanitizeSummary(note) : incident.resolutionNote,
    }));
  }

  /** Re-open an incident (a repeat appeared, or the review was wrong). Never deletes anything. */
  async reopen(
    incidentId: string,
    actor: string,
  ): Promise<IncidentRecord | null> {
    return this.update(incidentId, (incident) => ({
      ...incident,
      status: 'OPEN',
      reviewedBy: actor,
      reviewedAt: new Date().toISOString(),
    }));
  }

  /** Record what a retry actually did (§10.4/§10.5). */
  async recordRetry(
    incidentId: string,
    outcome: { actor: string; result: string; at?: Date },
  ): Promise<IncidentRecord | null> {
    const at = (outcome.at ?? new Date()).toISOString();

    return this.update(incidentId, (incident) => ({
      ...incident,
      lastRetryAt: at,
      lastRetryResult: truncate(
        `${outcome.actor}: ${outcome.result}`,
        MAX_SUMMARY_LENGTH,
      ),
    }));
  }

  private async update(
    incidentId: string,
    mutate: (incident: IncidentRecord, at: string) => IncidentRecord,
  ): Promise<IncidentRecord | null> {
    const at = new Date().toISOString();

    try {
      return await this.store.transact((tx) => {
        const current = tx.findIncident(incidentId);

        if (!current) {
          return null;
        }

        const updated = mutate(current, at);

        tx.saveIncident(updated);

        return updated;
      });
    } catch (error) {
      this.logger.error(
        `Could not update incident ${incidentId}: ${describeError(error)}`,
      );

      return null;
    }
  }

  // --- retention (§15.2, §16) ----------------------------------------------------

  /**
   * Apply the configured retention. Only **resolved** incidents older than the retention window are
   * removed, and only beyond `ADMIN_MAX_INCIDENTS`; open ones are never deleted. Every removal is
   * counted in the document, so a pruned hole in the history is visible as a number instead of being
   * invisible (§10.2).
   */
  async prune(
    now: Date = new Date(),
  ): Promise<{ removed: number; occurrences: number }> {
    const retentionDays = this.config.adminIncidentRetentionDays;
    const maxIncidents = this.config.adminMaxIncidents;

    const incidents = this.store.listIncidents();
    const cutoff =
      retentionDays > 0
        ? now.getTime() - retentionDays * 24 * 60 * 60_000
        : null;

    const removable = incidents
      .filter((incident) => incident.status === 'RESOLVED')
      .filter(
        (incident) =>
          cutoff === null ||
          Date.parse(incident.resolvedAt ?? incident.lastSeenAt) < cutoff,
      )
      .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));

    const overflow =
      maxIncidents > 0 ? Math.max(0, incidents.length - maxIncidents) : 0;
    const overflowIds = new Set(
      incidents
        .filter((incident) => incident.status !== 'OPEN')
        .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))
        .slice(0, overflow)
        .map((incident) => incident.incidentId),
    );

    const targets = new Map<string, IncidentRecord>();

    for (const incident of removable) {
      targets.set(incident.incidentId, incident);
    }

    for (const incident of incidents) {
      if (overflowIds.has(incident.incidentId)) {
        targets.set(incident.incidentId, incident);
      }
    }

    if (targets.size === 0) {
      return { removed: 0, occurrences: 0 };
    }

    try {
      return await this.store.transact((tx) => {
        let occurrences = 0;

        for (const incident of targets.values()) {
          occurrences += incident.occurrences;
          tx.removeIncident(incident.incidentId);
        }

        tx.recordPruned({
          incidents: targets.size,
          incidentOccurrences: occurrences,
        });

        return { removed: targets.size, occurrences };
      });
    } catch (error) {
      this.logger.error(`Could not prune incidents: ${describeError(error)}`);

      return { removed: 0, occurrences: 0 };
    }
  }

  get prunedCounters(): { incidents: number; incidentOccurrences: number } {
    return this.store.prunedCounters;
  }

  get totalIncidents(): number {
    return this.store.incidentCount;
  }
}

export const INCIDENT_METRIC_KIND: MetricKind = 'TOTAL_EVENTS';

/** Token-ish strings, control characters and newlines never reach the store (§10.2, §12.4). */
export function sanitizeSummary(raw: string): string {
  const collapsed = raw
    // `\p{Cc}` is the Unicode “control” class: it covers NUL…US and DEL without embedding raw
    // control characters in the source (which the lint rules reject, and rightly so).
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/bot[^\s/]*:[A-Za-z0-9_-]{10,}/gu, 'bot***')
    .replace(/\s+/gu, ' ')
    .trim();

  return collapsed.length > MAX_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}

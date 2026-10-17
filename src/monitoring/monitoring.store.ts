/**
 * Phase 11 — durable monitoring state (§3.5, §3.6, §16).
 *
 * The project persists every subsystem in a versioned JSON document written atomically
 * (`tmp` → `rename`), so monitoring does the same instead of introducing a database, a queue or a
 * second incident table. What lives here:
 *
 *  * `watches`   — the running state of each monitored condition (streaks, cooldowns, links to the
 *                  incident it opened);
 *  * `jobs`      — last execution of every recurring job (start/end/success/failure, missed runs);
 *  * `notifications` — the outbox: a row is written **before** the send is attempted and updated
 *                  with the outcome afterwards, so a crash mid-send leaves evidence, not silence.
 *
 * Incidents are *not* duplicated here: they stay in the Phase 10 document (`AdminStore`), which
 * remains the single incident table of the application (§16).
 *
 * Loading is backwards compatible: a document written by an older build (or a hand-edited file with
 * a missing section) is accepted, and missing sections start empty. A write failure is reported to
 * the caller and never silently swallowed — an unwritten outbox row must not look persisted.
 */

import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import {
  MonitorNotification,
  MonitorWatch,
  MonitoredJob,
  MonitoringDocument,
} from './monitoring.types';

export const MONITORING_DOCUMENT_VERSION = 1;

export interface MonitoringTransaction {
  nextId(prefix: string): string;

  findWatch(key: string): MonitorWatch | null;
  listWatches(): MonitorWatch[];
  saveWatch(watch: MonitorWatch): void;

  findJob(name: string): MonitoredJob | null;
  listJobs(): MonitoredJob[];
  saveJob(job: MonitoredJob): void;

  findNotification(notificationId: string): MonitorNotification | null;
  findNotificationByKey(dedupeKey: string): MonitorNotification | null;
  /** Oldest first: the dispatcher always works on the queue head (§12.4). */
  listNotifications(): MonitorNotification[];
  saveNotification(notification: MonitorNotification): void;
  /** Drops *finished* rows beyond the configured history cap; nothing pending is ever removed. */
  pruneNotifications(keep: number): number;
}

class MonitoringDraft implements MonitoringTransaction {
  private readonly watches = new Map<string, MonitorWatch>();
  private readonly jobs = new Map<string, MonitoredJob>();
  private readonly notifications = new Map<string, MonitorNotification>();
  private readonly notificationByKey = new Map<string, string>();
  private readonly sequences = new Map<string, number>();

  changed = false;

  constructor(sequences: Map<string, number>) {
    for (const [prefix, value] of sequences) {
      this.sequences.set(prefix, value);
    }
  }

  seed(input: {
    watches: MonitorWatch[];
    jobs: MonitoredJob[];
    notifications: MonitorNotification[];
  }): void {
    for (const watch of input.watches) {
      this.watches.set(watch.key, { ...watch });
    }

    for (const job of input.jobs) {
      this.jobs.set(job.name, { ...job });
    }

    for (const notification of input.notifications) {
      this.notifications.set(notification.notificationId, { ...notification });
      this.notificationByKey.set(
        notification.dedupeKey,
        notification.notificationId,
      );
    }
  }

  nextId(prefix: string): string {
    const next = (this.sequences.get(prefix) ?? 0) + 1;

    this.sequences.set(prefix, next);

    return `${prefix}_${next}`;
  }

  findWatch(key: string): MonitorWatch | null {
    const watch = this.watches.get(key);

    return watch ? { ...watch } : null;
  }

  listWatches(): MonitorWatch[] {
    return [...this.watches.values()].map((watch) => ({ ...watch }));
  }

  saveWatch(watch: MonitorWatch): void {
    this.watches.set(watch.key, { ...watch });
    this.changed = true;
  }

  findJob(name: string): MonitoredJob | null {
    const job = this.jobs.get(name);

    return job ? { ...job } : null;
  }

  listJobs(): MonitoredJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  saveJob(job: MonitoredJob): void {
    this.jobs.set(job.name, { ...job });
    this.changed = true;
  }

  findNotification(notificationId: string): MonitorNotification | null {
    const notification = this.notifications.get(notificationId);

    return notification ? { ...notification } : null;
  }

  findNotificationByKey(dedupeKey: string): MonitorNotification | null {
    const id = this.notificationByKey.get(dedupeKey);

    return id ? this.findNotification(id) : null;
  }

  listNotifications(): MonitorNotification[] {
    return [...this.notifications.values()]
      .map((notification) => ({ ...notification }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  saveNotification(notification: MonitorNotification): void {
    this.notifications.set(notification.notificationId, { ...notification });
    this.notificationByKey.set(
      notification.dedupeKey,
      notification.notificationId,
    );
    this.changed = true;
  }

  pruneNotifications(keep: number): number {
    if (keep <= 0) {
      return 0;
    }

    const finished = this.listNotifications().filter(
      (notification) =>
        notification.status === 'SENT' ||
        notification.status === 'FAILED' ||
        notification.status === 'UNKNOWN',
    );

    if (finished.length <= keep) {
      return 0;
    }

    const doomed = finished.slice(0, finished.length - keep);

    for (const notification of doomed) {
      this.notifications.delete(notification.notificationId);
      this.notificationByKey.delete(notification.dedupeKey);
    }

    if (doomed.length > 0) {
      this.changed = true;
    }

    return doomed.length;
  }

  toDocument(): MonitoringDocument {
    return {
      version: MONITORING_DOCUMENT_VERSION,
      savedAt: new Date().toISOString(),
      watches: this.listWatches(),
      jobs: this.listJobs(),
      notifications: this.listNotifications(),
      sequences: Object.fromEntries(this.sequences),
    };
  }

  get sequenceState(): Map<string, number> {
    return new Map(this.sequences);
  }
}

@Injectable()
export class MonitoringStore {
  private readonly logger = new Logger(MonitoringStore.name);
  private loaded = false;

  private readonly watches = new Map<string, MonitorWatch>();
  private readonly jobs = new Map<string, MonitoredJob>();
  private readonly notifications = new Map<string, MonitorNotification>();
  private sequences = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  /** Set by the last successful/failed write; the readiness probe reads it (§8.3). */
  private lastWriteOkAt: string | null = null;
  private lastWriteErrorAt: string | null = null;
  private lastWriteError: string | null = null;

  private readonly filePath: string | null;

  constructor(private readonly config: AppConfigService) {
    const configured = this.config.monitoringDataFile;

    // Absolute from construction: the operational state must not depend on the working directory.
    this.filePath = configured === null ? null : resolve(configured);
  }

  get path(): string | null {
    return this.filePath;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get writeHealth(): {
    lastWriteOkAt: string | null;
    lastWriteErrorAt: string | null;
    lastWriteError: string | null;
  } {
    return {
      lastWriteOkAt: this.lastWriteOkAt,
      lastWriteErrorAt: this.lastWriteErrorAt,
      lastWriteError: this.lastWriteError,
    };
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await this.load();
  }

  async load(): Promise<void> {
    this.loaded = true;

    if (!this.filePath) {
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (!isDocumentShape(parsed)) {
        this.logger.warn(
          `Monitoring data file ${this.filePath} has an unexpected shape — starting with empty monitoring state.`,
        );

        return;
      }

      this.applyDocument(parsed);
      this.logger.log(
        `Restored ${this.watches.size} watch(es), ${this.jobs.size} job(s) and ` +
          `${this.notifications.size} notification(s) from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted monitoring state at ${this.filePath} — starting empty.`,
        );

        return;
      }

      this.logger.error(
        `Could not read monitoring data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads --------------------------------------------------------------------

  findWatch(key: string): MonitorWatch | null {
    const watch = this.watches.get(key);

    return watch ? { ...watch } : null;
  }

  listWatches(): MonitorWatch[] {
    return [...this.watches.values()].map((watch) => ({ ...watch }));
  }

  findJob(name: string): MonitoredJob | null {
    const job = this.jobs.get(name);

    return job ? { ...job } : null;
  }

  listJobs(): MonitoredJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  listNotifications(): MonitorNotification[] {
    return [...this.notifications.values()]
      .map((notification) => ({ ...notification }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  findNotification(notificationId: string): MonitorNotification | null {
    const notification = this.notifications.get(notificationId);

    return notification ? { ...notification } : null;
  }

  findNotificationByKey(dedupeKey: string): MonitorNotification | null {
    for (const notification of this.notifications.values()) {
      if (notification.dedupeKey === dedupeKey) {
        return { ...notification };
      }
    }

    return null;
  }

  /** Rows the dispatcher must look at: pending or waiting for a retry time (§12.4). */
  dueNotifications(now: Date): MonitorNotification[] {
    return this.listNotifications().filter((notification) => {
      if (notification.status === 'PENDING') {
        return true;
      }

      if (notification.status !== 'RETRY_PENDING') {
        return false;
      }

      return (
        notification.nextAttemptAt === null ||
        Date.parse(notification.nextAttemptAt) <= now.getTime()
      );
    });
  }

  // --- writes -------------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   *
   * The draft replaces live state only after the write succeeded, so a failed write leaves the
   * store exactly as it was and the caller learns about it (§16.1).
   */
  async transact<T>(operation: (tx: MonitoringTransaction) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const draft = new MonitoringDraft(this.sequences);

      draft.seed({
        watches: this.listWatches(),
        jobs: this.listJobs(),
        notifications: this.listNotifications(),
      });

      const result = operation(draft);

      if (draft.changed) {
        await this.writeFile(draft.toDocument());
        this.commit(draft);
      }

      return result;
    });

    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private commit(draft: MonitoringDraft): void {
    this.watches.clear();
    for (const watch of draft.listWatches()) {
      this.watches.set(watch.key, watch);
    }

    this.jobs.clear();
    for (const job of draft.listJobs()) {
      this.jobs.set(job.name, job);
    }

    this.notifications.clear();
    for (const notification of draft.listNotifications()) {
      this.notifications.set(notification.notificationId, notification);
    }

    this.sequences = draft.sequenceState;
  }

  private async writeFile(document: MonitoringDocument): Promise<void> {
    if (!this.filePath) {
      this.lastWriteOkAt = new Date().toISOString();

      return;
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });

      const temporary = `${this.filePath}.tmp`;
      const payload = `${JSON.stringify(document, null, 2)}\n`;

      await writeFile(temporary, payload, 'utf-8');
      await rename(temporary, this.filePath);

      this.lastWriteOkAt = new Date().toISOString();
      this.lastWriteError = null;
    } catch (error) {
      this.lastWriteErrorAt = new Date().toISOString();
      this.lastWriteError = describeError(error);
      this.logger.error(
        `Could not persist monitoring state to ${this.filePath}: ${describeError(error)}`,
      );

      throw error;
    }
  }

  private applyDocument(document: MonitoringDocument): void {
    this.watches.clear();
    for (const watch of document.watches ?? []) {
      this.watches.set(watch.key, { ...watch });
    }

    this.jobs.clear();
    for (const job of document.jobs ?? []) {
      this.jobs.set(job.name, { ...job });
    }

    this.notifications.clear();
    for (const notification of document.notifications ?? []) {
      this.notifications.set(notification.notificationId, { ...notification });
    }

    this.sequences = new Map(Object.entries(document.sequences ?? {}));
  }
}

function isDocumentShape(value: unknown): value is MonitoringDocument {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<MonitoringDocument>;

  return (
    Array.isArray(candidate.watches) &&
    Array.isArray(candidate.jobs) &&
    Array.isArray(candidate.notifications)
  );
}

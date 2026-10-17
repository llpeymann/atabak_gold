import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describeError } from '../common/log-safety';
import { PersistenceMonitor } from '../common/persistence-monitor.service';
import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import {
  ChannelSettings,
  ContentItem,
  MovementEventState,
  PersistedChannelData,
  PublicationDelivery,
  PublicationJob,
  RangeEventState,
} from './channel.types';

const CHANNEL_DATA_VERSION = 1;

/**
 * Critical section over the channel document.
 *
 * The callback must not be `async`: every mutation inside it is applied without yielding, so two
 * concurrent callers cannot interleave. This is what makes "create the job only once" and
 * "PENDING → PUBLISHING" atomic *inside the process* (§12) — the deployment runs a single
 * application process, and this limitation is documented rather than hidden behind an in-memory
 * boolean somewhere else in the code.
 */
export interface PublicationTransaction {
  findContent(id: string): ContentItem | null;
  listContents(): ContentItem[];
  saveContent(content: ContentItem): void;

  findJob(id: string): PublicationJob | null;
  findJobByIdempotencyKey(key: string): PublicationJob | null;
  listJobs(): PublicationJob[];
  saveJob(job: PublicationJob): void;

  findDelivery(
    jobId: string,
    platform: Platform,
    destination: string,
  ): PublicationDelivery | null;
  listDeliveries(jobId: string): PublicationDelivery[];
  saveDelivery(delivery: PublicationDelivery): void;

  getMovementEvent(symbol: string, dayKey: string): MovementEventState | null;
  saveMovementEvent(state: MovementEventState): void;
  listMovementEvents(): MovementEventState[];

  getRangeEvent(symbol: string, dayKey: string): RangeEventState | null;
  saveRangeEvent(state: RangeEventState): void;
  listRangeEvents(): RangeEventState[];

  /** Phase 10 — operational settings. A missing object means “publishing enabled”. */
  getSettings(): ChannelSettings;
  saveSettings(settings: ChannelSettings): void;
}

class PublicationTransactionImpl implements PublicationTransaction {
  changed = false;

  constructor(
    private readonly contents: Map<string, ContentItem>,
    private readonly jobs: Map<string, PublicationJob>,
    private readonly deliveries: Map<string, PublicationDelivery>,
    private readonly movementEvents: Map<string, MovementEventState>,
    private readonly rangeEvents: Map<string, RangeEventState>,
    private readonly settingSlots: Map<string, ChannelSettings>,
  ) {}

  getSettings(): ChannelSettings {
    const stored = this.settingSlots.get('channel');

    return stored ? { ...stored } : { publishingEnabled: true };
  }

  saveSettings(settings: ChannelSettings): void {
    this.settingSlots.set('channel', { ...settings });
    this.changed = true;
  }

  findContent(id: string): ContentItem | null {
    const content = this.contents.get(id);

    return content ? { ...content } : null;
  }

  listContents(): ContentItem[] {
    return [...this.contents.values()].map((content) => ({ ...content }));
  }

  saveContent(content: ContentItem): void {
    this.contents.set(content.id, { ...content });
    this.changed = true;
  }

  findJob(id: string): PublicationJob | null {
    const job = this.jobs.get(id);

    return job ? { ...job } : null;
  }

  findJobByIdempotencyKey(key: string): PublicationJob | null {
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey === key) {
        return { ...job };
      }
    }

    return null;
  }

  listJobs(): PublicationJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  saveJob(job: PublicationJob): void {
    this.jobs.set(job.id, { ...job });
    this.changed = true;
  }

  findDelivery(
    jobId: string,
    platform: Platform,
    destination: string,
  ): PublicationDelivery | null {
    for (const delivery of this.deliveries.values()) {
      if (
        delivery.publicationJobId === jobId &&
        delivery.platform === platform &&
        delivery.destination === destination
      ) {
        return { ...delivery };
      }
    }

    return null;
  }

  listDeliveries(jobId: string): PublicationDelivery[] {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.publicationJobId === jobId)
      .map((delivery) => ({ ...delivery }));
  }

  saveDelivery(delivery: PublicationDelivery): void {
    this.deliveries.set(delivery.id, { ...delivery });
    this.changed = true;
  }

  getMovementEvent(symbol: string, dayKey: string): MovementEventState | null {
    const state = this.movementEvents.get(`${symbol}|${dayKey}`);

    return state ? { ...state } : null;
  }

  saveMovementEvent(state: MovementEventState): void {
    this.movementEvents.set(`${state.symbol}|${state.dayKey}`, { ...state });
    this.changed = true;
  }

  listMovementEvents(): MovementEventState[] {
    return [...this.movementEvents.values()].map((state) => ({ ...state }));
  }

  getRangeEvent(symbol: string, dayKey: string): RangeEventState | null {
    const state = this.rangeEvents.get(`${symbol}|${dayKey}`);

    return state ? { ...state } : null;
  }

  saveRangeEvent(state: RangeEventState): void {
    this.rangeEvents.set(`${state.symbol}|${state.dayKey}`, { ...state });
    this.changed = true;
  }

  listRangeEvents(): RangeEventState[] {
    return [...this.rangeEvents.values()].map((state) => ({ ...state }));
  }
}

/**
 * Persistence for the Channel Engine: editorial content, publication jobs, per-destination
 * deliveries and the event de-duplication state (§12, §23).
 *
 * Same technology as Phase 1/2/3 (single JSON document, atomic tmp-file + rename, tolerant load,
 * serialized writes) — the project has no relational database and Phase 5 must not introduce one
 * (§4). Publication *history* is what makes restart recovery possible: a confirmed successful
 * delivery is recorded here and can therefore never be repeated after a restart.
 *
 * Retention: history is bounded (`CHANNEL_HISTORY_LIMIT`, default 500 jobs) so the document cannot
 * grow without limit; the oldest finished jobs (and their deliveries) are pruned first, and a
 * cancelled/scheduled content item is never pruned.
 */
@Injectable()
export class PublicationStore {
  private readonly logger = new Logger(PublicationStore.name);
  private readonly filePath: string | null;
  private readonly historyLimit: number;

  private readonly contents = new Map<string, ContentItem>();
  private readonly jobs = new Map<string, PublicationJob>();
  private readonly deliveries = new Map<string, PublicationDelivery>();
  private readonly movementEvents = new Map<string, MovementEventState>();
  private readonly rangeEvents = new Map<string, RangeEventState>();

  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  /** Phase 10 — one durable settings slot (the only key used is `channel`). */
  private readonly settingSlots = new Map<string, ChannelSettings>();

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    this.filePath = this.config.channelDataFile;
    this.historyLimit = this.config.channelHistoryLimit;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  /**
   * Phase 10 — the durable operational switch, read straight from the store that owns the jobs. A
   * document written before Phase 10 has no settings object, and that means “publishing enabled”,
   * which is exactly the behaviour those deployments already had (§15.1) — a migration never turns
   * publishing off.
   */
  get settings(): ChannelSettings {
    const stored = this.settingSlots.get('channel');

    return stored
      ? { ...stored }
      : {
          publishingEnabled: true,
          publishingChangedBy: null,
          publishingChangedAt: null,
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

      if (!this.isPersistedData(parsed)) {
        this.logger.warn(
          `Channel data file ${this.filePath} has an unexpected shape — starting with no history.`,
        );
        return;
      }

      for (const content of parsed.contents) {
        if (this.isContentShape(content)) {
          this.contents.set(content.id, content);
        }
      }

      for (const job of parsed.jobs) {
        if (this.isJobShape(job)) {
          this.jobs.set(job.id, job);
        }
      }

      for (const delivery of parsed.deliveries) {
        if (this.isDeliveryShape(delivery)) {
          this.deliveries.set(delivery.id, delivery);
        }
      }

      for (const state of parsed.movementEvents ?? []) {
        if (this.isMovementEventShape(state)) {
          this.movementEvents.set(`${state.symbol}|${state.dayKey}`, state);
        }
      }

      for (const state of parsed.rangeEvents ?? []) {
        if (this.isRangeEventShape(state)) {
          this.rangeEvents.set(`${state.symbol}|${state.dayKey}`, state);
        }
      }

      // Phase 10 — the operational switch survives a restart. A document without it (every
      // pre-Phase-10 file) means “publishing enabled”, exactly as before.
      if (
        parsed.settings &&
        typeof parsed.settings.publishingEnabled === 'boolean'
      ) {
        this.settingSlots.set('channel', {
          publishingEnabled: parsed.settings.publishingEnabled,
          publishingChangedBy: parsed.settings.publishingChangedBy ?? null,
          publishingChangedAt: parsed.settings.publishingChangedAt ?? null,
        });
      }

      this.logger.log(
        `Restored ${this.jobs.size} publication job(s), ${this.deliveries.size} delivery record(s) ` +
          `and ${this.contents.size} content item(s) from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted channel data found at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read channel data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads (no critical section needed) -------------------------------------

  findContent(id: string): ContentItem | null {
    const content = this.contents.get(id);

    return content ? { ...content } : null;
  }

  listContents(): ContentItem[] {
    return [...this.contents.values()]
      .map((content) => ({ ...content }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Content items that are approved and due at or before `now` (scheduling input, §7). */
  listDueContents(now: Date): ContentItem[] {
    const nowIso = now.toISOString();

    return this.listContents().filter(
      (content) =>
        content.status === 'SCHEDULED' &&
        content.scheduledAt !== null &&
        content.scheduledAt <= nowIso,
    );
  }

  findJob(id: string): PublicationJob | null {
    const job = this.jobs.get(id);

    return job ? { ...job } : null;
  }

  findJobByIdempotencyKey(key: string): PublicationJob | null {
    for (const job of this.jobs.values()) {
      if (job.idempotencyKey === key) {
        return { ...job };
      }
    }

    return null;
  }

  listJobs(): PublicationJob[] {
    return [...this.jobs.values()]
      .map((job) => ({ ...job }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Jobs that were interrupted mid-flight (`PUBLISHING` without a completion). */
  listInterruptedJobs(): PublicationJob[] {
    return this.listJobs().filter((job) => job.status === 'PUBLISHING');
  }

  listDeliveries(jobId: string): PublicationDelivery[] {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.publicationJobId === jobId)
      .map((delivery) => ({ ...delivery }));
  }

  /** Event de-duplication state of one symbol+day (read-only, §17/§18). */
  getMovementEvent(symbol: string, dayKey: string): MovementEventState | null {
    const state = this.movementEvents.get(`${symbol}|${dayKey}`);

    return state ? { ...state } : null;
  }

  /** Daily-range event state of one symbol+day (read-only, §18). */
  getRangeEvent(symbol: string, dayKey: string): RangeEventState | null {
    const state = this.rangeEvents.get(`${symbol}|${dayKey}`);

    return state ? { ...state } : null;
  }

  get jobCount(): number {
    return this.jobs.size;
  }

  get contentCount(): number {
    return this.contents.size;
  }

  // --- writes -----------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   * `T` must not be a promise: the section never yields (§12).
   */
  async transact<T>(operation: (tx: PublicationTransaction) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const tx = new PublicationTransactionImpl(
        this.contents,
        this.jobs,
        this.deliveries,
        this.movementEvents,
        this.rangeEvents,
        this.settingSlots,
      );

      const result = operation(tx);

      if (tx.changed) {
        this.pruneHistory();
        await this.writeFile(this.snapshot());
      }

      return result;
    });

    // Keep the chain alive even when one operation rejects, so a failed write never blocks the
    // next publication for the rest of the process lifetime.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  /**
   * Keep the document bounded: only *finished* jobs are pruned, oldest first, together with their
   * deliveries. Scheduled/pending work and content items are never pruned (§23).
   */
  private pruneHistory(): void {
    if (this.jobs.size <= this.historyLimit) {
      return;
    }

    const removable = [...this.jobs.values()]
      .filter((job) => job.status !== 'PENDING' && job.status !== 'PUBLISHING')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const excess = this.jobs.size - this.historyLimit;

    for (const job of removable.slice(0, excess)) {
      this.jobs.delete(job.id);

      for (const delivery of [...this.deliveries.values()]) {
        if (delivery.publicationJobId === job.id) {
          this.deliveries.delete(delivery.id);
        }
      }
    }
  }

  private snapshot(): PersistedChannelData {
    return {
      version: CHANNEL_DATA_VERSION,
      savedAt: new Date().toISOString(),
      contents: [...this.contents.values()],
      jobs: [...this.jobs.values()],
      deliveries: [...this.deliveries.values()],
      movementEvents: [...this.movementEvents.values()],
      rangeEvents: [...this.rangeEvents.values()],
      settings: this.settingSlots.get('channel') ?? { publishingEnabled: true },
    };
  }

  private async writeFile(data: PersistedChannelData): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);
      this.persistence?.success('channel-data');
    } catch (error) {
      this.logger.error(
        `Could not persist channel data to ${this.filePath}: ${describeError(error)}`,
      );
      this.persistence?.failure('channel-data', 'write', error);
    }
  }

  // --- tolerant shape guards ---------------------------------------------------

  private isPersistedData(value: unknown): value is PersistedChannelData {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<PersistedChannelData>;

    return (
      Array.isArray(candidate.contents) &&
      Array.isArray(candidate.jobs) &&
      Array.isArray(candidate.deliveries)
    );
  }

  private isContentShape(value: unknown): value is ContentItem {
    const candidate = value as Partial<ContentItem> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.messageType === 'string' &&
      typeof candidate.body === 'string' &&
      typeof candidate.revision === 'number'
    );
  }

  private isJobShape(value: unknown): value is PublicationJob {
    const candidate = value as Partial<PublicationJob> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.messageType === 'string' &&
      typeof candidate.idempotencyKey === 'string'
    );
  }

  private isDeliveryShape(value: unknown): value is PublicationDelivery {
    const candidate = value as Partial<PublicationDelivery> | null;

    return (
      typeof candidate?.id === 'string' &&
      typeof candidate.publicationJobId === 'string' &&
      typeof candidate.platform === 'string'
    );
  }

  private isMovementEventShape(value: unknown): value is MovementEventState {
    const candidate = value as Partial<MovementEventState> | null;

    return (
      typeof candidate?.symbol === 'string' &&
      typeof candidate.dayKey === 'string' &&
      (candidate.lastPublishedAt === null ||
        typeof candidate.lastPublishedAt === 'string')
    );
  }

  private isRangeEventShape(value: unknown): value is RangeEventState {
    const candidate = value as Partial<RangeEventState> | null;

    return (
      typeof candidate?.symbol === 'string' &&
      typeof candidate.dayKey === 'string'
    );
  }
}

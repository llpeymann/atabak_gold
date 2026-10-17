/**
 * Phase 10 — durable storage for administrative state.
 *
 * The project's persistence is a document store (one JSON file, atomic `tmp`→`rename`, one writer per
 * process). Phase 10 follows exactly that convention — no second database engine, no queue, no cache
 * — and keeps the same structural guarantees the other phases rely on (§15.2, §16):
 *
 *  1. **A failed write is never a success.** Operations run against a draft; the draft replaces the
 *     live state only after the file write succeeded. If the write throws, the caller sees the
 *     failure and the in-memory state is untouched — an audit row or a broadcast job can therefore
 *     never be “recorded” for something the disk never received (§13.2, §17).
 *  2. **Uniqueness is checked inside the critical section.** Broadcast references and the
 *     `broadcastId:identityKey` recipient key are indexed in the document and checked while the write
 *     chain is held, so a double-clicked confirmation cannot create two jobs and a retried snapshot
 *     cannot enqueue the same recipient twice (§11.4, §15.3).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describeError } from '../common/log-safety';
import { PersistenceMonitor } from '../common/persistence-monitor.service';
import { AppConfigService } from '../config/app-config.service';
import {
  ADMIN_DOCUMENT_VERSION,
  ActivityRow,
  AdminDocument,
  AuditRecord,
  BroadcastJob,
  BroadcastRecipient,
  IncidentRecord,
} from './admin.types';

/** The write API available inside `AdminStore.transact`. */
export interface AdminTransaction {
  nextId(prefix: string): string;

  findActivity(identityKey: string): ActivityRow | null;
  listActivity(): ActivityRow[];
  saveActivity(row: ActivityRow): void;
  /** Record one active day; returns the stored row (never writes an unchanged row twice). */
  touchActivity(input: {
    identityKey: string;
    platform: ActivityRow['platform'];
    userId: string;
    dayKey: string;
    at: string;
    maxDays: number;
  }): ActivityRow;

  appendAudit(record: AuditRecord): void;
  listAudit(): AuditRecord[];
  countAudit(): number;
  /** Removes the oldest audit rows beyond `keep` (only used when a cap is configured, §13.2). */
  pruneAudit(keep: number): number;

  findIncident(incidentId: string): IncidentRecord | null;
  findIncidentByFingerprint(fingerprint: string): IncidentRecord | null;
  listIncidents(): IncidentRecord[];
  saveIncident(record: IncidentRecord): void;
  removeIncident(incidentId: string): void;

  findBroadcast(broadcastId: string): BroadcastJob | null;
  findBroadcastByReference(reference: string): BroadcastJob | null;
  listBroadcasts(): BroadcastJob[];
  saveBroadcast(job: BroadcastJob): void;

  findRecipient(recipientId: string): BroadcastRecipient | null;
  hasRecipientKey(broadcastId: string, identityKey: string): boolean;
  listRecipients(broadcastId: string): BroadcastRecipient[];
  saveRecipient(recipient: BroadcastRecipient): void;

  recordPruned(counts: {
    incidents: number;
    incidentOccurrences: number;
  }): void;
}

class AdminDraft implements AdminTransaction {
  private readonly activity = new Map<string, ActivityRow>();
  private audit: AuditRecord[] = [];
  private readonly incidentByFingerprint = new Map<string, string>();
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly broadcasts = new Map<string, BroadcastJob>();
  private readonly broadcastReferences = new Map<string, string>();
  private readonly recipients = new Map<string, BroadcastRecipient>();
  private readonly recipientKeys = new Map<string, string>();
  private readonly sequences = new Map<string, number>();
  private pruned = { incidents: 0, incidentOccurrences: 0 };

  changed = false;

  constructor(sequences: Map<string, number>) {
    for (const [prefix, value] of sequences) {
      this.sequences.set(prefix, value);
    }
  }

  seed(input: {
    activity: ActivityRow[];
    audit: AuditRecord[];
    incidents: IncidentRecord[];
    broadcasts: BroadcastJob[];
    recipients: BroadcastRecipient[];
    pruned: { incidents: number; incidentOccurrences: number };
  }): void {
    for (const row of input.activity) {
      this.activity.set(row.identityKey, { ...row, days: [...row.days] });
    }

    this.audit = input.audit.map((row) => ({ ...row }));

    for (const incident of input.incidents) {
      this.incidents.set(incident.incidentId, { ...incident });
      this.incidentByFingerprint.set(incident.fingerprint, incident.incidentId);
    }

    for (const job of input.broadcasts) {
      this.broadcasts.set(job.broadcastId, { ...job });
      this.broadcastReferences.set(job.reference, job.broadcastId);
    }

    for (const recipient of input.recipients) {
      this.recipients.set(recipient.recipientId, { ...recipient });
      this.recipientKeys.set(
        recipientKey(recipient.broadcastId, recipient.identityKey),
        recipient.recipientId,
      );
    }

    this.pruned = { ...input.pruned };
  }

  nextId(prefix: string): string {
    const next = (this.sequences.get(prefix) ?? 0) + 1;
    this.sequences.set(prefix, next);
    this.changed = true;

    return `${prefix}_${next}`;
  }

  // --- activity -----------------------------------------------------------------

  findActivity(identityKey: string): ActivityRow | null {
    const row = this.activity.get(identityKey);

    return row ? { ...row, days: [...row.days] } : null;
  }

  listActivity(): ActivityRow[] {
    return [...this.activity.values()].map((row) => ({
      ...row,
      days: [...row.days],
    }));
  }

  saveActivity(row: ActivityRow): void {
    this.activity.set(row.identityKey, { ...row, days: [...row.days] });
    this.changed = true;
  }

  touchActivity(input: {
    identityKey: string;
    platform: ActivityRow['platform'];
    userId: string;
    dayKey: string;
    at: string;
    maxDays: number;
  }): ActivityRow {
    const existing = this.activity.get(input.identityKey);
    const row: ActivityRow = existing
      ? { ...existing, days: [...existing.days] }
      : {
          identityKey: input.identityKey,
          platform: input.platform,
          userId: input.userId,
          days: [],
          firstSeenAt: input.at,
          lastSeenAt: input.at,
        };

    if (!row.days.includes(input.dayKey)) {
      row.days.push(input.dayKey);
      row.days.sort();
    }

    // Bounded by design: the day list only covers the retention window, so one identity can never
    // grow the document without limit (§16).
    if (row.days.length > input.maxDays) {
      row.days = row.days.slice(row.days.length - input.maxDays);
    }

    row.lastSeenAt = input.at;
    row.userId = input.userId;
    row.platform = input.platform;

    const changed =
      !existing ||
      existing.lastSeenAt !== row.lastSeenAt ||
      existing.days.length !== row.days.length;

    this.activity.set(input.identityKey, row);

    if (changed) {
      this.changed = true;
    }

    return { ...row, days: [...row.days] };
  }

  // --- audit --------------------------------------------------------------------

  appendAudit(record: AuditRecord): void {
    this.audit.push({ ...record });
    this.changed = true;
  }

  listAudit(): AuditRecord[] {
    return this.audit.map((row) => ({ ...row }));
  }

  countAudit(): number {
    return this.audit.length;
  }

  pruneAudit(keep: number): number {
    if (keep <= 0 || this.audit.length <= keep) {
      return 0;
    }

    const removed = this.audit.length - keep;

    // Only the *oldest* rows beyond an explicitly configured cap are dropped, and the caller records
    // that pruning happened (it is itself an audited event, §13.2).
    this.audit = this.audit.slice(removed);
    this.changed = true;

    return removed;
  }

  // --- incidents ----------------------------------------------------------------

  findIncident(incidentId: string): IncidentRecord | null {
    const incident = this.incidents.get(incidentId);

    return incident ? { ...incident } : null;
  }

  findIncidentByFingerprint(fingerprint: string): IncidentRecord | null {
    const incidentId = this.incidentByFingerprint.get(fingerprint);

    return incidentId ? this.findIncident(incidentId) : null;
  }

  listIncidents(): IncidentRecord[] {
    return [...this.incidents.values()].map((row) => ({ ...row }));
  }

  saveIncident(record: IncidentRecord): void {
    this.incidents.set(record.incidentId, { ...record });
    this.incidentByFingerprint.set(record.fingerprint, record.incidentId);
    this.changed = true;
  }

  removeIncident(incidentId: string): void {
    const incident = this.incidents.get(incidentId);

    if (!incident) {
      return;
    }

    this.incidents.delete(incidentId);
    this.incidentByFingerprint.delete(incident.fingerprint);
    this.changed = true;
  }

  // --- broadcasts ---------------------------------------------------------------

  findBroadcast(broadcastId: string): BroadcastJob | null {
    const job = this.broadcasts.get(broadcastId);

    return job ? { ...job, audience: { ...job.audience } } : null;
  }

  findBroadcastByReference(reference: string): BroadcastJob | null {
    const broadcastId = this.broadcastReferences.get(reference);

    return broadcastId ? this.findBroadcast(broadcastId) : null;
  }

  listBroadcasts(): BroadcastJob[] {
    return [...this.broadcasts.values()].map((job) => ({
      ...job,
      audience: { ...job.audience },
    }));
  }

  saveBroadcast(job: BroadcastJob): void {
    this.broadcasts.set(job.broadcastId, {
      ...job,
      audience: { ...job.audience },
    });
    this.broadcastReferences.set(job.reference, job.broadcastId);
    this.changed = true;
  }

  findRecipient(recipientId: string): BroadcastRecipient | null {
    const recipient = this.recipients.get(recipientId);

    return recipient ? { ...recipient } : null;
  }

  hasRecipientKey(broadcastId: string, identityKey: string): boolean {
    return this.recipientKeys.has(recipientKey(broadcastId, identityKey));
  }

  listRecipients(broadcastId: string): BroadcastRecipient[] {
    return [...this.recipients.values()]
      .filter((recipient) => recipient.broadcastId === broadcastId)
      .map((recipient) => ({ ...recipient }));
  }

  saveRecipient(recipient: BroadcastRecipient): void {
    this.recipients.set(recipient.recipientId, { ...recipient });
    this.recipientKeys.set(
      recipientKey(recipient.broadcastId, recipient.identityKey),
      recipient.recipientId,
    );
    this.changed = true;
  }

  recordPruned(counts: {
    incidents: number;
    incidentOccurrences: number;
  }): void {
    this.pruned = {
      incidents: this.pruned.incidents + counts.incidents,
      incidentOccurrences:
        this.pruned.incidentOccurrences + counts.incidentOccurrences,
    };
    this.changed = true;
  }

  toDocument(): AdminDocument {
    return {
      version: ADMIN_DOCUMENT_VERSION,
      savedAt: new Date().toISOString(),
      activity: this.listActivity(),
      audit: this.listAudit(),
      incidents: this.listIncidents(),
      broadcasts: this.listBroadcasts(),
      recipients: [...this.recipients.values()].map((row) => ({ ...row })),
      sequences: Object.fromEntries(this.sequences),
      pruned: { ...this.pruned },
    };
  }

  get sequenceState(): Map<string, number> {
    return new Map(this.sequences);
  }

  get prunedState(): { incidents: number; incidentOccurrences: number } {
    return { ...this.pruned };
  }
}

function recipientKey(broadcastId: string, identityKey: string): string {
  return `${broadcastId}:${identityKey}`;
}

@Injectable()
export class AdminStore {
  private readonly logger = new Logger(AdminStore.name);
  private loaded = false;

  private readonly activity = new Map<string, ActivityRow>();
  private audit: AuditRecord[] = [];
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly incidentByFingerprint = new Map<string, string>();
  private readonly broadcasts = new Map<string, BroadcastJob>();
  private readonly broadcastReferences = new Map<string, string>();
  private readonly recipients = new Map<string, BroadcastRecipient>();
  private readonly recipientKeys = new Map<string, string>();
  private sequences = new Map<string, number>();
  private pruned = { incidents: 0, incidentOccurrences: 0 };
  private writeChain: Promise<void> = Promise.resolve();

  private readonly filePath: string | null;

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    const configured = this.config.adminDataFile;

    // The document path is pinned once, as an absolute path. An audit trail must not depend on the
    // process working directory, and a later `chdir` must never relocate (or orphan) the document.
    this.filePath = configured === null ? null : resolve(configured);
  }

  /** `false` = the admin system runs in memory only (tests, or an explicitly disabled file). */
  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
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

      if (!this.isDocumentShape(parsed)) {
        this.logger.warn(
          `Admin data file ${this.filePath} has an unexpected shape — starting with empty admin state.`,
        );
        return;
      }

      this.applyDocument(parsed);
      this.logger.log(
        `Restored ${this.audit.length} audit row(s), ${this.incidents.size} incident(s), ` +
          `${this.broadcasts.size} broadcast(s) from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted admin data at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read admin data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads --------------------------------------------------------------------

  findActivity(identityKey: string): ActivityRow | null {
    const row = this.activity.get(identityKey);

    return row ? { ...row, days: [...row.days] } : null;
  }

  listActivity(): ActivityRow[] {
    return [...this.activity.values()].map((row) => ({
      ...row,
      days: [...row.days],
    }));
  }

  listAudit(limit?: number): AuditRecord[] {
    const all = this.audit.map((row) => ({ ...row }));

    return typeof limit === 'number' ? all.slice(-limit) : all;
  }

  findIncident(incidentId: string): IncidentRecord | null {
    const incident = this.incidents.get(incidentId);

    return incident ? { ...incident } : null;
  }

  findIncidentByFingerprint(fingerprint: string): IncidentRecord | null {
    const incidentId = this.incidentByFingerprint.get(fingerprint);

    return incidentId ? this.findIncident(incidentId) : null;
  }

  listIncidents(): IncidentRecord[] {
    return [...this.incidents.values()].map((row) => ({ ...row }));
  }

  findBroadcast(broadcastId: string): BroadcastJob | null {
    const job = this.broadcasts.get(broadcastId);

    return job ? { ...job, audience: { ...job.audience } } : null;
  }

  findBroadcastByReference(reference: string): BroadcastJob | null {
    const broadcastId = this.broadcastReferences.get(reference);

    return broadcastId ? this.findBroadcast(broadcastId) : null;
  }

  listBroadcasts(): BroadcastJob[] {
    return [...this.broadcasts.values()].map((job) => ({
      ...job,
      audience: { ...job.audience },
    }));
  }

  findRecipient(recipientId: string): BroadcastRecipient | null {
    const recipient = this.recipients.get(recipientId);

    return recipient ? { ...recipient } : null;
  }

  listRecipients(broadcastId: string): BroadcastRecipient[] {
    return [...this.recipients.values()]
      .filter((recipient) => recipient.broadcastId === broadcastId)
      .map((recipient) => ({ ...recipient }));
  }

  countRecipients(broadcastId: string): number {
    return [...this.recipients.values()].filter(
      (recipient) => recipient.broadcastId === broadcastId,
    ).length;
  }

  get incidentCount(): number {
    return this.incidents.size;
  }

  get auditCount(): number {
    return this.audit.length;
  }

  get prunedCounters(): { incidents: number; incidentOccurrences: number } {
    return { ...this.pruned };
  }

  // --- writes -------------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   *
   * The draft replaces the live state only after the write succeeded, so a failed write leaves the
   * store exactly as it was (§13.2, §17).
   */
  async transact<T>(operation: (tx: AdminTransaction) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const draft = new AdminDraft(this.sequences);

      draft.seed({
        activity: this.listActivity(),
        audit: this.audit,
        incidents: this.listIncidents(),
        broadcasts: this.listBroadcasts(),
        recipients: [...this.recipients.values()].map((row) => ({ ...row })),
        pruned: this.pruned,
      });

      const result = operation(draft);

      if (draft.changed) {
        try {
          await this.writeFile(draft.toDocument());
        } catch (error) {
          this.persistence?.failure('admin-document', 'write', error);
          throw error;
        }

        this.persistence?.success('admin-document');
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

  private commit(draft: AdminDraft): void {
    this.activity.clear();
    for (const row of draft.listActivity()) {
      this.activity.set(row.identityKey, row);
    }

    this.audit = draft.listAudit();

    this.incidents.clear();
    this.incidentByFingerprint.clear();
    for (const incident of draft.listIncidents()) {
      this.incidents.set(incident.incidentId, incident);
      this.incidentByFingerprint.set(incident.fingerprint, incident.incidentId);
    }

    this.broadcasts.clear();
    this.broadcastReferences.clear();
    for (const job of draft.listBroadcasts()) {
      this.broadcasts.set(job.broadcastId, job);
      this.broadcastReferences.set(job.reference, job.broadcastId);
    }

    this.recipients.clear();
    this.recipientKeys.clear();
    for (const job of draft.listBroadcasts()) {
      for (const recipient of draft.listRecipients(job.broadcastId)) {
        this.recipients.set(recipient.recipientId, recipient);
        this.recipientKeys.set(
          recipientKey(recipient.broadcastId, recipient.identityKey),
          recipient.recipientId,
        );
      }
    }

    this.sequences = draft.sequenceState;
    this.pruned = draft.prunedState;
  }

  private async writeFile(document: AdminDocument): Promise<void> {
    if (!this.filePath) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });

    const temporary = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify(document, null, 2)}\n`;

    await writeFile(temporary, payload, 'utf-8');
    await rename(temporary, this.filePath);
  }

  private applyDocument(document: AdminDocument): void {
    this.activity.clear();
    for (const row of document.activity) {
      this.activity.set(row.identityKey, {
        ...row,
        days: [...row.days],
      });
    }

    this.audit = document.audit.map((row) => ({ ...row }));

    this.incidents.clear();
    this.incidentByFingerprint.clear();
    for (const incident of document.incidents) {
      this.incidents.set(incident.incidentId, { ...incident });
      this.incidentByFingerprint.set(incident.fingerprint, incident.incidentId);
    }

    this.broadcasts.clear();
    this.broadcastReferences.clear();
    for (const job of document.broadcasts) {
      this.broadcasts.set(job.broadcastId, job);
      this.broadcastReferences.set(job.reference, job.broadcastId);
    }

    this.recipients.clear();
    this.recipientKeys.clear();
    for (const recipient of document.recipients) {
      this.recipients.set(recipient.recipientId, recipient);
      this.recipientKeys.set(
        recipientKey(recipient.broadcastId, recipient.identityKey),
        recipient.recipientId,
      );
    }

    this.sequences = new Map(Object.entries(document.sequences));
    this.pruned = { ...document.pruned };
  }

  private isDocumentShape(value: unknown): value is AdminDocument {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<AdminDocument>;

    return (
      Array.isArray(candidate.activity) &&
      Array.isArray(candidate.audit) &&
      Array.isArray(candidate.incidents) &&
      Array.isArray(candidate.broadcasts) &&
      Array.isArray(candidate.recipients) &&
      typeof candidate.sequences === 'object' &&
      candidate.sequences !== null
    );
  }
}

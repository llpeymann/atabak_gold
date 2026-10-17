/**
 * Phase 9 — durable storage of leads, activity history, sales outcomes and notification state.
 *
 * The project's storage is a document store (JSON + atomic `tmp`→`rename` write) with one writer per
 * process, and the Sales Engine follows exactly that convention instead of introducing a database
 * engine that the rest of the system does not use (§13, §20).
 *
 * Two properties matter more than anything else here, and both are enforced *structurally*:
 *
 *  1. **A failed write is not a success.** Operations run against a *draft*; the draft replaces the
 *     live state only after the file write succeeded. If the write throws, the caller sees the
 *     failure and the in-memory state is untouched — "lead persisted" can never be reported for a
 *     lead the disk never received (§7, §16.14).
 *  2. **Uniqueness is checked inside the critical section.** References (`SL-…`) and submission keys
 *     are indexed in the same document and checked while the write chain is held, so concurrent
 *     submissions cannot both "win" and a retried confirmation cannot create a second lead (§7.3).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describeError } from '../common/log-safety';
import { PersistenceMonitor } from '../common/persistence-monitor.service';
import { AppConfigService } from '../config/app-config.service';
import {
  LeadActivityRecord,
  LeadRecord,
  SalesDocument,
  SalesNotificationRecord,
  SalesOutcomeRecord,
} from './sales.types';

/** The write API available inside `SalesStore.transact`. */
export interface SalesTransaction {
  nextId(prefix: string): string;

  findLead(leadId: string): LeadRecord | null;
  findLeadByReference(reference: string): LeadRecord | null;
  hasSubmissionKey(submissionKey: string): boolean;
  listLeads(): LeadRecord[];
  listLeadsByIdentity(identityKey: string): LeadRecord[];
  saveLead(lead: LeadRecord): void;

  appendActivity(activity: LeadActivityRecord): void;
  listActivities(leadId: string): LeadActivityRecord[];

  findOutcome(outcomeId: string): SalesOutcomeRecord | null;
  listOutcomes(leadId?: string): SalesOutcomeRecord[];
  saveOutcome(outcome: SalesOutcomeRecord): void;

  findNotification(notificationId: string): SalesNotificationRecord | null;
  findNotificationByKey(key: string): SalesNotificationRecord | null;
  listNotifications(): SalesNotificationRecord[];
  saveNotification(record: SalesNotificationRecord): void;
}

interface SeedInput {
  leads: Map<string, LeadRecord>;
  references: Map<string, string>;
  submissions: Map<string, string>;
  identities: Map<string, Set<string>>;
  activities: LeadActivityRecord[];
  outcomes: Map<string, SalesOutcomeRecord>;
  notifications: Map<string, SalesNotificationRecord>;
  notificationKeys: Map<string, string>;
}

class SalesDraft implements SalesTransaction {
  private readonly leads = new Map<string, LeadRecord>();
  private readonly references = new Map<string, string>();
  private readonly submissions = new Map<string, string>();
  private readonly identities = new Map<string, Set<string>>();
  private activities: LeadActivityRecord[] = [];
  private readonly outcomes = new Map<string, SalesOutcomeRecord>();
  private readonly notifications = new Map<string, SalesNotificationRecord>();
  private readonly notificationKeys = new Map<string, string>();
  private readonly sequences = new Map<string, number>();

  changed = false;

  constructor(sequences: Map<string, number>) {
    for (const [prefix, value] of sequences) {
      this.sequences.set(prefix, value);
    }
  }

  seed(input: SeedInput): void {
    for (const [id, lead] of input.leads) {
      this.leads.set(id, { ...lead });
    }

    for (const [reference, leadId] of input.references) {
      this.references.set(reference, leadId);
    }

    for (const [key, leadId] of input.submissions) {
      this.submissions.set(key, leadId);
    }

    for (const [identityKey, ids] of input.identities) {
      this.identities.set(identityKey, new Set(ids));
    }

    this.activities = input.activities.map((activity) => ({ ...activity }));

    for (const [id, outcome] of input.outcomes) {
      this.outcomes.set(id, { ...outcome });
    }

    for (const [id, notification] of input.notifications) {
      this.notifications.set(id, { ...notification });
    }

    for (const [key, notificationId] of input.notificationKeys) {
      this.notificationKeys.set(key, notificationId);
    }
  }

  nextId(prefix: string): string {
    const next = (this.sequences.get(prefix) ?? 0) + 1;
    this.sequences.set(prefix, next);
    this.changed = true;

    return `${prefix}_${next}`;
  }

  findLead(leadId: string): LeadRecord | null {
    const lead = this.leads.get(leadId);

    return lead ? { ...lead } : null;
  }

  findLeadByReference(reference: string): LeadRecord | null {
    const leadId = this.references.get(reference);

    return leadId ? this.findLead(leadId) : null;
  }

  hasSubmissionKey(submissionKey: string): boolean {
    return this.submissions.has(submissionKey);
  }

  listLeads(): LeadRecord[] {
    return [...this.leads.values()].map((lead) => ({ ...lead }));
  }

  listLeadsByIdentity(identityKey: string): LeadRecord[] {
    const ids = this.identities.get(identityKey);

    if (!ids) {
      return [];
    }

    return [...ids]
      .map((id) => this.findLead(id))
      .filter((lead): lead is LeadRecord => lead !== null);
  }

  saveLead(lead: LeadRecord): void {
    this.leads.set(lead.leadId, { ...lead });
    this.references.set(lead.reference, lead.leadId);

    const ids = this.identities.get(lead.identityKey) ?? new Set<string>();
    ids.add(lead.leadId);
    this.identities.set(lead.identityKey, ids);

    this.submissions.set(lead.submissionKey, lead.leadId);
    this.changed = true;
  }

  appendActivity(activity: LeadActivityRecord): void {
    this.activities.push({ ...activity });
    this.changed = true;
  }

  listActivities(leadId: string): LeadActivityRecord[] {
    return this.activities
      .filter((activity) => activity.leadId === leadId)
      .map((activity) => ({ ...activity }));
  }

  findOutcome(outcomeId: string): SalesOutcomeRecord | null {
    const outcome = this.outcomes.get(outcomeId);

    return outcome ? { ...outcome } : null;
  }

  listOutcomes(leadId?: string): SalesOutcomeRecord[] {
    const all = [...this.outcomes.values()].map((outcome) => ({ ...outcome }));

    return leadId ? all.filter((outcome) => outcome.leadId === leadId) : all;
  }

  saveOutcome(record: SalesOutcomeRecord): void {
    this.outcomes.set(record.outcomeId, { ...record });
    this.changed = true;
  }

  findNotification(notificationId: string): SalesNotificationRecord | null {
    const record = this.notifications.get(notificationId);

    return record ? { ...record } : null;
  }

  findNotificationByKey(key: string): SalesNotificationRecord | null {
    const notificationId = this.notificationKeys.get(key);

    return notificationId ? this.findNotification(notificationId) : null;
  }

  listNotifications(): SalesNotificationRecord[] {
    return [...this.notifications.values()].map((record) => ({ ...record }));
  }

  saveNotification(record: SalesNotificationRecord): void {
    this.notifications.set(record.notificationId, { ...record });
    this.notificationKeys.set(record.key, record.notificationId);
    this.changed = true;
  }

  toDocument(): SalesDocument {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      leads: [...this.leads.values()],
      activities: this.activities,
      outcomes: [...this.outcomes.values()],
      notifications: [...this.notifications.values()],
      sequences: Object.fromEntries(this.sequences),
    };
  }
}

@Injectable()
export class SalesStore {
  private readonly logger = new Logger(SalesStore.name);
  private readonly filePath: string | null;

  private leads = new Map<string, LeadRecord>();
  private references = new Map<string, string>();
  private submissions = new Map<string, string>();
  private identities = new Map<string, Set<string>>();
  private activities: LeadActivityRecord[] = [];
  private outcomes = new Map<string, SalesOutcomeRecord>();
  private notifications = new Map<string, SalesNotificationRecord>();
  private notificationKeys = new Map<string, string>();
  private sequences = new Map<string, number>();

  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    this.filePath = this.config.salesDataFile;
  }

  /** `false` = the Sales Engine runs in memory only (tests, or an explicitly disabled file). */
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
          `Sales data file ${this.filePath} has an unexpected shape — starting with no lead data.`,
        );
        return;
      }

      this.applyDocument(parsed);
      this.logger.log(
        `Restored ${this.leads.size} lead(s), ${this.activities.length} activity row(s), ` +
          `${this.outcomes.size} sales outcome(s) and ${this.notifications.size} notification(s) ` +
          `from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted sales data found at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read sales data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads (no critical section needed: the writer only ever swaps whole records) ---------------

  findLead(leadId: string): LeadRecord | null {
    const lead = this.leads.get(leadId);

    return lead ? { ...lead } : null;
  }

  findLeadByReference(reference: string): LeadRecord | null {
    const leadId = this.references.get(reference);

    return leadId ? this.findLead(leadId) : null;
  }

  listLeads(): LeadRecord[] {
    return [...this.leads.values()].map((lead) => ({ ...lead }));
  }

  listLeadsByIdentity(identityKey: string): LeadRecord[] {
    const ids = this.identities.get(identityKey);

    if (!ids) {
      return [];
    }

    return [...ids]
      .map((id) => this.findLead(id))
      .filter((lead): lead is LeadRecord => lead !== null);
  }

  listActivities(leadId: string): LeadActivityRecord[] {
    return this.activities
      .filter((activity) => activity.leadId === leadId)
      .map((activity) => ({ ...activity }));
  }

  listOutcomes(leadId?: string): SalesOutcomeRecord[] {
    const all = [...this.outcomes.values()].map((outcome) => ({ ...outcome }));

    return leadId ? all.filter((outcome) => outcome.leadId === leadId) : all;
  }

  findNotification(notificationId: string): SalesNotificationRecord | null {
    const record = this.notifications.get(notificationId);

    return record ? { ...record } : null;
  }

  findNotificationByKey(key: string): SalesNotificationRecord | null {
    const notificationId = this.notificationKeys.get(key);

    return notificationId ? this.findNotification(notificationId) : null;
  }

  listNotifications(): SalesNotificationRecord[] {
    return [...this.notifications.values()].map((record) => ({ ...record }));
  }

  get leadCount(): number {
    return this.leads.size;
  }

  get activityCount(): number {
    return this.activities.length;
  }

  // --- writes ------------------------------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   *
   * The operation works on a draft; the draft replaces the live state only after the file write
   * succeeded, so a failed write leaves the store exactly as it was (§7, §16.14).
   */
  async transact<T>(operation: (tx: SalesTransaction) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const draft = new SalesDraft(this.sequences);
      draft.seed({
        leads: this.leads,
        references: this.references,
        submissions: this.submissions,
        identities: this.identities,
        activities: this.activities,
        outcomes: this.outcomes,
        notifications: this.notifications,
        notificationKeys: this.notificationKeys,
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

  private async writeFile(payload: SalesDocument): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);
      this.persistence?.success('sales-data');
    } catch (error) {
      this.logger.error(
        `Could not persist sales data to ${this.filePath}: ${describeError(error)}`,
      );
      this.persistence?.failure('sales-data', 'write', error);
      // Deliberately re-thrown: a caller must never report a stored lead that the disk never got.
      throw new Error(
        `Sales data could not be persisted (${describeError(error)}).`,
      );
    }
  }

  private commit(draft: SalesDraft): void {
    const document = draft.toDocument();

    this.leads = new Map(document.leads.map((lead) => [lead.leadId, lead]));
    this.references = new Map(
      document.leads.map((lead) => [lead.reference, lead.leadId]),
    );
    this.submissions = new Map(
      document.leads.map((lead) => [lead.submissionKey, lead.leadId]),
    );
    this.activities = document.activities;

    const identities = new Map<string, Set<string>>();
    for (const lead of document.leads) {
      const ids = identities.get(lead.identityKey) ?? new Set<string>();
      ids.add(lead.leadId);
      identities.set(lead.identityKey, ids);
    }

    this.identities = identities;
    this.outcomes = new Map(
      document.outcomes.map((outcome) => [outcome.outcomeId, outcome]),
    );
    this.notifications = new Map(
      document.notifications.map((record) => [record.notificationId, record]),
    );
    this.notificationKeys = new Map(
      document.notifications.map((record) => [
        record.key,
        record.notificationId,
      ]),
    );
    this.sequences = new Map(Object.entries(document.sequences));
  }

  private applyDocument(document: SalesDocument): void {
    this.leads = new Map(document.leads.map((lead) => [lead.leadId, lead]));
    this.references = new Map(
      document.leads.map((lead) => [lead.reference, lead.leadId]),
    );
    this.submissions = new Map(
      document.leads.map((lead) => [lead.submissionKey, lead.leadId]),
    );
    this.activities = document.activities;

    const identities = new Map<string, Set<string>>();
    for (const lead of document.leads) {
      const ids = identities.get(lead.identityKey) ?? new Set<string>();
      ids.add(lead.leadId);
      identities.set(lead.identityKey, ids);
    }

    this.identities = identities;
    this.outcomes = new Map(
      document.outcomes.map((outcome) => [outcome.outcomeId, outcome]),
    );
    this.notifications = new Map(
      document.notifications.map((record) => [record.notificationId, record]),
    );
    this.notificationKeys = new Map(
      document.notifications.map((record) => [
        record.key,
        record.notificationId,
      ]),
    );
    this.sequences = new Map(Object.entries(document.sequences));
  }

  /** Shape guard: a truncated or foreign file is refused instead of half-loaded. */
  private isDocumentShape(value: unknown): value is SalesDocument {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<SalesDocument>;

    return (
      Array.isArray(candidate.leads) &&
      Array.isArray(candidate.activities) &&
      Array.isArray(candidate.outcomes) &&
      Array.isArray(candidate.notifications) &&
      typeof candidate.sequences === 'object' &&
      candidate.sequences !== null
    );
  }
}

/** `platform:platformUserId` — the existing identity key, identical to Phase 7/8 (§7.1). */
export function identityKeyOf(
  platform: 'bale' | 'telegram',
  platformUserId: string,
): string {
  return `${platform}:${platformUserId}`;
}

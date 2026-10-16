import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import {
  CampaignAttributionRecord,
  CampaignAuditRecord,
  CampaignDocument,
  CampaignEventRecord,
  CampaignRecord,
  CampaignTouch,
  CampaignRejectionRecord,
  ConversionRecord,
  ExternalMetricImportRecord,
  FunnelStage,
  MembershipObservationRecord,
} from './campaign.types';

const CAMPAIGN_DATA_VERSION = 1;

/** Stages that count as an attribution *touch* (§10.1). */
const TOUCH_STAGES: readonly FunnelStage[] = ['CLICK', 'START', 'CHANNEL_JOIN'];

export function isTouchStage(stage: FunnelStage): boolean {
  return TOUCH_STAGES.includes(stage);
}

export function identityKeyOf(
  platform: Platform,
  platformUserId: string,
): string {
  return `${platform}:${platformUserId}`;
}

/**
 * The synchronous critical section over the campaign document.
 *
 * As in `AlertStore`, the callback must not be `async`: every invariant — unique tokens, unique
 * idempotency keys, attribution updates — is applied without yielding, so two concurrent ingestions
 * cannot interleave. Unlike `AlertStore`, a *failed write is not swallowed*: the draft is discarded
 * and the error propagates, so a caller can never report a successful ingestion that was not
 * persisted (§11.4).
 */
export interface CampaignTransaction {
  listCampaigns(): CampaignRecord[];
  findCampaign(campaignId: string): CampaignRecord | null;
  findCampaignByToken(token: string): CampaignRecord | null;
  saveCampaign(campaign: CampaignRecord): void;
  findAttribution(identityKey: string): CampaignAttributionRecord | null;
  listAttributions(): CampaignAttributionRecord[];
  saveAttribution(attribution: CampaignAttributionRecord): void;
  /** `true` when a record with this idempotency key already exists (§11.2). */
  hasEventKey(idempotencyKey: string): boolean;
  findEvent(eventId: string): CampaignEventRecord | null;
  listEvents(): CampaignEventRecord[];
  /** Newest first; `identityKey` narrows to one identity (used by attribution, §10). */
  listTouches(identityKey: string): CampaignTouch[];
  saveEvent(event: CampaignEventRecord): void;
  /** Raw-request retention only (§21); used exclusively for `CLICK` events. */
  removeEvent(eventId: string): void;
  findConversion(conversionId: string): ConversionRecord | null;
  listConversions(): ConversionRecord[];
  saveConversion(conversion: ConversionRecord): void;
  findImport(dedupKey: string): ExternalMetricImportRecord | null;
  listImports(): ExternalMetricImportRecord[];
  saveImport(record: ExternalMetricImportRecord): void;
  appendAudit(record: CampaignAuditRecord): void;
  findMembership(identityKey: string): MembershipObservationRecord | null;
  listMemberships(): MembershipObservationRecord[];
  saveMembership(record: MembershipObservationRecord): void;
  findRejection(key: string): CampaignRejectionRecord | null;
  listRejections(): CampaignRejectionRecord[];
  saveRejection(record: CampaignRejectionRecord): void;
  /** Monotonic id sequence per prefix (`cmp`, `evt`, `cnv`, `imp`, `aud`). */
  nextId(prefix: string): string;
}

/** Persistence for the campaign subsystem (same JSON + tmp/rename technology as every other store). */
@Injectable()
export class CampaignStore {
  private readonly logger = new Logger(CampaignStore.name);
  private readonly filePath: string | null;

  private campaigns = new Map<string, CampaignRecord>();
  private tokenIndex = new Map<string, string>();
  private attributions = new Map<string, CampaignAttributionRecord>();
  private events: CampaignEventRecord[] = [];
  private eventKeys = new Map<string, string>();
  /** Identity → event ids of its touches, so attribution never scans the whole document (§17). */
  private touchesByIdentity = new Map<string, Set<string>>();
  private conversions = new Map<string, ConversionRecord>();
  private importKeys = new Map<string, string>();
  private imports = new Map<string, ExternalMetricImportRecord>();
  private audit: CampaignAuditRecord[] = [];
  private memberships = new Map<string, MembershipObservationRecord>();
  private rejections = new Map<string, CampaignRejectionRecord>();
  private sequences = new Map<string, number>();

  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfigService) {
    this.filePath = this.config.campaignDataFile;
  }

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
          `Campaign data file ${this.filePath} has an unexpected shape — starting with no campaign data.`,
        );
        return;
      }

      this.applyDocument(parsed);
      this.logger.log(
        `Restored ${this.campaigns.size} campaign(s), ${this.attributions.size} attribution record(s), ` +
          `${this.events.length} event(s) and ${this.conversions.size} conversion(s) from ${this.filePath}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted campaign data found at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read campaign data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads (no critical section needed) -------------------------------------

  findCampaign(campaignId: string): CampaignRecord | null {
    const campaign = this.campaigns.get(campaignId);

    return campaign ? { ...campaign } : null;
  }

  findCampaignByToken(token: string): CampaignRecord | null {
    const id = this.tokenIndex.get(token);

    return id ? this.findCampaign(id) : null;
  }

  listCampaigns(): CampaignRecord[] {
    return [...this.campaigns.values()].map((campaign) => ({ ...campaign }));
  }

  findAttribution(identityKey: string): CampaignAttributionRecord | null {
    const record = this.attributions.get(identityKey);

    return record ? { ...record, models: [...record.models] } : null;
  }

  listAttributions(): CampaignAttributionRecord[] {
    return [...this.attributions.values()].map((record) => ({
      ...record,
      models: [...record.models],
    }));
  }

  listEvents(): CampaignEventRecord[] {
    return this.events.map((event) => ({ ...event, meta: { ...event.meta } }));
  }

  /**
   * Touches of one identity (`CLICK`/`START`/`CHANNEL_JOIN`), read through the identity index so an
   * attribution lookup never scans the whole document (§17 “no N+1”).
   */
  listTouches(identityKey: string): CampaignTouch[] {
    const ids = this.touchesByIdentity.get(identityKey);

    if (!ids) {
      return [];
    }

    const touches: CampaignTouch[] = [];

    for (const id of ids) {
      const event = this.events.find((candidate) => candidate.eventId === id);

      if (!event || !event.identityKey || !event.campaignId) {
        continue;
      }

      touches.push({
        campaignId: event.campaignId,
        occurredAt: new Date(event.occurredAt),
        recordedAt: new Date(event.recordedAt),
        eventId: event.eventId,
        type: event.type as 'CLICK' | 'START' | 'CHANNEL_JOIN',
      });
    }

    return touches;
  }

  listConversions(): ConversionRecord[] {
    return [...this.conversions.values()].map((record) => ({ ...record }));
  }

  listImports(): ExternalMetricImportRecord[] {
    return [...this.imports.values()].map((record) => ({ ...record }));
  }

  listAudit(): CampaignAuditRecord[] {
    return this.audit.map((record) => ({ ...record }));
  }

  findMembership(identityKey: string): MembershipObservationRecord | null {
    const record = this.memberships.get(identityKey);

    return record ? { ...record } : null;
  }

  listRejections(): CampaignRejectionRecord[] {
    return [...this.rejections.values()].map((record) => ({ ...record }));
  }

  get campaignCount(): number {
    return this.campaigns.size;
  }

  get eventCount(): number {
    return this.events.length;
  }

  // --- writes -----------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   *
   * The operation works on a *draft*; the draft replaces the live state only after the file write
   * succeeded. A failed write therefore leaves the store exactly as it was, which is what makes
   * “failed persistence” distinguishable from “successful ingestion” (§11.4).
   */
  async transact<T>(operation: (tx: CampaignTransaction) => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const draft = new CampaignDraft(this.sequences);
      this.seedDraft(draft);
      const result = operation(draft);

      if (draft.changed && this.filePath) {
        await this.writeFile(draft.toDocument());
      }

      if (draft.changed) {
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

  private async writeFile(payload: CampaignDocument): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      this.logger.error(
        `Could not persist campaign data to ${this.filePath}: ${describeError(error)}`,
      );
      // Deliberately re-thrown: callers must not treat this ingestion as recorded (§11.4).
      throw new Error(
        `Campaign data could not be persisted (${describeError(error)}).`,
      );
    }
  }

  private seedDraft(draft: CampaignDraft): void {
    draft.seed({
      campaigns: this.campaigns,
      tokenIndex: this.tokenIndex,
      attributions: this.attributions,
      events: this.events,
      eventKeys: this.eventKeys,
      conversions: this.conversions,
      importKeys: this.importKeys,
      imports: this.imports,
      audit: this.audit,
      memberships: this.memberships,
      rejections: this.rejections,
    });
  }

  private commit(draft: CampaignDraft): void {
    this.campaigns = draft.campaignsOut();
    this.attributions = draft.attributionsOut();
    this.events = draft.eventsOut();
    this.imports = draft.importsOut();
    this.conversions = draft.conversionsOut();
    this.audit = draft.auditOut();
    this.memberships = draft.membershipsOut();
    this.rejections = draft.rejectionsOut();
    this.sequences = draft.sequencesOut();
    this.rebuildIndexes();
  }

  private rebuildIndexes(): void {
    this.tokenIndex = new Map();
    this.eventKeys = new Map();
    this.touchesByIdentity = new Map();
    this.importKeys = new Map();

    for (const campaign of this.campaigns.values()) {
      this.tokenIndex.set(campaign.trackingToken, campaign.campaignId);
    }

    for (const event of this.events) {
      this.eventKeys.set(event.idempotencyKey, event.eventId);

      if (event.identityKey && isTouchStage(event.type)) {
        const ids =
          this.touchesByIdentity.get(event.identityKey) ?? new Set<string>();
        ids.add(event.eventId);
        this.touchesByIdentity.set(event.identityKey, ids);
      }
    }

    for (const record of this.imports.values()) {
      this.importKeys.set(record.dedupKey, record.importId);
    }
  }

  private applyDocument(document: CampaignDocument): void {
    this.campaigns = new Map();
    this.attributions = new Map();
    this.events = [];
    this.conversions = new Map();
    this.imports = new Map();
    this.audit = [];
    this.memberships = new Map();
    this.rejections = new Map();
    this.sequences = new Map();

    for (const campaign of document.campaigns) {
      if (this.isCampaignShape(campaign)) {
        this.campaigns.set(campaign.campaignId, { ...campaign });
      }
    }

    for (const attribution of document.attributions) {
      if (
        typeof attribution.identityKey === 'string' &&
        typeof attribution.platform === 'string'
      ) {
        this.attributions.set(attribution.identityKey, {
          ...attribution,
          models: Array.isArray(attribution.models)
            ? [...attribution.models]
            : [],
        });
      }
    }

    for (const event of document.events) {
      if (typeof event.eventId === 'string' && typeof event.type === 'string') {
        this.events.push({ ...event, meta: { ...(event.meta ?? {}) } });
      }
    }

    for (const conversion of document.conversions) {
      if (typeof conversion.conversionId === 'string') {
        this.conversions.set(conversion.conversionId, { ...conversion });
      }
    }

    for (const record of document.imports) {
      if (typeof record.importId === 'string') {
        this.imports.set(record.importId, { ...record });
      }
    }

    for (const entry of document.audit ?? []) {
      if (typeof entry.auditId === 'string') {
        this.audit.push({ ...entry });
      }
    }

    this.memberships = new Map();

    for (const observation of document.membership ?? []) {
      if (typeof observation.identityKey === 'string') {
        this.memberships.set(observation.identityKey, { ...observation });
      }
    }

    this.rejections = new Map();

    for (const rejection of document.rejections ?? []) {
      if (typeof rejection.key === 'string') {
        this.rejections.set(rejection.key, { ...rejection });
      }
    }

    for (const [prefix, value] of Object.entries(document.sequences ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.sequences.set(prefix, value);
      }
    }

    // A document written by an older build may lack sequences: derive them from what is stored, so a
    // generated id can never collide with an existing one.
    for (const id of this.campaigns.keys()) {
      this.bumpSequenceFromId('cmp', id);
    }

    for (const event of this.events) {
      this.bumpSequenceFromId('evt', event.eventId);
    }

    for (const id of this.conversions.keys()) {
      this.bumpSequenceFromId('cnv', id);
    }

    for (const id of this.imports.keys()) {
      this.bumpSequenceFromId('imp', id);
    }

    for (const entry of this.audit) {
      this.bumpSequenceFromId('aud', entry.auditId);
    }

    this.rebuildIndexes();
  }

  private bumpSequenceFromId(prefix: string, id: string): void {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(id);

    if (!match) {
      return;
    }

    const value = Number(match[1]);
    const current = this.sequences.get(prefix) ?? 0;

    if (value > current) {
      this.sequences.set(prefix, value);
    }
  }

  private isDocumentShape(value: unknown): value is CampaignDocument {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<CampaignDocument>;

    return (
      Array.isArray(candidate.campaigns) &&
      Array.isArray(candidate.attributions) &&
      Array.isArray(candidate.events) &&
      Array.isArray(candidate.conversions) &&
      Array.isArray(candidate.imports)
    );
  }

  private isCampaignShape(value: unknown): value is CampaignRecord {
    const candidate = value as Partial<CampaignRecord> | null;

    return (
      typeof candidate?.campaignId === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.trackingToken === 'string' &&
      typeof candidate.status === 'string'
    );
  }
}

/**
 * Working copy of one transaction.
 *
 * Collections are copied (records are flat, so a shallow copy of each record is a real copy) and the
 * caller mutates only the draft. `sequences` is shared on purpose: a consumed id is never handed out
 * again, even when the transaction is discarded after a failed write.
 */
class CampaignDraft implements CampaignTransaction {
  private campaigns = new Map<string, CampaignRecord>();
  private tokenIndex = new Map<string, string>();
  private attributions = new Map<string, CampaignAttributionRecord>();
  private events: CampaignEventRecord[] = [];
  private eventIndex = new Map<string, CampaignEventRecord>();
  private eventKeys = new Map<string, string>();
  private conversions = new Map<string, ConversionRecord>();
  private imports = new Map<string, ExternalMetricImportRecord>();
  private importKeys = new Map<string, string>();
  private auditLog: CampaignAuditRecord[] = [];
  private memberships = new Map<string, MembershipObservationRecord>();
  private rejections = new Map<string, CampaignRejectionRecord>();

  private dirty = false;

  constructor(private readonly sequences: Map<string, number>) {}

  get changed(): boolean {
    return this.dirty;
  }

  seed(state: {
    campaigns: Map<string, CampaignRecord>;
    tokenIndex: Map<string, string>;
    attributions: Map<string, CampaignAttributionRecord>;
    events: CampaignEventRecord[];
    eventKeys: Map<string, string>;
    conversions: Map<string, ConversionRecord>;
    importKeys: Map<string, string>;
    imports: Map<string, ExternalMetricImportRecord>;
    audit: CampaignAuditRecord[];
    memberships: Map<string, MembershipObservationRecord>;
    rejections: Map<string, CampaignRejectionRecord>;
  }): void {
    this.campaigns = new Map(
      [...state.campaigns.entries()].map(([id, campaign]) => [
        id,
        { ...campaign },
      ]),
    );
    this.tokenIndex = new Map(state.tokenIndex);
    this.attributions = new Map(
      [...state.attributions.entries()].map(([key, record]) => [
        key,
        { ...record, models: [...record.models] },
      ]),
    );
    this.events = state.events.map((event) => ({
      ...event,
      meta: { ...event.meta },
    }));
    this.eventKeys = new Map(state.eventKeys);
    this.conversions = new Map(
      [...state.conversions.entries()].map(([id, record]) => [
        id,
        { ...record },
      ]),
    );
    this.imports = new Map(
      [...state.imports.entries()].map(([id, record]) => [id, { ...record }]),
    );
    this.importKeys = new Map(state.importKeys);
    this.auditLog = state.audit.map((entry) => ({ ...entry }));
    this.memberships = new Map(
      [...state.memberships.entries()].map(([key, record]) => [
        key,
        { ...record },
      ]),
    );
    this.rejections = new Map(
      [...state.rejections.entries()].map(([key, record]) => [
        key,
        { ...record },
      ]),
    );
    this.eventIndex = new Map(
      this.events.map((event) => [event.eventId, event]),
    );
  }

  listCampaigns(): CampaignRecord[] {
    return [...this.campaigns.values()].map((campaign) => ({ ...campaign }));
  }

  findCampaign(campaignId: string): CampaignRecord | null {
    const campaign = this.campaigns.get(campaignId);

    return campaign ? { ...campaign } : null;
  }

  findCampaignByToken(token: string): CampaignRecord | null {
    const id = this.tokenIndex.get(token);

    return id ? this.findCampaign(id) : null;
  }

  saveCampaign(campaign: CampaignRecord): void {
    this.campaigns.set(campaign.campaignId, { ...campaign });
    this.tokenIndex.set(campaign.trackingToken, campaign.campaignId);
    this.dirty = true;
  }

  findAttribution(identityKey: string): CampaignAttributionRecord | null {
    const record = this.attributions.get(identityKey);

    return record ? { ...record, models: [...record.models] } : null;
  }

  listAttributions(): CampaignAttributionRecord[] {
    return [...this.attributions.values()].map((record) => ({
      ...record,
      models: [...record.models],
    }));
  }

  saveAttribution(attribution: CampaignAttributionRecord): void {
    this.attributions.set(attribution.identityKey, {
      ...attribution,
      models: [...attribution.models],
    });
    this.dirty = true;
  }

  hasEventKey(idempotencyKey: string): boolean {
    return this.eventKeys.has(idempotencyKey);
  }

  findEvent(eventId: string): CampaignEventRecord | null {
    const event = this.eventIndex.get(eventId);

    return event ? { ...event, meta: { ...event.meta } } : null;
  }

  listEvents(): CampaignEventRecord[] {
    return this.events.map((event) => ({ ...event, meta: { ...event.meta } }));
  }

  listTouches(identityKey: string): CampaignTouch[] {
    return this.events
      .filter(
        (event) =>
          event.identityKey === identityKey &&
          event.campaignId !== null &&
          isTouchStage(event.type),
      )
      .map((event) => ({
        campaignId: event.campaignId as string,
        occurredAt: new Date(event.occurredAt),
        recordedAt: new Date(event.recordedAt),
        eventId: event.eventId,
        type: event.type as 'CLICK' | 'START' | 'CHANNEL_JOIN',
      }));
  }

  saveEvent(event: CampaignEventRecord): void {
    this.events.push({ ...event, meta: { ...event.meta } });
    this.eventIndex.set(event.eventId, { ...event, meta: { ...event.meta } });
    this.eventKeys.set(event.idempotencyKey, event.eventId);
    this.dirty = true;
  }

  removeEvent(eventId: string): void {
    const event = this.eventIndex.get(eventId);

    if (!event) {
      return;
    }

    this.events = this.events.filter(
      (candidate) => candidate.eventId !== eventId,
    );
    this.eventIndex.delete(eventId);
    this.eventKeys.delete(event.idempotencyKey);
    this.dirty = true;
  }

  findConversion(conversionId: string): ConversionRecord | null {
    const record = this.conversions.get(conversionId);

    return record ? { ...record } : null;
  }

  listConversions(): ConversionRecord[] {
    return [...this.conversions.values()].map((record) => ({ ...record }));
  }

  saveConversion(conversion: ConversionRecord): void {
    this.conversions.set(conversion.conversionId, { ...conversion });
    this.dirty = true;
  }

  findImport(dedupKey: string): ExternalMetricImportRecord | null {
    const id = this.importKeys.get(dedupKey);

    if (!id) {
      return null;
    }

    const record = this.imports.get(id);

    return record ? { ...record } : null;
  }

  listImports(): ExternalMetricImportRecord[] {
    return [...this.imports.values()].map((record) => ({ ...record }));
  }

  saveImport(record: ExternalMetricImportRecord): void {
    this.imports.set(record.importId, { ...record });
    this.importKeys.set(record.dedupKey, record.importId);
    this.dirty = true;
  }

  appendAudit(record: CampaignAuditRecord): void {
    this.auditLog.push({ ...record });
    this.dirty = true;
  }

  findMembership(identityKey: string): MembershipObservationRecord | null {
    const record = this.memberships.get(identityKey);

    return record ? { ...record } : null;
  }

  listMemberships(): MembershipObservationRecord[] {
    return [...this.memberships.values()].map((record) => ({ ...record }));
  }

  saveMembership(record: MembershipObservationRecord): void {
    this.memberships.set(record.identityKey, { ...record });
    this.dirty = true;
  }

  findRejection(key: string): CampaignRejectionRecord | null {
    const record = this.rejections.get(key);

    return record ? { ...record } : null;
  }

  listRejections(): CampaignRejectionRecord[] {
    return [...this.rejections.values()].map((record) => ({ ...record }));
  }

  saveRejection(record: CampaignRejectionRecord): void {
    this.rejections.set(record.key, { ...record });
    this.dirty = true;
  }

  nextId(prefix: string): string {
    const next = (this.sequences.get(prefix) ?? 0) + 1;
    this.sequences.set(prefix, next);

    return `${prefix}_${next}`;
  }

  // --- outputs ----------------------------------------------------------------

  campaignsOut(): Map<string, CampaignRecord> {
    return this.campaigns;
  }

  attributionsOut(): Map<string, CampaignAttributionRecord> {
    return this.attributions;
  }

  eventsOut(): CampaignEventRecord[] {
    return this.events;
  }

  conversionsOut(): Map<string, ConversionRecord> {
    return this.conversions;
  }

  importsOut(): Map<string, ExternalMetricImportRecord> {
    return this.imports;
  }

  auditOut(): CampaignAuditRecord[] {
    return this.auditLog;
  }

  membershipsOut(): Map<string, MembershipObservationRecord> {
    return this.memberships;
  }

  rejectionsOut(): Map<string, CampaignRejectionRecord> {
    return this.rejections;
  }

  sequencesOut(): Map<string, number> {
    return this.sequences;
  }

  toDocument(): CampaignDocument {
    return {
      version: CAMPAIGN_DATA_VERSION,
      savedAt: new Date().toISOString(),
      campaigns: [...this.campaigns.values()].map((campaign) => ({
        ...campaign,
      })),
      attributions: [...this.attributions.values()].map((record) => ({
        ...record,
        models: [...record.models],
      })),
      events: this.events.map((event) => ({
        ...event,
        meta: { ...event.meta },
      })),
      conversions: [...this.conversions.values()].map((record) => ({
        ...record,
      })),
      imports: [...this.imports.values()].map((record) => ({ ...record })),
      audit: this.auditLog.map((entry) => ({ ...entry })),
      membership: [...this.memberships.values()].map((record) => ({
        ...record,
      })),
      rejections: [...this.rejections.values()].map((record) => ({
        ...record,
      })),
      sequences: Object.fromEntries(this.sequences.entries()),
    };
  }
}

/** Raw-touch list of one identity, oldest first (deterministic ordering helper). */
export function sortTouches(touches: CampaignTouch[]): CampaignTouch[] {
  return [...touches].sort((left, right) => {
    const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();

    if (byTime !== 0) {
      return byTime;
    }

    const byRecorded = left.recordedAt.getTime() - right.recordedAt.getTime();

    if (byRecorded !== 0) {
      return byRecorded;
    }

    return left.eventId.localeCompare(right.eventId);
  });
}

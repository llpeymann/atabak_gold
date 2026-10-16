/**
 * Phase 9 — the lead lifecycle (§7, §10, §11).
 *
 * This service owns *durable* lead state: creation with idempotency, the status machine, assignment,
 * follow-up notes, contact attempts, customer conversion and real sale outcomes. It does **not**
 * render anything: every Persian string it returns is an operator/customer-facing *reason*, and the
 * presentation lives in `src/bot/sales/`.
 *
 * Phase 8 integration (mandatory, §12) is done through the existing Phase 8 services only:
 *
 *  * attribution is resolved with `CampaignTrackingService.creditedFor` (the same rules the campaign
 *    dashboard uses — no second attribution implementation),
 *  * `LEAD_CREATED` is represented by the canonical Phase 8 `LEAD` conversion row, written through
 *    `CampaignConversionService.registerConversion`,
 *  * `CUSTOMER_CONVERTED` is represented by the canonical Phase 8 `CUSTOMER` conversion row.
 *
 * A lead is *never* reported as created, converted or sold unless the corresponding write succeeded.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { CampaignConversionService } from '../campaigns/campaign-conversion.service';
import { CampaignService } from '../campaigns/campaign.service';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';
import { LeadAttributionBucket } from './sales.types';
import { generateLeadReference, isLeadReference } from './lead-reference';
import {
  normalizeCategory,
  normalizeCustomerName,
  normalizeNotes,
  normalizeOperatorNote,
  normalizeProductDescription,
} from './lead-validation';
import { normalizePhone, toAsciiDigits } from './phone';
import {
  canTransition,
  isLossReason,
  LeadActivityRecord,
  LeadCreationInput,
  LeadCreationOutcome,
  LeadPhase8Link,
  LeadRecord,
  LeadStatus,
  SalesOutcomeRecord,
  SalesResult,
  salesFail,
  salesOk,
} from './sales.types';
import { identityKeyOf, SalesStore, SalesTransaction } from './sales.store';

/** Statuses that still need work from the sales team. */
const OPEN_STATUSES: readonly LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED'];

/** How many reference-collision retries a single creation may spend before giving up. */
const REFERENCE_ATTEMPTS = 8;

/** How many leads one `/sales retry` pass may repair (bounded work per command, §10.6). */
const REPAIR_BATCH = 50;

export interface LeadQuery {
  /** Free text: public reference (exact), name fragment, or phone fragment. */
  query?: string | null;
  status?: LeadStatus | null;
  category?: string | null;
  campaignId?: string | null;
  from?: Date | null;
  to?: Date | null;
  /** Hard bound on the returned rows (the admin surface paginates). */
  limit: number;
  offset?: number;
}

/** Numeric part of an internal id (`lead_12` → 12); `-1` for anything unexpected. */
function sequenceOf(id: string): number {
  const match = /_(\d+)$/u.exec(id);

  return match ? Number(match[1]) : -1;
}

export interface SalesOutcomeInput {
  amount?: number | null;
  currency?: string | null;
  note?: string | null;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: SalesStore,
    private readonly tracking: CampaignTrackingService,
    private readonly campaigns: CampaignService,
    private readonly conversions: CampaignConversionService,
  ) {}

  /** Master switch of the Sales Engine (`SALES_ENGINE_ENABLED`). */
  get enabled(): boolean {
    return this.config.salesEnabled;
  }

  get disabledReason(): string | null {
    // The switch is named in the message on purpose: an operator who sees “disabled” on screen can
    // find the configuration key without reading the source (§16.2).
    return this.enabled
      ? null
      : 'موتور فروش با تنظیم SALES_ENGINE_ENABLED غیرفعال است.';
  }

  /** Administrators allowed to work on leads (server-side authorization, §10.4). */
  get adminIds(): readonly string[] {
    const dedicated = this.config.salesAdminIds;

    return dedicated.length > 0 ? dedicated : this.config.channelAdminUserIds;
  }

  /**
   * Same matching convention as the Phase 5/8 surfaces: an allow-list entry is either
   * `platform:userId` or a bare `userId`. A missing configuration therefore denies access — the
   * check fails closed, and a user-provided role/id is never treated as proof (§10.4).
   */
  isSalesAdmin(platform: string, platformUserId: string): boolean {
    const entries = this.adminIds;

    return (
      entries.includes(`${platform}:${platformUserId}`) ||
      entries.includes(platformUserId)
    );
  }

  /**
   * Map whatever an operator typed (`900` or `bale:900`) to the configured allow-list entry. The
   * stored value is always the canonical `platform:userId` form, and an ambiguous bare id (the same
   * number registered on both platforms) is refused instead of guessed (§10.4).
   */
  private canonicalAssignee(input: string): string | null {
    const trimmed = input.trim();

    if (this.adminIds.includes(trimmed)) {
      return trimmed;
    }

    const matches = this.adminIds.filter((entry) =>
      entry.endsWith(`:${trimmed}`),
    );

    return matches.length === 1 ? matches[0] : null;
  }

  // --- reads ------------------------------------------------------------------------------------

  findLead(referenceOrId: string): LeadRecord | null {
    const value = referenceOrId.trim();

    if (isLeadReference(value)) {
      return this.store.findLeadByReference(value);
    }

    return this.store.findLead(value);
  }

  listLeadsByIdentity(identityKey: string): LeadRecord[] {
    return this.store
      .listLeadsByIdentity(identityKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listActivities(leadId: string): LeadActivityRecord[] {
    return this.store
      .listActivities(leadId)
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  listOutcomes(leadId: string): SalesOutcomeRecord[] {
    return this.store
      .listOutcomes(leadId)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }

  /** Every stored outcome, newest first (the reporting surface filters nothing away). */
  listAllOutcomes(): SalesOutcomeRecord[] {
    return this.store
      .listOutcomes()
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  }

  activeOutcome(leadId: string): SalesOutcomeRecord | null {
    return (
      this.listOutcomes(leadId).find(
        (outcome) => outcome.status === 'ACTIVE',
      ) ?? null
    );
  }

  /** Bounded, filtered listing used by the admin surface and by the statistics screen. */
  listLeads(query: LeadQuery): LeadRecord[] {
    const limit = Math.max(1, Math.min(query.limit, 100));
    const offset = Math.max(0, query.offset ?? 0);
    const matched = this.filterLeads(query);

    // Newest first, and — because several leads can share the same millisecond — the higher internal
    // sequence wins. The order is therefore deterministic across restarts (§17.1, same rule as the
    // Phase 8 event ordering).
    matched.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        sequenceOf(right.leadId) - sequenceOf(left.leadId),
    );

    return matched.slice(offset, offset + limit);
  }

  /** Every row matching the filters (bounded by nothing but the document itself). */
  private filterLeads(
    query: Omit<LeadQuery, 'limit' | 'offset'>,
  ): LeadRecord[] {
    const from = query.from ? query.from.getTime() : null;
    const to = query.to ? query.to.getTime() : null;
    const needle = query.query?.trim() ?? '';

    return this.store.listLeads().filter((lead) => {
      if (query.status && lead.status !== query.status) {
        return false;
      }

      if (query.category && lead.category !== query.category) {
        return false;
      }

      if (query.campaignId && lead.campaignId !== query.campaignId) {
        return false;
      }

      if (from !== null && Date.parse(lead.createdAt) < from) {
        return false;
      }

      if (to !== null && Date.parse(lead.createdAt) >= to) {
        return false;
      }

      if (needle === '') {
        return true;
      }

      return this.matchesNeedle(lead, needle);
    });
  }

  countLeads(query: Omit<LeadQuery, 'limit' | 'offset'> = {}): number {
    return this.filterLeads(query).length;
  }

  countByStatus(): Record<LeadStatus, number> {
    const counts: Record<LeadStatus, number> = {
      NEW: 0,
      CONTACTED: 0,
      QUALIFIED: 0,
      CONVERTED: 0,
      LOST: 0,
    };

    for (const lead of this.store.listLeads()) {
      counts[lead.status] += 1;
    }

    return counts;
  }

  /**
   * Leads grouped by the campaign label frozen on each lead (§12.1, §11.3).
   *
   * The aggregation happens here, not in the bot layer, so every surface reports the *same* numbers
   * from the *same* store. An unattributed lead is returned under `null` — it is never folded into a
   * campaign bucket, because “we do not know” and “came from campaign X” are different answers.
   */
  countsByCampaignLabel(): {
    campaignId: string | null;
    campaignName: string | null;
    count: number;
  }[] {
    const buckets = new Map<
      string,
      { campaignId: string | null; campaignName: string | null; count: number }
    >();

    for (const lead of this.store.listLeads()) {
      const key = lead.campaignId ?? '__none__';
      const bucket = buckets.get(key) ?? {
        campaignId: lead.campaignId,
        campaignName: lead.campaignName,
        count: 0,
      };

      bucket.count += 1;
      buckets.set(key, bucket);
    }

    return [...buckets.values()].sort(
      (left, right) => right.count - left.count,
    );
  }

  // --- create -----------------------------------------------------------------------------------

  /**
   * Persist one quotation request.
   *
   * Idempotency is keyed on `submissionKey` *inside* the write transaction, so a double-tapped
   * confirmation, a platform redelivery or a retried callback all resolve to the same lead (§7.3).
   * A genuinely new request from the same customer is a **new** lead: the same phone number never
   * merges two submissions.
   */
  async createLead(
    input: LeadCreationInput,
  ): Promise<SalesResult<LeadCreationOutcome>> {
    if (!this.enabled) {
      return salesFail(
        'DISABLED',
        this.disabledReason ?? 'موتور فروش غیرفعال است.',
      );
    }

    // Server-side re-validation: the caller (a callback handler) is not trusted (§15.1, §5.3).
    const name = normalizeCustomerName(input.customerName);

    if (!name.ok) {
      return name;
    }

    const phone = normalizePhone(input.phone);

    if (!phone.ok) {
      return salesFail('INVALID_PHONE', 'شماره تماس واردشده معتبر نیست.');
    }

    const category = normalizeCategory(input.category);

    if (!category.ok) {
      return category;
    }

    const description = normalizeProductDescription(
      input.productDescription ?? '',
    );

    if (!description.ok) {
      return description;
    }

    const notes = normalizeNotes(input.notes ?? '');

    if (!notes.ok) {
      return notes;
    }

    const now = new Date();
    const identityKey =
      input.identityKey || identityKeyOf(input.platform, input.platformUserId);
    const attribution = this.resolveAttribution(identityKey, now);
    const maxOpen = this.config.salesMaxOpenLeadsPerIdentity;

    type CreationOutcome =
      | { kind: 'limit' }
      | { kind: 'replay'; lead: LeadRecord }
      | { kind: 'created'; lead: LeadRecord };

    try {
      const outcome = await this.store.transact<CreationOutcome>((tx) => {
        // 1) Idempotency first: a replay must never create a second lead.
        const replay = this.findBySubmission(tx, input.submissionKey);

        if (replay) {
          return { kind: 'replay', lead: replay };
        }

        // 2) Abuse bound, evaluated inside the transaction so concurrent submissions cannot
        //    both pass the check.
        if (maxOpen > 0) {
          const open = tx
            .listLeadsByIdentity(identityKey)
            .filter((lead) => OPEN_STATUSES.includes(lead.status));

          if (open.length >= maxOpen) {
            return { kind: 'limit' };
          }
        }

        const reference = this.allocateReference(tx);
        const createdAt = now.toISOString();
        const lead: LeadRecord = {
          leadId: tx.nextId('lead'),
          reference,
          submissionKey: input.submissionKey,
          userId: input.userId,
          identityKey,
          platform: input.platform,
          platformUserId: input.platformUserId,
          chatId: input.chatId,
          customerName: name.value,
          phone: phone.value.canonical,
          phoneVerified: false,
          category: category.value,
          productDescription: description.value,
          notes: notes.value,
          status: 'NEW',
          createdAt,
          updatedAt: createdAt,
          consentTextVersion: input.consentTextVersion,
          consentedAt: createdAt,
          assignedTo: null,
          lastContactAt: null,
          contactAttempts: 0,
          lossReason: null,
          lossNote: null,
          campaignId: attribution.campaignId,
          campaignName: attribution.campaignName,
          campaignSource: attribution.campaignSource,
          attributionModel: attribution.model,
          attributionBucket: attribution.bucket,
          attributionReason: attribution.reason,
          attributedAt: attribution.campaignId ? createdAt : null,
          customerConversionId: null,
          customerConvertedAt: null,
          saleOutcomeId: null,
          phase8: {
            status: 'RECORDED',
            conversionId: null,
            attributionModel: attribution.model,
            bucket: attribution.bucket,
            reason: 'در انتظار ثبت در فاز ۸.',
            updatedAt: createdAt,
          },
          phase8Customer: null,
        };

        tx.saveLead(lead);

        tx.appendActivity({
          activityId: tx.nextId('act'),
          leadId: lead.leadId,
          action: 'CREATED',
          actor: input.userId,
          at: createdAt,
          fromStatus: null,
          toStatus: 'NEW',
          summary: 'درخواست استعلام ثبت شد.',
        });

        this.logger.log(
          `Lead ${lead.reference} created (${lead.category}); attribution ` +
            `${lead.campaignId ?? 'unattributed'}; phone not logged.`,
        );

        return { kind: 'created', lead };
      });

      if (outcome.kind === 'limit') {
        return salesFail(
          'LIMIT_REACHED',
          'شما چند درخواست باز دارید. تا بررسی درخواست‌های قبلی توسط کارشناسان، امکان ثبت درخواست تازه نیست.',
        );
      }

      // 3) Phase 8 link — outside the sales transaction because it writes the *campaign* document.
      const created = outcome.kind === 'created';
      const phase8 = created
        ? await this.linkLeadToPhase8(outcome.lead)
        : outcome.lead.phase8;

      return salesOk({
        lead: created ? { ...outcome.lead, phase8 } : outcome.lead,
        created,
        phase8,
      });
    } catch (error) {
      this.logger.error(
        `Could not persist a lead for ${identityKey}: ${describeError(error)}`,
      );

      return salesFail(
        'PERSISTENCE_FAILED',
        'ثبت درخواست انجام نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.',
      );
    }
  }

  // --- follow-up --------------------------------------------------------------------------------

  /** Log a contact attempt (§10.1) — the timestamp is authoritative, the note is optional. */
  async logContact(
    reference: string,
    actor: string,
    note?: string | null,
  ): Promise<SalesResult<LeadRecord>> {
    const normalized = normalizeOperatorNote(note ?? '');

    if (!normalized.ok) {
      return normalized;
    }

    return this.mutate(reference, (lead, tx, at) => {
      const updated: LeadRecord = {
        ...lead,
        lastContactAt: at,
        contactAttempts: lead.contactAttempts + 1,
        updatedAt: at,
      };

      tx.saveLead(updated);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: lead.leadId,
        action: 'CONTACT_LOGGED',
        actor,
        at,
        fromStatus: lead.status,
        toStatus: lead.status,
        summary: normalized.value
          ? `تماس ثبت شد: ${normalized.value}`
          : 'تماس با مشتری ثبت شد.',
      });

      return updated;
    });
  }

  /** Append a follow-up note without touching the status. */
  async addNote(
    reference: string,
    actor: string,
    note: string,
  ): Promise<SalesResult<LeadRecord>> {
    const normalized = normalizeOperatorNote(note);

    if (!normalized.ok || normalized.value === null) {
      return salesFail('INVALID_NOTE', 'متن یادداشت معتبر نیست.');
    }

    return this.mutate(reference, (lead, tx, at) => {
      const updated: LeadRecord = {
        ...lead,
        updatedAt: at,
      };

      tx.saveLead(updated);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: lead.leadId,
        action: 'NOTE_ADDED',
        actor,
        at,
        fromStatus: lead.status,
        toStatus: lead.status,
        summary: `یادداشت: ${normalized.value}`,
      });

      return updated;
    });
  }

  /** Assign the lead to a *configured* administrator (never to an arbitrary id). */
  async assign(
    reference: string,
    assignee: string | null,
    actor: string,
  ): Promise<SalesResult<LeadRecord>> {
    const canonical =
      assignee === null ? null : this.canonicalAssignee(assignee);

    if (assignee !== null && canonical === null) {
      return salesFail(
        'UNAUTHORIZED',
        'فقط کارشناسان مجاز می‌توانند مسئول پیگیری شوند.',
      );
    }

    return this.mutate(reference, (lead, tx, at) => {
      const updated: LeadRecord = {
        ...lead,
        assignedTo: canonical,
        updatedAt: at,
      };

      tx.saveLead(updated);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: lead.leadId,
        action: 'ASSIGNED',
        actor,
        at,
        fromStatus: lead.status,
        toStatus: lead.status,
        summary:
          canonical === null
            ? 'واگذاری برداشته شد'
            : `مسئول پیگیری: ${canonical}`,
      });

      return updated;
    });
  }

  /**
   * Change the status through the documented transition table (§10.2).
   *
   * `CONVERTED` is intentionally *not* reachable here: recording a customer must go through
   * `convertToCustomer`, which also writes the canonical Phase 8 `CUSTOMER` row (§12.3).
   */
  async changeStatus(
    reference: string,
    next: LeadStatus,
    actor: string,
    options: { lossReason?: string | null; note?: string | null } = {},
  ): Promise<SalesResult<LeadRecord>> {
    if (next === 'CONVERTED') {
      return salesFail(
        'INVALID_STATUS_TRANSITION',
        'برای ثبت مشتری از فرمان «تبدیل به مشتری» استفاده کنید.',
      );
    }

    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    if (!canTransition(lead.status, next)) {
      return salesFail(
        'INVALID_STATUS_TRANSITION',
        `تغییر وضعیت از ${lead.status} به ${next} مجاز نیست.`,
      );
    }

    if (next === 'LOST') {
      return this.markLost(
        reference,
        actor,
        options.lossReason ?? '',
        options.note,
      );
    }

    return this.applyStatusChange(lead, next, actor, options.note ?? null);
  }

  /** Record a lost opportunity with a reason from the fixed vocabulary (§11.2). */
  async markLost(
    reference: string,
    actor: string,
    reason: string,
    note?: string | null,
  ): Promise<SalesResult<LeadRecord>> {
    if (!isLossReason(reason)) {
      return salesFail(
        'INVALID_LOSS_REASON',
        'دلیل از دست رفتن درخواست معتبر نیست.',
      );
    }

    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    if (!canTransition(lead.status, 'LOST')) {
      return salesFail(
        'INVALID_STATUS_TRANSITION',
        `ثبت «از دست رفته» از وضعیت ${lead.status} مجاز نیست.`,
      );
    }

    const normalizedNote = normalizeOperatorNote(note ?? '');

    if (!normalizedNote.ok) {
      return normalizedNote;
    }

    return this.mutate(reference, (current, tx, at) => {
      const updated: LeadRecord = {
        ...current,
        status: 'LOST',
        lossReason: reason,
        lossNote: normalizedNote.value,
        updatedAt: at,
      };

      tx.saveLead(updated);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: current.leadId,
        action: 'LOST',
        actor,
        at,
        fromStatus: current.status,
        toStatus: 'LOST',
        summary: `از دست رفته — دلیل: ${reason}`,
      });

      return updated;
    });
  }

  /**
   * Record that the lead became a customer (§11.1) — the only path to `CONVERTED`.
   *
   * Order matters: the local transition is persisted first, and only then is the canonical Phase 8
   * `CUSTOMER` conversion written. If Phase 8 refuses or fails, the lead keeps that state explicitly
   * (`phase8Customer.status`) instead of pretending the campaign side was updated (§12.3).
   */
  async convertToCustomer(
    reference: string,
    actor: string,
    note?: string | null,
  ): Promise<SalesResult<LeadRecord>> {
    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    if (lead.status === 'CONVERTED') {
      return salesFail('CONFLICT', 'این درخواست قبلاً به مشتری تبدیل شده است.');
    }

    if (!canTransition(lead.status, 'CONVERTED')) {
      return salesFail(
        'INVALID_STATUS_TRANSITION',
        `تبدیل به مشتری از وضعیت ${lead.status} مجاز نیست؛ ابتدا درخواست باید واجد شرایط شود.`,
      );
    }

    const normalizedNote = normalizeOperatorNote(note ?? '');

    if (!normalizedNote.ok) {
      return normalizedNote;
    }

    const updated = await this.mutate(reference, (current, tx, at) => {
      const next: LeadRecord = {
        ...current,
        status: 'CONVERTED',
        customerConvertedAt: at,
        updatedAt: at,
      };

      tx.saveLead(next);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: current.leadId,
        action: 'CUSTOMER_CONVERTED',
        actor,
        at,
        fromStatus: current.status,
        toStatus: 'CONVERTED',
        summary: normalizedNote.value
          ? `تبدیل به مشتری: ${normalizedNote.value}`
          : 'تبدیل به مشتری ثبت شد.',
      });

      return next;
    });

    if (!updated.ok) {
      return updated;
    }

    const link = await this.linkCustomerToPhase8(updated.value, actor);
    const stored = await this.store.transact((tx) => {
      const current = tx.findLead(updated.value.leadId);

      if (!current) {
        return null;
      }

      const withLink: LeadRecord = {
        ...current,
        customerConversionId:
          link.status === 'RECORDED'
            ? link.conversionId
            : current.customerConversionId,
        phase8Customer: link,
        updatedAt: new Date().toISOString(),
      };

      tx.saveLead(withLink);

      return withLink;
    });

    return salesOk(stored ?? updated.value);
  }

  /**
   * Record a real sale outcome (§11.2).
   *
   * The amount is optional *on purpose*: an operator who cannot verify the number must be able to
   * record the outcome without inventing one. When an amount is given, the currency is mandatory, and
   * currencies are never converted or summed together by this service.
   */
  async recordSale(
    reference: string,
    actor: string,
    input: SalesOutcomeInput,
  ): Promise<SalesResult<SalesOutcomeRecord>> {
    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    if (lead.status !== 'CONVERTED') {
      return salesFail(
        'INVALID_STATUS_TRANSITION',
        'ثبت فروش فقط برای درخواست‌هایی ممکن است که به مشتری تبدیل شده‌اند.',
      );
    }

    const amount = input.amount ?? null;
    const currency =
      input.currency === null || input.currency === undefined
        ? null
        : input.currency.trim().toUpperCase();

    if (amount !== null) {
      if (!Number.isFinite(amount) || amount <= 0) {
        return salesFail(
          'INVALID_AMOUNT',
          'مبلغ فروش باید عددی بزرگ‌تر از صفر باشد.',
        );
      }

      // The unit is explicit and never guessed (§14.2): either the product vocabulary (`TOMAN` /
      // `RIAL` — the units the rest of the project uses) or a three-letter ISO code.
      if (currency === null || !/^(TOMAN|RIAL|[A-Z]{3})$/u.test(currency)) {
        return salesFail(
          'INVALID_AMOUNT',
          'برای ثبت مبلغ، واحد پول لازم است (TOMAN یا RIAL یا کد سه‌حرفی مثل IRT).',
        );
      }
    }

    const note = normalizeOperatorNote(input.note ?? '');

    if (!note.ok) {
      return note;
    }

    const existing = this.activeOutcome(lead.leadId);
    const at = new Date().toISOString();

    try {
      const outcome = await this.store.transact((tx) => {
        const outcomeId = tx.nextId('sale');

        if (existing) {
          tx.saveOutcome({
            ...existing,
            status: 'CORRECTED',
            supersededBy: outcomeId,
          });
        }

        const record: SalesOutcomeRecord = {
          outcomeId,
          leadId: lead.leadId,
          leadReference: lead.reference,
          outcomeType: 'SALE',
          amount,
          currency: amount === null ? null : currency,
          recordedAt: at,
          recordedBy: actor,
          note: note.value,
          status: 'ACTIVE',
          supersededBy: null,
        };

        tx.saveOutcome(record);

        const updatedLead: LeadRecord = {
          ...lead,
          saleOutcomeId: record.outcomeId,
          updatedAt: at,
        };

        tx.saveLead(updatedLead);
        tx.appendActivity({
          activityId: tx.nextId('act'),
          leadId: lead.leadId,
          action: existing ? 'SALE_CORRECTED' : 'SALE_RECORDED',
          actor,
          at,
          fromStatus: lead.status,
          toStatus: lead.status,
          summary:
            amount === null
              ? 'فروش ثبت شد (بدون مبلغ تأییدشده).'
              : `فروش ثبت شد: ${amount} ${currency}`,
        });

        return record;
      });

      this.logger.log(
        `Sale outcome ${outcome.outcomeId} recorded for lead ${lead.reference} by ${actor}.`,
      );

      return salesOk(outcome);
    } catch (error) {
      this.logger.error(
        `Could not persist a sale outcome for ${lead.reference}: ${describeError(error)}`,
      );

      return salesFail(
        'PERSISTENCE_FAILED',
        'ثبت فروش انجام نشد (خطای ذخیره‌سازی).',
      );
    }
  }

  /**
   * Retry every Phase 8 link that is not recorded yet, in one bounded pass (§9.3, §12.2).
   *
   * Bounded on purpose: a single pass repairs at most `REPAIR_BATCH` leads, so an operator command can
   * never turn into an unbounded loop over the whole document. Nothing is deleted or rewritten — only
   * links that are *missing* are attempted again.
   */
  async repairPendingIntegrations(): Promise<{
    checked: number;
    recorded: number;
    failed: number;
  }> {
    const candidates = this.store
      .listLeads()
      .filter(
        (lead) =>
          lead.phase8.status === 'FAILED' ||
          (lead.campaignId !== null && lead.phase8.status === 'UNATTRIBUTED') ||
          (lead.status === 'CONVERTED' &&
            (lead.phase8Customer === null ||
              lead.phase8Customer.status === 'FAILED')),
      )
      .slice(0, REPAIR_BATCH);

    let recorded = 0;
    let failed = 0;

    for (const lead of candidates) {
      const phase8 = await this.linkLeadToPhase8(lead);
      const customer =
        lead.status === 'CONVERTED'
          ? await this.linkCustomerToPhase8({ ...lead, phase8 }, 'system:sales')
          : null;

      if (lead.campaignId !== null && phase8.status === 'RECORDED') {
        recorded += 1;
      }

      if (lead.campaignId !== null && phase8.status === 'FAILED') {
        failed += 1;
      }

      if (
        lead.status === 'CONVERTED' &&
        customer &&
        customer.status === 'RECORDED'
      ) {
        recorded += 1;
      }

      if (
        lead.status === 'CONVERTED' &&
        customer &&
        customer.status === 'FAILED'
      ) {
        failed += 1;
      }
    }

    if (candidates.length > 0) {
      this.logger.log(
        `Repair pass: checked ${candidates.length} lead(s), recorded ${recorded} link(s), ` +
          `${failed} still failing.`,
      );
    }

    return { checked: candidates.length, recorded, failed };
  }

  /**
   * Retry the Phase 8 links and any failed notification of one lead (§9.2 recovery path).
   *
   * Returns what was attempted; the caller (admin surface) reports the truthful outcome.
   */
  async repairIntegrations(
    reference: string,
    actor: string,
  ): Promise<
    SalesResult<{ phase8: LeadPhase8Link; customer: LeadPhase8Link | null }>
  > {
    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    const phase8 = await this.linkLeadToPhase8(lead);
    const customer =
      lead.status === 'CONVERTED'
        ? await this.linkCustomerToPhase8({ ...lead, phase8 }, actor)
        : null;

    const stored = await this.store.transact((tx) => {
      const current = tx.findLead(lead.leadId);

      if (!current) {
        return null;
      }

      const next: LeadRecord = {
        ...current,
        phase8,
        phase8Customer: customer ?? current.phase8Customer,
        customerConversionId:
          customer && customer.status === 'RECORDED'
            ? customer.conversionId
            : current.customerConversionId,
        updatedAt: new Date().toISOString(),
      };

      tx.saveLead(next);

      return next;
    });

    return salesOk({ phase8: stored?.phase8 ?? phase8, customer });
  }

  // --- internals --------------------------------------------------------------------------------

  private applyStatusChange(
    lead: LeadRecord,
    next: LeadStatus,
    actor: string,
    note: string | null,
  ): Promise<SalesResult<LeadRecord>> {
    return this.mutate(lead.reference, (current, tx, at) => {
      const reopen =
        current.status === 'LOST' || current.status === 'CONVERTED';
      const updated: LeadRecord = {
        ...current,
        status: next,
        lossReason: next === 'LOST' ? current.lossReason : null,
        lossNote: next === 'LOST' ? current.lossNote : null,
        updatedAt: at,
      };

      tx.saveLead(updated);
      tx.appendActivity({
        activityId: tx.nextId('act'),
        leadId: current.leadId,
        action: reopen ? 'REOPENED' : 'STATUS_CHANGED',
        actor,
        at,
        fromStatus: current.status,
        toStatus: next,
        summary: note
          ? `وضعیت: ${current.status} → ${next} (${note})`
          : `وضعیت: ${current.status} → ${next}`,
      });

      return updated;
    });
  }

  /**
   * Append the activity row that belongs to a notification outcome (§9.2).
   *
   * Deliberately the *only* thing the notification layer may write about a lead: a delivered (or
   * undelivered) message is not a status change, not a contact attempt and certainly not a sale.
   */
  async recordNotificationActivity(
    notification: { leadId: string; kind: 'ADMIN' | 'CUSTOMER' },
    action: 'ADMIN_NOTIFIED' | 'CUSTOMER_NOTIFIED' | 'NOTIFICATION_FAILED',
    summary: string,
  ): Promise<void> {
    try {
      await this.store.transact((tx) => {
        const lead = tx.findLead(notification.leadId);

        if (!lead) {
          return null;
        }

        tx.appendActivity({
          activityId: tx.nextId('act'),
          leadId: lead.leadId,
          action,
          actor: 'system:sales',
          at: new Date().toISOString(),
          fromStatus: null,
          toStatus: null,
          summary,
        });

        return null;
      });
    } catch (error) {
      // A history row that cannot be written is logged and nothing more: it must never turn a
      // delivered message into an error for the customer, nor a stored lead into a lost one.
      this.logger.error(
        `Could not append the notification activity for lead ${notification.leadId}: ` +
          describeError(error),
      );
    }
  }

  /** Shared slice for "load, check, mutate, persist, log" operations on one lead. */
  private async mutate(
    reference: string,
    operation: (
      lead: LeadRecord,
      tx: SalesTransaction,
      at: string,
    ) => LeadRecord,
  ): Promise<SalesResult<LeadRecord>> {
    if (!this.enabled) {
      return salesFail(
        'DISABLED',
        this.disabledReason ?? 'موتور فروش غیرفعال است.',
      );
    }

    const lead = this.findLead(reference);

    if (!lead) {
      return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
    }

    try {
      const updated = await this.store.transact((tx) => {
        const current = tx.findLead(lead.leadId);

        if (!current) {
          return null;
        }

        return operation(current, tx, new Date().toISOString());
      });

      if (!updated) {
        return salesFail('NOT_FOUND', 'درخواستی با این کد پیگیری پیدا نشد.');
      }

      return salesOk(updated);
    } catch (error) {
      this.logger.error(
        `Could not update lead ${lead.reference}: ${describeError(error)}`,
      );

      return salesFail(
        'PERSISTENCE_FAILED',
        'به‌روزرسانی درخواست انجام نشد (خطای ذخیره‌سازی).',
      );
    }
  }

  private matchesNeedle(lead: LeadRecord, needle: string): boolean {
    const normalizedNeedle = needle.toUpperCase();

    if (lead.reference.toUpperCase().startsWith(normalizedNeedle)) {
      return true;
    }

    if (lead.customerName.includes(needle)) {
      return true;
    }

    // Phone search works on digits only, and it understands the digits an Iranian operator or
    // customer actually types: `۰۹۱۲` (Persian), `٠٩١٢` (Arabic) and `0912` all mean the same thing.
    const digits = toAsciiDigits(needle).replace(/\D/gu, '');

    if (digits.length >= 4) {
      const local = lead.phone.replace(/\D/gu, '');

      return local.includes(digits);
    }

    return false;
  }

  private findBySubmission(
    tx: SalesTransaction,
    submissionKey: string,
  ): LeadRecord | null {
    if (!tx.hasSubmissionKey(submissionKey)) {
      return null;
    }

    return (
      tx.listLeads().find((lead) => lead.submissionKey === submissionKey) ??
      null
    );
  }

  private allocateReference(tx: SalesTransaction): string {
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
      const candidate = generateLeadReference();

      if (!tx.findLeadByReference(candidate)) {
        return candidate;
      }
    }

    // Practically unreachable (31^8 ≈ 8.5e11 combinations); a fresh uuid-derived reference keeps the
    // function total instead of throwing inside a transaction.
    return `SL-${randomUUID().replace(/-/gu, '').slice(0, 8).toUpperCase()}`;
  }

  /**
   * Resolve the campaign attribution of one identity with the **Phase 8** rules (§12.1).
   *
   * No inference is made from the platform or from the fact that the user started the bot: the answer
   * comes from the persisted Phase 8 touch records, the configured window and the documented buckets.
   */
  private resolveAttribution(
    identityKey: string,
    at: Date,
  ): {
    campaignId: string | null;
    campaignName: string | null;
    campaignSource: string | null;
    model: LeadRecord['attributionModel'];
    bucket: LeadAttributionBucket;
    reason: string;
  } {
    if (!this.tracking.enabled) {
      return {
        campaignId: null,
        campaignName: null,
        campaignSource: null,
        model: null,
        bucket: 'TRACKING_DISABLED',
        reason:
          this.campaigns.trackingDisabledReason ??
          'ردیابی کمپین خاموش است؛ انتساب کمپین ثبت نشد.',
      };
    }

    const decision = this.tracking.creditedFor(identityKey, at);
    const campaign = decision.campaignId
      ? this.campaigns.findCampaign(decision.campaignId)
      : null;

    return {
      campaignId: campaign?.campaignId ?? null,
      campaignName: campaign?.name ?? null,
      campaignSource: campaign?.source ?? null,
      model: campaign ? decision.model : null,
      bucket: campaign ? 'CAMPAIGN' : decision.bucket,
      reason: decision.reason,
    };
  }

  /**
   * Write the canonical Phase 8 `LEAD` row for a freshly created lead (§12.2).
   *
   * The conversion id is stored on the lead, and every non-success state is recorded with its reason
   * so the operator can retry it consciously (`/leads retry`).
   */
  private async linkLeadToPhase8(lead: LeadRecord): Promise<LeadPhase8Link> {
    const at = new Date().toISOString();

    if (!this.tracking.enabled) {
      return {
        status: 'TRACKING_DISABLED',
        conversionId: null,
        attributionModel: null,
        bucket: 'TRACKING_DISABLED',
        reason: 'ردیابی کمپین خاموش است؛ رویداد سرنخ در فاز ۸ ثبت نشد.',
        updatedAt: at,
      };
    }

    const result = await this.conversions.registerConversion({
      type: 'LEAD',
      userReference: lead.identityKey,
      occurredAt: lead.createdAt,
      operator: `sales:${lead.reference}`,
      note: `sales lead ${lead.reference} (${lead.category})`,
    });

    if (result.ok) {
      return {
        status: 'RECORDED',
        conversionId: result.value.conversionId,
        attributionModel: result.value.attributionModel,
        bucket: result.value.attributionBucket,
        reason: result.value.campaignId
          ? `سرنخ به کمپین ${result.value.campaignId} منتسب شد.`
          : 'سرنخ ثبت شد؛ کمپین منتسبی وجود نداشت (ارگانیک/مستقیم).',
        updatedAt: at,
      };
    }

    if (result.code === 'CONFLICT') {
      return {
        status: 'ALREADY_RECORDED',
        conversionId: null,
        attributionModel: lead.attributionModel,
        bucket: lead.attributionBucket,
        reason:
          'این کاربر از قبل به‌عنوان سرنخ در فاز ۸ ثبت شده بود؛ رکورد تازه‌ای ساخته نشد.',
        updatedAt: at,
      };
    }

    if (result.code === 'DISABLED') {
      return {
        status: 'TRACKING_DISABLED',
        conversionId: null,
        attributionModel: null,
        bucket: 'TRACKING_DISABLED',
        reason: 'ردیابی کمپین خاموش است؛ رویداد سرنخ در فاز ۸ ثبت نشد.',
        updatedAt: at,
      };
    }

    this.logger.error(
      `Phase 8 LEAD link failed for lead ${lead.reference}: ${result.code}.`,
    );

    return {
      status: 'FAILED',
      conversionId: null,
      attributionModel: lead.attributionModel,
      bucket: lead.attributionBucket,
      reason: `ثبت سرنخ در فاز ۸ ناموفق بود (${result.code}). با «تلاش دوباره» قابل رفع است.`,
      updatedAt: at,
    };
  }

  /** Write the canonical Phase 8 `CUSTOMER` row when a lead is converted (§12.3). */
  private async linkCustomerToPhase8(
    lead: LeadRecord,
    actor: string,
  ): Promise<LeadPhase8Link> {
    const at = new Date().toISOString();

    if (!this.tracking.enabled) {
      return {
        status: 'TRACKING_DISABLED',
        conversionId: null,
        attributionModel: null,
        bucket: 'TRACKING_DISABLED',
        reason: 'ردیابی کمپین خاموش است؛ تبدیل مشتری در فاز ۸ ثبت نشد.',
        updatedAt: at,
      };
    }

    const result = await this.conversions.registerConversion({
      type: 'CUSTOMER',
      userReference: lead.identityKey,
      occurredAt: lead.customerConvertedAt ?? at,
      operator: actor,
      note: `sales lead ${lead.reference} (${lead.category})`,
    });

    if (result.ok) {
      return {
        status: 'RECORDED',
        conversionId: result.value.conversionId,
        attributionModel: result.value.attributionModel,
        bucket: result.value.attributionBucket,
        reason: 'تبدیل مشتری در فاز ۸ ثبت شد.',
        updatedAt: at,
      };
    }

    if (result.code === 'CONFLICT') {
      return {
        status: 'ALREADY_RECORDED',
        conversionId: null,
        attributionModel: lead.attributionModel,
        bucket: lead.attributionBucket,
        reason:
          'این کاربر از قبل به‌عنوان مشتری در فاز ۸ ثبت شده بود؛ رکورد تازه‌ای ساخته نشد.',
        updatedAt: at,
      };
    }

    if (result.code === 'DISABLED') {
      return {
        status: 'TRACKING_DISABLED',
        conversionId: null,
        attributionModel: null,
        bucket: 'TRACKING_DISABLED',
        reason: 'ردیابی کمپین خاموش است؛ تبدیل مشتری در فاز ۸ ثبت نشد.',
        updatedAt: at,
      };
    }

    this.logger.error(
      `Phase 8 CUSTOMER link failed for lead ${lead.reference}: ${result.code}.`,
    );

    return {
      status: 'FAILED',
      conversionId: null,
      attributionModel: lead.attributionModel,
      bucket: lead.attributionBucket,
      reason: `ثبت تبدیل مشتری در فاز ۸ ناموفق بود (${result.code}). با «تلاش دوباره» قابل رفع است.`,
      updatedAt: at,
    };
  }
}

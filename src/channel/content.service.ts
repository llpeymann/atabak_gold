import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { tehranDayKey } from '../common/tehran-time';
import { AppConfigService } from '../config/app-config.service';
import {
  ContentItem,
  ContentMutationResult,
  ContentStatus,
  createChannelId,
  CtaRouteChoice,
  isCtaRouteChoice,
  MessageType,
} from './channel.types';
import {
  assertMessageType,
  isEditorialType,
  specFor,
} from './message-registry';
import { PublicationStore } from './publication.store';

/**
 * Phase 5 — editorial content management (§5.5–§5.7, §7, §19, §22).
 *
 * The smallest mechanism that satisfies the workflow: the three editorial types are stored as
 * *content items* with an explicit lifecycle, and every transition is validated here — a draft can
 * never be scheduled, an approval can never survive a material edit, a cancelled item can never be
 * published by a later job.
 *
 * This service is the only place that may create/change content items. It is *not* an API: it is
 * called by the admin surface of the existing bot (no new unauthenticated endpoint exists, §22).
 */

export interface ContentDraftInput {
  messageType: MessageType;
  title: string;
  body: string;
  /** Platform id of the admin that submitted it (recorded for the audit trail). */
  authorId: string;
  mediaUrl?: string | null;
  includeMarketData?: boolean;
  /** Tehran reporting date (`YYYY-MM-DD`); defaults to today. */
  reportingDate?: string | null;
}

/** Outcome of normalising a reporting date: a validated `YYYY-MM-DD`, `null` (undated) or invalid. */
type ReportingDateParse = { ok: true; value: string | null } | { ok: false };

const MAX_TITLE_CHARS = 120;
const HTML_TAG_PATTERN = /<[^>]*>/;
const URL_PATTERN = /^https?:\/\/\S+$/i;

@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: PublicationStore,
  ) {}

  /** Editorial item by id (read-only copy). */
  find(id: string): ContentItem | null {
    return this.store.findContent(id);
  }

  list(): ContentItem[] {
    return this.store.listContents();
  }

  /** Items still awaiting a decision, newest first — the admin overview. */
  listOpen(): ContentItem[] {
    return this.store
      .listContents()
      .filter((content) => content.status !== 'PUBLISHED')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Create a draft. Only the three editorial types are accepted here: market types are produced
   * from validated data by the engine and can never be authored by hand (§5, §19).
   */
  async create(
    input: ContentDraftInput,
    now = new Date(),
  ): Promise<ContentMutationResult> {
    if (!isEditorialType(input.messageType)) {
      // `assertMessageType` keeps the runtime guard honest for values that bypass TypeScript.
      assertMessageType(input.messageType);

      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: `${input.messageType} is not an authorable editorial type`,
      };
    }

    const body = input.body.trim();
    const title = input.title.trim();
    const spec = specFor(input.messageType);
    const maxChars = Math.min(
      this.config.channelMaxContentChars,
      spec.maxBodyChars,
    );

    if (body === '') {
      return { ok: false, reason: 'INVALID_INPUT', detail: 'body is empty' };
    }

    if (body.length > maxChars) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: `body is longer than ${maxChars} characters`,
      };
    }

    if (title.length > MAX_TITLE_CHARS) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: `title is longer than ${MAX_TITLE_CHARS} characters`,
      };
    }

    if (title.includes('\n')) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'title must be one line',
      };
    }

    // Content is rendered with HTML parse mode: raw markup in editorial text would either break the
    // message or allow it to be styled as the brand. Both are rejected explicitly.
    if (HTML_TAG_PATTERN.test(title) || HTML_TAG_PATTERN.test(body)) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'HTML markup is not allowed in editorial text',
      };
    }

    const mediaUrl = input.mediaUrl?.trim() ?? '';
    if (mediaUrl !== '' && !URL_PATTERN.test(mediaUrl)) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'media url must be an absolute http(s) url',
      };
    }

    const reportingDate = this.normalizeReportingDate(
      input.reportingDate ?? null,
      input.messageType,
    );

    if (!reportingDate.ok) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'reporting date must be YYYY-MM-DD',
      };
    }

    const id = createChannelId('cnt');

    const created = await this.store.transact((tx) => {
      const content: ContentItem = {
        id,
        messageType: input.messageType,
        title,
        body,
        mediaUrl: mediaUrl === '' ? null : mediaUrl,
        // A nightly analysis is defined as editorial text *plus* the validated market block, so the
        // default follows the type; an explicit flag still wins.
        includeMarketData:
          input.includeMarketData ?? input.messageType === 'NIGHTLY_ANALYSIS',
        revision: 1,
        status: 'DRAFT',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        approvedAt: null,
        approvedBy: null,
        scheduledAt: null,
        reportingDate: reportingDate.value,
        lastJobId: null,
        cancelledAt: null,
        lastError: `created by ${input.authorId}`,
      };

      tx.saveContent(content);

      return content;
    });

    this.logger.log(
      `Content ${created.id} (${created.messageType}) created as a DRAFT by ${input.authorId}.`,
    );

    return { ok: true, content: created };
  }

  /**
   * Material edit. Any change to title/body/media/type/market-data flag increments the revision and
   * invalidates a previous approval: an approval always belongs to an exact revision (§19).
   */
  async edit(
    id: string,
    patch: Partial<
      Pick<
        ContentDraftInput,
        'title' | 'body' | 'mediaUrl' | 'includeMarketData'
      >
    >,
    now = new Date(),
  ): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status === 'PUBLISHED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: 'a published item cannot be edited',
      };
    }

    const nextTitle =
      patch.title === undefined ? existing.title : patch.title.trim();
    const nextBody =
      patch.body === undefined ? existing.body : patch.body.trim();
    const nextMedia =
      patch.mediaUrl === undefined
        ? existing.mediaUrl
        : (patch.mediaUrl?.trim() ?? null);
    const nextInclude =
      patch.includeMarketData === undefined
        ? existing.includeMarketData
        : patch.includeMarketData;

    if (nextBody === '') {
      return { ok: false, reason: 'INVALID_INPUT', detail: 'body is empty' };
    }

    if (HTML_TAG_PATTERN.test(nextTitle) || HTML_TAG_PATTERN.test(nextBody)) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'HTML markup is not allowed in editorial text',
      };
    }

    if (
      nextMedia !== null &&
      nextMedia !== '' &&
      !URL_PATTERN.test(nextMedia)
    ) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'media url must be an absolute http(s) url',
      };
    }

    const material =
      nextTitle !== existing.title ||
      nextBody !== existing.body ||
      (nextMedia === '' ? null : nextMedia) !== existing.mediaUrl ||
      nextInclude !== existing.includeMarketData;

    const updated = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      const next: ContentItem = {
        ...current,
        title: nextTitle,
        body: nextBody,
        mediaUrl: nextMedia === '' ? null : nextMedia,
        includeMarketData: nextInclude,
        // A material edit is a new revision; anything else keeps the approval valid.
        revision: material ? current.revision + 1 : current.revision,
        status:
          material && current.status !== 'DRAFT' ? 'DRAFT' : current.status,
        approvedAt: material ? null : current.approvedAt,
        approvedBy: material ? null : current.approvedBy,
        scheduledAt: material ? null : current.scheduledAt,
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    if (!updated) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (material) {
      this.logger.warn(
        `Content ${id} was materially edited → revision ${updated.revision}; ` +
          'previous approval and schedule were cleared (re-approval required).',
      );
    }

    return { ok: true, content: updated };
  }

  /** Approve the *current* revision (§7). */
  /**
   * Phase 6 — choose the call-to-action button of an editorial item (§4.2).
   *
   * `auto` returns to the type policy, `none` removes the button, and a concrete route is an explicit
   * editorial decision — the *only* way a price-alert promotion post can exist, because the seven
   * message types contain no promotion type and inventing one would break the Phase 5 registry.
   *
   * The button is part of the rendered payload, so changing it is a material change: the revision is
   * incremented and a previous approval/schedule is cleared, exactly like a body edit.
   */
  async setCta(
    id: string,
    choice: CtaRouteChoice,
    now = new Date(),
  ): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status === 'PUBLISHED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: 'a published item cannot be edited',
      };
    }

    if (!isCtaRouteChoice(choice)) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: `unsupported cta choice "${String(choice)}"`,
      };
    }

    const currentChoice = existing.ctaRoute ?? 'auto';

    if (currentChoice === choice) {
      return { ok: true, content: existing };
    }

    const updated = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      const next: ContentItem = {
        ...current,
        ctaRoute: choice,
        revision: current.revision + 1,
        status: current.status !== 'DRAFT' ? 'DRAFT' : current.status,
        approvedAt: null,
        approvedBy: null,
        scheduledAt: null,
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    if (!updated) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    this.logger.log(
      `Content ${id} CTA set to "${choice}" → revision ${updated.revision} (re-approval required when it was approved).`,
    );

    return { ok: true, content: updated };
  }

  async approve(
    id: string,
    adminId: string,
    now = new Date(),
  ): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status === 'PUBLISHED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: 'already published',
      };
    }

    if (existing.status === 'CANCELLED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: 'cancelled content cannot be approved',
      };
    }

    const approved = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      const next: ContentItem = {
        ...current,
        status: 'APPROVED',
        approvedAt: now.toISOString(),
        approvedBy: adminId,
        lastError: null,
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    if (!approved) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    this.logger.log(
      `Content ${id} (${approved.messageType}, r${approved.revision}) approved by ${adminId}.`,
    );

    return { ok: true, content: approved };
  }

  /**
   * Schedule an approved item at a Tehran wall-clock instant.
   *
   * `scheduledAt` is stored as an absolute ISO timestamp, so the schedule survives restarts and is
   * independent of the server time zone (§11).
   */
  async schedule(
    id: string,
    scheduledAtIso: string,
    now = new Date(),
  ): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status === 'DRAFT') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: 'approve the content before scheduling it',
      };
    }

    if (existing.status === 'CANCELLED' || existing.status === 'PUBLISHED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: `status is ${existing.status}`,
      };
    }

    const when = Date.parse(scheduledAtIso);

    if (!Number.isFinite(when)) {
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        detail: 'invalid schedule time',
      };
    }

    const scheduled = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      const next: ContentItem = {
        ...current,
        status: 'SCHEDULED',
        scheduledAt: new Date(when).toISOString(),
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    if (!scheduled) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    this.logger.log(
      `Content ${id} scheduled for ${scheduled.scheduledAt} (absolute UTC).`,
    );

    return { ok: true, content: scheduled };
  }

  /**
   * Cancel an item. A scheduled job of a cancelled item refuses to publish: the job re-reads the
   * cancellation at execution time (§7, §19).
   */
  async cancel(id: string, now = new Date()): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status === 'PUBLISHED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail:
          'a published item cannot be cancelled (the message is already public)',
      };
    }

    const cancelled = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      const next: ContentItem = {
        ...current,
        status: 'CANCELLED',
        cancelledAt: now.toISOString(),
        scheduledAt: null,
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    if (!cancelled) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    this.logger.log(`Content ${id} cancelled.`);

    return { ok: true, content: cancelled };
  }

  /** Restore a cancelled item as a draft (its body is unchanged, so the revision stays). */
  async reopen(id: string, now = new Date()): Promise<ContentMutationResult> {
    const existing = this.store.findContent(id);

    if (!existing) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (existing.status !== 'CANCELLED') {
      return {
        ok: false,
        reason: 'INVALID_STATE',
        detail: `status is ${existing.status}`,
      };
    }

    const reopened = await this.store.transact((tx) => {
      const current = tx.findContent(id);

      if (!current) {
        return null;
      }

      // A reopened item is a *new* revision: the previous approval was given to a published-shape
      // item that no longer exists as such (§19).
      const next: ContentItem = {
        ...current,
        status: 'DRAFT',
        revision: current.revision + 1,
        approvedAt: null,
        approvedBy: null,
        cancelledAt: null,
        updatedAt: now.toISOString(),
      };

      tx.saveContent(next);

      return next;
    });

    return reopened
      ? { ok: true, content: reopened }
      : { ok: false, reason: 'NOT_FOUND' };
  }

  /** Mark an item as failed after a delivery error (§27.6) — the reason is kept, never hidden. */
  async markFailed(
    id: string,
    reason: string,
    now = new Date(),
  ): Promise<void> {
    try {
      await this.store.transact((tx) => {
        const current = tx.findContent(id);

        if (!current) {
          return;
        }

        tx.saveContent({
          ...current,
          status: current.status === 'PUBLISHED' ? 'PUBLISHED' : 'FAILED',
          lastError: reason,
          updatedAt: now.toISOString(),
        });
      });
    } catch (error) {
      this.logger.error(
        `Could not mark content ${id} as failed: ${describeError(error)}`,
      );
    }
  }

  /** Human-readable status label used by the admin surface (Persian). */
  static statusLabel(status: ContentStatus): string {
    switch (status) {
      case 'DRAFT':
        return 'پیش‌نویس';
      case 'APPROVED':
        return 'تأیید‌شده';
      case 'SCHEDULED':
        return 'زمان‌بندی‌شده';
      case 'PUBLISHED':
        return 'منتشر‌شده';
      case 'FAILED':
        return 'ناموفق';
      default:
        return 'لغو‌شده';
    }
  }

  private normalizeReportingDate(
    value: string | null,
    type: MessageType,
  ): ReportingDateParse {
    if (value === null || value.trim() === '') {
      // Only the nightly analysis is date-bound by definition; everything else may be undated.
      return {
        ok: true,
        value: type === 'NIGHTLY_ANALYSIS' ? tehranDayKey(new Date()) : null,
      };
    }

    const trimmed = value.trim();

    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? { ok: true, value: trimmed }
      : { ok: false };
  }
}

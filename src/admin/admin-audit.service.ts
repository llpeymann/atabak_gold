/**
 * Phase 10 — the durable audit trail (§13).
 *
 * Design decisions that matter, because an audit trail that lies is worse than none:
 *
 *  * **Order.** A business operation is performed first and audited after it reported success, so a
 *    successful action can never be audited when it actually failed. A *refused* or *failed* attempt
 *    is audited too, with `result`, so denials are visible instead of silent.
 *  * **Gap visibility.** The two writes live in different documents (the business store and the admin
 *    store), and a JSON document store cannot span a transaction across files — the spec explicitly
 *    forbids pretending otherwise (§13.2). When the audit write itself fails, the failure is logged,
 *    returned to the caller and recorded as an operational incident, so the gap is visible rather
 *    than invisible.
 *  * **Content.** Only the acting administrator, the action, the target reference, the state
 *    transition and a short sanitized reason are stored. Never tokens, never customer free text,
 *    never a phone number (§13.1, §12.4).
 *  * **Integrity.** Rows are append-only; nothing in the admin surface can edit or delete one. The
 *    only removal path is the explicitly configured cap (`ADMIN_MAX_AUDIT_RECORDS`), which drops the
 *    *oldest* rows and records that pruning happened as an audited event (§13.2).
 */

import { Injectable, Logger } from '@nestjs/common';

import { describeError } from '../common/log-safety';
import { AppConfigService } from '../config/app-config.service';
import { AdminStore } from './admin.store';
import {
  AdminActionKind,
  AdminRole,
  AuditRecord,
  AuditResult,
} from './admin.types';

export interface AuditEntry {
  actor: string;
  role: AdminRole | 'SYSTEM';
  action: AdminActionKind;
  targetType: string;
  targetRef?: string | null;
  result: AuditResult;
  fromState?: string | null;
  toState?: string | null;
  reason?: string | null;
  correlationId?: string | null;
  at?: string;
}

/** Payloads are summaries, never dumps: the audit row is bounded by construction. */
const MAX_REASON_LENGTH = 200;

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly store: AdminStore,
  ) {}

  /**
   * Append one audited action. Returns the stored row, or `null` when the write failed — the caller
   * must treat `null` as “the action happened but it is not audited yet” and say so (§13.2).
   */
  async record(entry: AuditEntry): Promise<AuditRecord | null> {
    const at = entry.at ?? new Date().toISOString();

    try {
      const stored = await this.store.transact((tx) => {
        const record: AuditRecord = {
          auditId: tx.nextId('aud'),
          actor: entry.actor,
          role: entry.role,
          action: entry.action,
          targetType: entry.targetType,
          targetRef: entry.targetRef ?? null,
          at,
          result: entry.result,
          fromState: entry.fromState ?? null,
          toState: entry.toState ?? null,
          reason: sanitizeReason(entry.reason ?? null),
          correlationId: entry.correlationId ?? null,
        };

        tx.appendAudit(record);

        return record;
      });

      await this.applyAuditCap();

      return stored;
    } catch (error) {
      this.logger.error(
        `Could not write the audit row for ${entry.action}: ${describeError(error)}`,
      );

      return null;
    }
  }

  /** Newest first — what the management screen shows. */
  list(limit?: number): AuditRecord[] {
    const all = this.store.listAudit();

    return all.reverse().slice(0, limit ?? all.length);
  }

  forTarget(targetRef: string, limit = 10): AuditRecord[] {
    return this.list()
      .filter((row) => row.targetRef === targetRef)
      .slice(0, limit);
  }

  get count(): number {
    return this.store.auditCount;
  }

  /**
   * Apply the configured cap (0 = keep everything). Returns how many rows were removed; the caller
   * (or the next audit row) records the pruning fact.
   */
  async applyAuditCap(): Promise<number> {
    const cap = this.config.adminMaxAuditRecords;

    if (cap <= 0 || this.store.auditCount <= cap) {
      return 0;
    }

    try {
      return await this.store.transact((tx) => tx.pruneAudit(cap));
    } catch (error) {
      this.logger.error(
        `Could not apply the audit cap: ${describeError(error)}`,
      );

      return 0;
    }
  }
}

/** Newlines, tabs and very long messages are what turn an audit trail into a log dump. */
function sanitizeReason(reason: string | null): string | null {
  if (reason === null) {
    return null;
  }

  const collapsed = reason.replace(/\s+/gu, ' ').trim();

  if (collapsed === '') {
    return null;
  }

  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 1)}…`
    : collapsed;
}

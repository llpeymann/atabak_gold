import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describeError } from '../common/log-safety';
import { PersistenceMonitor } from '../common/persistence-monitor.service';
import { AppConfigService } from '../config/app-config.service';
import {
  Alert,
  AlertDelivery,
  countsTowardsCapacity,
  PersistedAlertData,
} from './alert.types';

const ALERT_DATA_VERSION = 1;

/**
 * A single, synchronous critical section over the alert document.
 *
 * The callback must not be `async`: the whole operation (capacity check → insert, or trigger
 * reservation → delivery insert) is applied to the in-memory maps without yielding, so no two
 * callers can interleave (§37, §58) and the file is written once with the resulting state.
 */
export interface AlertTransaction {
  /** Defensive copy of every alert (all statuses). */
  listAlerts(): Alert[];
  listAlertsByUser(userId: string): Alert[];
  listActiveBySymbol(symbol: string): Alert[];
  findAlert(alertId: string): Alert | null;
  countForCapacity(userId: string): number;
  findDeliveryByAlert(alertId: string): AlertDelivery | null;
  listDeliveries(alertId?: string): AlertDelivery[];
  saveAlert(alert: Alert): void;
  saveDelivery(delivery: AlertDelivery): void;
}

/**
 * Persistence for alerts and their delivery records.
 *
 * Reuses the persistence technology proven in Phase 1/2 (single JSON document, atomic
 * tmp-file + rename, tolerant load, serialized writes): the project has no relational database,
 * so this is the smallest safe solution (§65/§93) and it keeps every alert invariant enforceable
 * inside one critical section instead of a distributed lock (§37).
 */
@Injectable()
export class AlertStore {
  private readonly logger = new Logger(AlertStore.name);
  private readonly filePath: string | null;
  private readonly alerts = new Map<string, Alert>();
  private readonly deliveries = new Map<string, AlertDelivery>();
  /** "Index" for §57: symbols that have at least one ACTIVE alert. */
  private readonly activeBySymbol = new Map<string, Set<string>>();
  private readonly alertsByUser = new Map<string, Set<string>>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    this.filePath = this.config.alertsDataFile;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  /** Load once, on first use (bootstrap does it explicitly too). */
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

      if (!this.isPersistedAlertData(parsed)) {
        this.logger.warn(
          `Alert data file ${this.filePath} has an unexpected shape — starting with no alerts.`,
        );
        return;
      }

      for (const alert of parsed.alerts) {
        if (this.isAlertShape(alert)) {
          this.alerts.set(alert.id, alert);
          this.index(alert);
        }
      }

      for (const delivery of parsed.deliveries) {
        if (this.isDeliveryShape(delivery)) {
          this.deliveries.set(delivery.alertId, delivery);
        }
      }

      const pending = [...this.deliveries.values()].filter(
        (delivery) => delivery.status === 'PENDING',
      ).length;

      this.logger.log(
        `Restored ${this.alerts.size} alert(s) and ${this.deliveries.size} delivery ` +
          `record(s) from ${this.filePath}${pending > 0 ? ` (${pending} pending)` : ''}.`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted alerts found at ${this.filePath} — starting empty.`,
        );
        return;
      }

      this.logger.error(
        `Could not read alert data file ${this.filePath}: ${describeError(error)} — starting empty.`,
      );
    }
  }

  // --- reads (no critical section needed) -------------------------------------

  /**
   * Every stored alert (newest first).
   *
   * Phase 10 added this read-only view because the admin surface has to look at all alerts at once
   * (its own filters and pagination). It is a plain store read — no filtering logic is duplicated
   * from Phase 3, and no write path is added.
   */
  listAlerts(): Alert[] {
    return [...this.alerts.values()]
      .map((alert) => ({ ...alert }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  findAlert(alertId: string): Alert | null {
    const alert = this.alerts.get(alertId);

    return alert ? { ...alert } : null;
  }

  listAlertsByUser(userId: string): Alert[] {
    const ids = this.alertsByUser.get(userId);

    if (!ids) {
      return [];
    }

    return [...ids]
      .map((id) => this.alerts.get(id))
      .filter((alert): alert is Alert => alert !== undefined)
      .map((alert) => ({ ...alert }));
  }

  /** Only ACTIVE alerts of one symbol — the query the evaluator performs (§57). */
  listActiveBySymbol(symbol: string): Alert[] {
    const ids = this.activeBySymbol.get(symbol);

    if (!ids) {
      return [];
    }

    return [...ids]
      .map((id) => this.alerts.get(id))
      .filter((alert): alert is Alert => alert !== undefined)
      .map((alert) => ({ ...alert }));
  }

  findDeliveryByAlert(alertId: string): AlertDelivery | null {
    const delivery = this.deliveries.get(alertId);

    return delivery ? { ...delivery } : null;
  }

  listDeliveries(): AlertDelivery[] {
    return [...this.deliveries.values()].map((delivery) => ({ ...delivery }));
  }

  /** Symbols that currently have at least one ACTIVE alert (diagnostics/tests). */
  get activeSymbols(): string[] {
    return [...this.activeBySymbol.keys()];
  }

  get alertCount(): number {
    return this.alerts.size;
  }

  // --- writes -----------------------------------------------------------------

  /**
   * Run a synchronous operation inside the critical section and persist the result.
   * `T` must not be a promise: the section never yields.
   */
  async transact<T>(operation: (tx: AlertTransaction) => T): Promise<T> {
    // The link is queued *synchronously*, and the document is loaded inside it: two concurrent
    // transactions are therefore applied in call order and the first one cannot be overtaken
    // while the file is still being read.
    // The write happens inside the same link: extending the chain again from a helper would
    // make the link wait for itself.
    const run = this.writeChain.then(async () => {
      await this.ensureLoaded();

      const tx = new AlertTransactionImpl(
        this.alerts,
        this.deliveries,
        (alert) => this.index(alert),
      );

      const result = operation(tx);

      if (tx.changed) {
        await this.writeFile(this.snapshot());
      }

      return result;
    });

    // The chain must survive a rejected operation (the caller still gets the error).
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private index(alert: Alert): void {
    const userAlerts = this.alertsByUser.get(alert.userId) ?? new Set<string>();
    userAlerts.add(alert.id);
    this.alertsByUser.set(alert.userId, userAlerts);

    const activeIds =
      this.activeBySymbol.get(alert.symbol) ?? new Set<string>();

    if (alert.status === 'ACTIVE') {
      activeIds.add(alert.id);
    } else {
      activeIds.delete(alert.id);
    }

    if (activeIds.size === 0) {
      this.activeBySymbol.delete(alert.symbol);
    } else {
      this.activeBySymbol.set(alert.symbol, activeIds);
    }
  }

  private async writeFile(payload: PersistedAlertData): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
      await rename(temporaryPath, this.filePath);
      this.persistence?.success('alert-data');
    } catch (error) {
      this.logger.error(
        `Could not persist alert data to ${this.filePath}: ${describeError(error)}`,
      );
      this.persistence?.failure('alert-data', 'write', error);
    }
  }

  private snapshot(): PersistedAlertData {
    return {
      version: ALERT_DATA_VERSION,
      savedAt: new Date().toISOString(),
      alerts: [...this.alerts.values()].map((alert) => ({ ...alert })),
      deliveries: [...this.deliveries.values()].map((delivery) => ({
        ...delivery,
      })),
    };
  }

  private isPersistedAlertData(value: unknown): value is PersistedAlertData {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<PersistedAlertData>;

    return (
      Array.isArray(candidate.alerts) && Array.isArray(candidate.deliveries)
    );
  }

  private isAlertShape(value: unknown): value is Alert {
    const candidate = value as Partial<Alert> | null;

    if (
      typeof candidate?.id !== 'string' ||
      typeof candidate.userId !== 'string' ||
      typeof candidate.symbol !== 'string'
    ) {
      return false;
    }

    const status = candidate.status;

    return status !== undefined && typeof status === 'string';
  }

  private isDeliveryShape(value: unknown): value is AlertDelivery {
    const candidate = value as Partial<AlertDelivery> | null;

    return (
      typeof candidate?.alertId === 'string' &&
      typeof candidate.userId === 'string' &&
      typeof candidate.status === 'string'
    );
  }
}

/** Implementation of the transaction contract over the store's maps. */
class AlertTransactionImpl implements AlertTransaction {
  private dirty = false;

  constructor(
    private readonly alerts: Map<string, Alert>,
    private readonly deliveries: Map<string, AlertDelivery>,
    private readonly onAlertSaved: (alert: Alert) => void,
  ) {}

  get changed(): boolean {
    return this.dirty;
  }

  listAlerts(): Alert[] {
    return [...this.alerts.values()].map((alert) => ({ ...alert }));
  }

  listAlertsByUser(userId: string): Alert[] {
    return this.listAlerts().filter((alert) => alert.userId === userId);
  }

  listActiveBySymbol(symbol: string): Alert[] {
    return this.listAlerts().filter(
      (alert) => alert.symbol === symbol && alert.status === 'ACTIVE',
    );
  }

  findAlert(alertId: string): Alert | null {
    const alert = this.alerts.get(alertId);

    return alert ? { ...alert } : null;
  }

  countForCapacity(userId: string): number {
    return this.listAlerts().filter(
      (alert) => alert.userId === userId && countsTowardsCapacity(alert.status),
    ).length;
  }

  findDeliveryByAlert(alertId: string): AlertDelivery | null {
    const delivery = this.deliveries.get(alertId);

    return delivery ? { ...delivery } : null;
  }

  listDeliveries(alertId?: string): AlertDelivery[] {
    const all = [...this.deliveries.values()].map((delivery) => ({
      ...delivery,
    }));

    return alertId === undefined
      ? all
      : all.filter((delivery) => delivery.alertId === alertId);
  }

  saveAlert(alert: Alert): void {
    this.alerts.set(alert.id, { ...alert });
    this.onAlertSaved({ ...alert });
    this.dirty = true;
  }

  saveDelivery(delivery: AlertDelivery): void {
    this.deliveries.set(delivery.alertId, { ...delivery });
    this.dirty = true;
  }
}

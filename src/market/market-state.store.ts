import { Injectable, Logger, Optional } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppConfigService } from '../config/app-config.service';
import { describeError } from '../common/log-safety';
import { PersistenceMonitor } from '../common/persistence-monitor.service';
import { PriceUnit, SymbolDailyStats } from './market.types';

export interface PersistedSymbolState {
  symbol: string;
  unit: PriceUnit;
  currentPrice: number;
  previousPrice: number | null;
  lastValidPrice: number;
  updatedAt: string;
  lastSuccessfulUpdate: string;
  dayKey: string;
  /** `null` when the current Tehran day has no accepted price yet. */
  daily: SymbolDailyStats | null;
}

export interface PersistedMarketState {
  version: number;
  savedAt: string;
  dayKey: string | null;
  symbols: PersistedSymbolState[];
}

const STATE_VERSION = 1;

/**
 * Minimal persistence for market reliability.
 *
 * Only the state that must survive a restart is stored: the last valid price, the previous price
 * and the daily open/high/low per symbol — enough to keep anomalies, staleness and daily
 * statistics correct across deploys. It is a single JSON file written atomically
 * (tmp file + rename), intentionally *not* a market history/database (out of scope).
 *
 * When `MARKET_STATE_FILE` is empty, persistence is disabled and the engine runs in memory only.
 * Failures to read or write are logged and never crash the application.
 */
@Injectable()
export class MarketStateStore {
  private readonly logger = new Logger(MarketStateStore.name);
  private readonly filePath: string | null;

  constructor(
    private readonly config: AppConfigService,
    @Optional() private readonly persistence?: PersistenceMonitor,
  ) {
    this.filePath = this.config.marketStateFile;
  }

  get enabled(): boolean {
    return this.filePath !== null;
  }

  get path(): string | null {
    return this.filePath;
  }

  async load(): Promise<PersistedMarketState | null> {
    if (!this.filePath) {
      return null;
    }

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      if (!this.isPersistedState(parsed)) {
        this.logger.warn(
          `Market state file ${this.filePath} has an unexpected shape — starting with empty state.`,
        );
        return null;
      }

      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ENOENT') {
        this.logger.log(
          `No persisted market state found at ${this.filePath} — starting fresh.`,
        );
        return null;
      }

      this.logger.error(
        `Could not read market state file ${this.filePath}: ${describeError(error)} — starting fresh.`,
      );
      return null;
    }
  }

  async save(state: PersistedMarketState): Promise<void> {
    if (!this.filePath) {
      return;
    }

    const payload = JSON.stringify(
      { ...state, version: STATE_VERSION },
      null,
      2,
    );
    const temporaryPath = `${this.filePath}.tmp`;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, payload, 'utf-8');
      await rename(temporaryPath, this.filePath);
      this.persistence?.success('market-state');
    } catch (error) {
      this.logger.error(
        `Could not persist market state to ${this.filePath}: ${describeError(error)}`,
      );
      this.persistence?.failure('market-state', 'write', error);
    }
  }

  private isPersistedState(value: unknown): value is PersistedMarketState {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Partial<PersistedMarketState>;

    return Array.isArray(candidate.symbols);
  }
}

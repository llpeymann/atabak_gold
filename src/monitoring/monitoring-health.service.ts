/**
 * Phase 11 — health and readiness (§10, §13).
 *
 * Liveness answers “is the process alive?”. Readiness answers “can this process do its essential
 * work right now?”. They are deliberately different: a price-provider outage must never make the
 * container look dead (the bot can still answer users and keep their data), while a persistence
 * failure that silently loses writes must never be hidden behind a green health check.
 *
 * Every unknown is reported as unknown. When nothing has been written yet, the persistence check is
 * `warn` — not `pass`, because there is no evidence yet, and not `fail`, because nothing broke.
 */

import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { MarketStateService } from '../market/market-state.service';
import { MonitoringService } from './monitoring.service';
import { MonitoringStore } from './monitoring.store';
import {
  LivenessReport,
  ReadinessCheck,
  ReadinessReport,
  MonitoringSnapshot,
} from './monitoring.types';

/** A persistence failure younger than this marks readiness unavailable. */
const PERSISTENCE_FAILURE_WINDOW_MS = 15 * 60_000;

@Injectable()
export class MonitoringHealthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly store: MonitoringStore,
    private readonly monitoring: MonitoringService,
    private readonly marketState: MarketStateService,
  ) {}

  liveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  readiness(now: Date = new Date()): ReadinessReport {
    const checks: ReadinessCheck[] = [];

    checks.push(this.persistenceCheck(now));
    checks.push(this.marketDataCheck(now));
    checks.push(this.incidentCheck());
    checks.push(this.notificationCheck());

    const status = checks.some((check) => check.status === 'fail')
      ? 'unavailable'
      : checks.some((check) => check.status === 'warn')
        ? 'degraded'
        : 'ok';

    return {
      status,
      checks,
      timestamp: now.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  private persistenceCheck(now: Date): ReadinessCheck {
    const health = this.store.writeHealth;

    if (health.lastWriteErrorAt !== null) {
      const failedAt = Date.parse(health.lastWriteErrorAt);
      const okAt =
        health.lastWriteOkAt === null ? 0 : Date.parse(health.lastWriteOkAt);

      if (
        !Number.isNaN(failedAt) &&
        failedAt > okAt &&
        now.getTime() - failedAt < PERSISTENCE_FAILURE_WINDOW_MS
      ) {
        return {
          name: 'persistence',
          status: 'fail',
          detail: `آخرین نوشتن ناموفق بود: ${health.lastWriteError ?? 'unknown error'}`,
        };
      }
    }

    if (health.lastWriteOkAt === null) {
      return {
        name: 'persistence',
        status: 'warn',
        detail: 'هنوز نوشتن موفقی در این فرآیند ثبت نشده است',
      };
    }

    return {
      name: 'persistence',
      status: 'pass',
      detail: 'آخرین نوشتن با موفقیت انجام شد',
    };
  }

  private marketDataCheck(now: Date): ReadinessCheck {
    if (!this.config.monitoringEnabled) {
      return {
        name: 'market-data',
        status: 'warn',
        detail: 'پایش خاموش است؛ تازگی داده ارزیابی نشد',
      };
    }

    let latest: string | null = null;

    for (const definition of this.config.symbolRegistry) {
      const state = this.marketState.getState(definition, now);

      if (!state) {
        continue;
      }

      if (latest === null || state.lastSuccessfulUpdate > latest) {
        latest = state.lastSuccessfulUpdate;
      }
    }

    if (latest === null) {
      return {
        name: 'market-data',
        status: 'warn',
        detail: 'هنوز دادهٔ معتبری از بازار ثبت نشده است',
      };
    }

    const ageMs = now.getTime() - Date.parse(latest);
    const limit = this.config.monitoringStaleAfterMs;

    if (Number.isNaN(ageMs)) {
      return {
        name: 'market-data',
        status: 'warn',
        detail: 'زمان آخرین به‌روزرسانی معتبر قابل خواندن نبود',
      };
    }

    if (ageMs > limit) {
      return {
        name: 'market-data',
        status: 'warn',
        detail: `آخرین دادهٔ معتبر ${Math.round(ageMs / 60_000)} دقیقه پیش بود (حد ${Math.round(
          limit / 60_000,
        )} دقیقه)`,
      };
    }

    return {
      name: 'market-data',
      status: 'pass',
      detail: `آخرین دادهٔ معتبر ${Math.round(ageMs / 60_000)} دقیقه پیش`,
    };
  }

  private incidentCheck(): ReadinessCheck {
    // Reading the incident list is cheap (bounded by the incident cap) and synchronous.
    const open = this.monitoring.openIncidentsSync();
    const critical = open.filter(
      (incident) => incident.severity === 'CRITICAL',
    ).length;

    if (critical > 0) {
      return {
        name: 'incidents',
        status: 'warn',
        detail: `${critical} رخداد بحرانی باز است`,
      };
    }

    return {
      name: 'incidents',
      status: 'pass',
      detail: 'رخداد بحرانی باز نیست',
    };
  }

  private notificationCheck(): ReadinessCheck {
    if (!this.config.monitoringEnabled) {
      return {
        name: 'notifications',
        status: 'pass',
        detail: 'پایش خاموش است (به‌صراحت پیکربندی شده)',
      };
    }

    const destination = this.monitoring.notificationDestination();

    if (!destination.configured) {
      return {
        name: 'notifications',
        status: 'warn',
        detail: destination.reason ?? 'مقصد اطلاع‌رسانی پیکربندی نشده است',
      };
    }

    return {
      name: 'notifications',
      status: 'pass',
      detail: `مقصد اطلاع‌رسانی: ${destination.platform}`,
    };
  }

  /** Compact, secret-free view for the admin screen (never exposed on the HTTP endpoint). */
  summary(now: Date = new Date()): MonitoringSnapshot {
    return this.monitoring.snapshot(now);
  }
}

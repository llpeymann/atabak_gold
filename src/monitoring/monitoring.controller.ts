/**
 * Phase 11 — health endpoints (§10).
 *
 * * `GET /health/live`   — process liveness. Always 200 while the event loop answers.
 * * `GET /health/ready`  — readiness for essential work. 200 (`ok`/`degraded`) or 503 (`unavailable`).
 * * `GET /health`        — unchanged Phase 0 probe, kept verbatim for the existing deployment
 *                          configuration (Docker healthcheck, hosting platform). Removing or
 *                          re-meaning it would break deployments that already call it.
 *
 * Nothing secret is exposed: checks report *categories* and human-readable reasons, never chat ids,
 * tokens, stack traces or customer data. Detailed operational state stays inside the authorized bot
 * surface. Probes are O(number of tracked symbols) and never call the price provider (§10).
 */

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { MonitoringHealthService } from './monitoring-health.service';
import type { LivenessReport, ReadinessReport } from './monitoring.types';

@Controller('health')
export class MonitoringController {
  constructor(private readonly health: MonitoringHealthService) {}

  @Get('live')
  live(): LivenessReport {
    return this.health.liveness();
  }

  @Get('ready')
  ready(@Res({ passthrough: true }) response: Response): ReadinessReport {
    const report = this.health.readiness();

    response.status(
      report.status === 'unavailable'
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.OK,
    );

    return report;
  }
}

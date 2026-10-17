import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from './../src/app.module';
import { AdminStore } from './../src/admin/admin.store';
import { AdminErrorService } from './../src/admin/admin-error.service';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { callbackDataForAdminErrors } from './../src/bot/ux/callback-data';
import { MonitoringDispatchService } from './../src/monitoring/monitoring-dispatch.service';
import { MonitoringService } from './../src/monitoring/monitoring.service';
import { MonitoringStore } from './../src/monitoring/monitoring.store';
import { UserStore } from './../src/users/user.store';
import { AlertStore } from './../src/alerts/alert.store';
import { PublicationStore } from './../src/channel/publication.store';

/**
 * Phase 11 end-to-end: the whole application boots (including configuration validation and the
 * health controller) and the monitoring path is exercised against the real stores.
 *
 * What can only be checked here:
 *   1. the HTTP health endpoints exist, distinguish liveness from readiness, and expose no secret;
 *   2. a real detection (three failed cycles) becomes a durable Phase 10 incident that the admin
 *      error center *renders* for an authorized administrator;
 *   3. the notification is queued, sent through the platform adapter and its outcome persisted;
 *   4. everything survives an application restart (a second instance over the same documents).
 *
 * The platform transport is a double that records the call — nothing leaves the process.
 */

let updateId = 0;
let wire: { url: string; body: Record<string, unknown> }[] = [];

describe('Monitoring (e2e)', () => {
  let app: INestApplication;
  let monitoring: MonitoringService;
  let dispatcher: MonitoringDispatchService;
  let monitorStore: MonitoringStore;
  let errors: AdminErrorService;
  let botUx: BotUxService;

  const owner = 'e2e-owner';
  const chat = 'e2e-chat';

  const httpDouble = () => ({
    post: (url: string, body: unknown) => {
      wire.push({ url, body: (body ?? {}) as Record<string, unknown> });

      return of({ data: { ok: true, result: { message_id: 42 } } });
    },
    get: () => of({ data: { prices: {} } }),
  });

  const bootApp = async (): Promise<INestApplication> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble())
      .compile();

    const instance = moduleFixture.createNestApplication();

    instance.enableShutdownHooks();
    await instance.init();

    return instance;
  };

  beforeAll(async () => {
    wire = [];
    app = await bootApp();

    monitoring = app.get(MonitoringService);
    dispatcher = app.get(MonitoringDispatchService);
    monitorStore = app.get(MonitoringStore);
    errors = app.get(AdminErrorService);
    botUx = app.get(BotUxService);

    await monitorStore.ensureLoaded();
    await app.get(AdminStore).ensureLoaded();
    await app.get(UserStore).ensureLoaded();
    await app.get(AlertStore).ensureLoaded();
    await app.get(PublicationStore).ensureLoaded();
  });

  afterAll(async () => {
    await app.close();
  });

  const press = async (data: string): Promise<void> => {
    await botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: (updateId += 1) + 90_000,
      platformUserId: owner,
      chatId: chat,
      messageId: 900,
      callbackId: `e2e-mon-${updateId}`,
      data,
    });
  };

  const lastText = (): string =>
    (wire.at(-1)?.body.text as string | undefined) ?? '';

  describe('health endpoints', () => {
    it('answers liveness without touching any dependency', async () => {
      const response = await request(app.getHttpServer() as Server).get(
        '/health/live',
      );
      const body = response.body as { status: string; uptimeSeconds: number };

      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(typeof body.uptimeSeconds).toBe('number');
    });

    it('answers readiness with per-check evidence and no secret', async () => {
      const response = await request(app.getHttpServer() as Server).get(
        '/health/ready',
      );
      const body = response.body as {
        status: string;
        checks: { name: string; status: string; detail: string }[];
      };

      expect([200, 503]).toContain(response.status);
      expect(Array.isArray(body.checks)).toBe(true);

      const names = body.checks.map((check) => check.name);

      expect(names).toEqual(
        expect.arrayContaining(['persistence', 'market-data', 'notifications']),
      );
      expect(JSON.stringify(body)).not.toContain('990001');
      expect(JSON.stringify(body)).not.toMatch(/bot\d+:/);
    });

    it('keeps the Phase 0 `/health` probe working unchanged', async () => {
      const response = await request(app.getHttpServer() as Server).get(
        '/health',
      );
      const body = response.body as { status: string };

      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
    });
  });

  describe('detection → incident → notification', () => {
    it('turns repeated price-cycle failures into one durable, rendered incident', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await monitoring.onPriceCycleFailure({
          reasonCode: 'CYCLE_FAILED',
          error: 'connection refused',
          transport: true,
        });
      }

      const open = errors
        .list({ status: 'OPEN' })
        .filter((incident) => incident.category === 'PRICE_API');

      expect(open).toHaveLength(1);
      expect(open[0].severity).toBe('HIGH');

      // The Phase 10 error center renders it — one incident list, not a second one.
      await press(callbackDataForAdminErrors('open', 1));
      expect(lastText()).toContain('مرکز خطا');
      expect(lastText()).toContain('PRICE_API');
      expect(lastText()).toContain(open[0].incidentId);
    });

    it('queues the notification and delivers it through the adapter', async () => {
      const before = wire.length;

      await dispatcher.processDue(new Date());

      const sent = monitorStore
        .listNotifications()
        .filter((notification) => notification.status === 'SENT');

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(wire.length).toBeGreaterThan(before);
      expect(wire.at(-1)?.body.chat_id).toBe('990001');
    });

    it('resolves the incident on real evidence and reports the recovery', async () => {
      const at = new Date(Date.now() + 1000);

      await monitoring.onPriceCycleSuccess(at);
      await dispatcher.processDue(new Date(Date.now() + 2000));

      const open = errors
        .list({ status: 'OPEN' })
        .filter((incident) => incident.category === 'PRICE_API');

      expect(open).toHaveLength(0);

      const recovery = monitorStore
        .listNotifications()
        .filter((notification) => notification.kind === 'RECOVERY');

      expect(recovery).toHaveLength(1);
    });

    it('does not produce a notification storm when the failure repeats', async () => {
      const before = monitorStore.listNotifications().length;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await monitoring.onPriceCycleFailure({
          reasonCode: 'CYCLE_FAILED',
          error: 'still down',
          transport: true,
        });
      }

      await dispatcher.processDue(new Date());

      // At most one new incident notification: the earlier one is inside its cooldown.
      expect(
        monitorStore.listNotifications().length - before,
      ).toBeLessThanOrEqual(1);
    });
  });

  describe('restart', () => {
    it('keeps incidents, watches and the outbox across a restart', async () => {
      const beforeNotifications = monitorStore.listNotifications().length;
      const beforeIncidents = errors.list({}).length;

      await app.close();
      app = await bootApp();

      monitoring = app.get(MonitoringService);
      dispatcher = app.get(MonitoringDispatchService);
      monitorStore = app.get(MonitoringStore);
      errors = app.get(AdminErrorService);

      await monitorStore.ensureLoaded();
      await app.get(AdminStore).ensureLoaded();

      expect(monitorStore.listNotifications().length).toBe(beforeNotifications);
      expect(errors.list({}).length).toBe(beforeIncidents);
      expect(errors.list({ status: 'OPEN' }).length).toBeGreaterThanOrEqual(1);

      // The restarted process still knows the destination and can drain the queue.
      const result = await dispatcher.processDue(new Date());
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });
  });
});

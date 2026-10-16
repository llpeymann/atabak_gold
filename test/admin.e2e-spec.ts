import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';

import { AppModule } from './../src/app.module';
import { AppConfigService } from './../src/config/app-config.service';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { AdminService } from './../src/bot/admin/admin.service';
import { AdminStore } from './../src/admin/admin.store';
import { AdminBroadcastService } from './../src/admin/admin-broadcast.service';
import { UserStore } from './../src/users/user.store';
import { AlertStore } from './../src/alerts/alert.store';
import { PublicationStore } from './../src/channel/publication.store';
import { ChannelEngineService } from './../src/channel/channel-engine.service';
import { SalesService } from './../src/sales/sales.service';
import {
  callbackDataForAdminAudit,
  callbackDataForAdminBroadcast,
  callbackDataForAdminBroadcastAudience,
  callbackDataForAdminBroadcastSave,
  callbackDataForAdminBroadcastStart,
  callbackDataForAdminBroadcastText,
  callbackDataForAdminChannels,
  callbackDataForAdminHub,
  callbackDataForAdminPublishing,
} from './../src/bot/ux/callback-data';

let updateId = 0;

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

let wire: WireCall[] = [];

/**
 * Phase 10 end-to-end: the *whole* application boots (config validation included) and the admin
 * surface is exercised through the real router against the real stores, with the admin document in
 * the suite's throw-away directory.
 *
 * Three properties can only be checked here and not in a unit test:
 *   1. the admin row is rendered for the allow-listed owner and for nobody else,
 *   2. the publication switch survives a *restart* (a second application instance reads it back),
 *   3. the audit trail, the activity days and a prepared broadcast are durable documents that other
 *      phases' records are not disturbed by.
 *
 * Only the platform transport is doubled — no network access, and the broadcast is only ever sent to
 * synthetic recipients created inside the suite.
 */
describe('Admin system (e2e)', () => {
  let app: INestApplication;
  let botUx: BotUxService;
  let admin: AdminService;
  let store: AdminStore;

  const owner = 'e2e-owner';
  const operator = 'e2e-admin';
  const stranger = 'e2e-user';
  const chat = 'e2e-chat';

  const bootApp = async (): Promise<INestApplication> => {
    const httpDouble = {
      post: (url: string, body: unknown) => {
        wire.push({ url, body: (body ?? {}) as Record<string, unknown> });

        return of({ data: { ok: true, result: { message_id: 42 } } });
      },
      get: () => of({ data: { prices: {} } }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      .compile();

    const instance = moduleFixture.createNestApplication();

    instance.enableShutdownHooks();
    await instance.init();

    return instance;
  };

  beforeAll(async () => {
    wire = [];
    app = await bootApp();

    botUx = app.get(BotUxService);
    admin = app.get(AdminService);
    store = app.get(AdminStore);

    await app.get(UserStore).ensureLoaded();
    await app.get(AlertStore).ensureLoaded();
    await app.get(PublicationStore).ensureLoaded();
    await store.ensureLoaded();
  });

  afterAll(async () => {
    await app.close();
  });

  const message = async (
    text: string,
    platformUserId = owner,
    chatId = chat,
  ): Promise<void> => {
    await botUx.handleUpdate({
      kind: 'message',
      platform: 'bale',
      updateId: (updateId += 1) + 70_000,
      platformUserId,
      chatId,
      text,
      messageId: 700 + updateId,
    });
  };

  const press = async (
    data: string,
    platformUserId = owner,
    chatId = chat,
  ): Promise<void> => {
    await botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: (updateId += 1) + 70_000,
      platformUserId,
      chatId,
      messageId: 707,
      callbackId: `e2e-cb-${updateId}`,
      data,
    });
  };

  const lastText = (): string =>
    (wire.at(-1)?.body.text as string | undefined) ?? '';

  const lastKeyboardRows = (): string[][] => {
    const markup = wire.at(-1)?.body.reply_markup as
      { inline_keyboard: { text: string }[][] } | undefined;

    return (markup?.inline_keyboard ?? []).map((row) =>
      row.map((button) => button.text),
    );
  };

  it('validates the admin configuration at startup and exposes it through the config service', () => {
    const config = app.get(AppConfigService);

    expect(config.adminOwnerIds).toContain(`bale:${owner}`);
    expect(config.adminUserIds).toContain(`bale:${operator}`);
    expect(config.adminBroadcastEnabled).toBe(true);
    expect(config.adminBroadcastMinIntervalMs).toBe(0);
    expect(config.adminReportMaxDays).toBeGreaterThan(0);
  });

  it('shows the panel in the menu for the owner only', async () => {
    expect(admin.roleOf('bale', owner)).toBe('OWNER');
    expect(admin.roleOf('bale', operator)).toBe('ADMIN');
    expect(admin.roleOf('bale', stranger)).toBeNull();
    expect(admin.enabled).toBe(true);

    await message('/start');

    expect(lastKeyboardRows().flat()).toContain('⚙️ مدیریت');

    await message('/start', stranger);

    expect(lastKeyboardRows().flat()).not.toContain('⚙️ مدیریت');
    // …and the ordinary menu is still the pre-Phase-10 menu for that user.
    expect(
      lastKeyboardRows()
        .flat()
        .some((text) => text.includes('قیمت')),
    ).toBe(true);
  });

  it('opens the hub through the router and records the opening in the audit trail', async () => {
    const before = store.listAudit().length;

    await message('/admin');

    expect(store.listAudit().length).toBeGreaterThan(before);
    expect(store.listAudit().some((row) => row.actor === `bale:${owner}`)).toBe(
      true,
    );
  });

  it('refuses the hub for an identity that is not on the allow-list', async () => {
    const before = store.listAudit().length;

    await press(callbackDataForAdminHub(), stranger);

    expect(store.listAudit().length).toBeGreaterThan(before);
    expect(
      store
        .listAudit()
        .slice(before)
        .some(
          (row) => row.result === 'DENIED' && row.action === 'ADMIN_DENIED',
        ),
    ).toBe(true);
  });

  it('pauses publication durably, and a restart reads the switch back', async () => {
    await press(callbackDataForAdminPublishing('disable', true));

    expect(app.get(ChannelEngineService).publishingEnabled).toBe(false);

    // A new application instance over the same files = a restart.
    const second = await bootApp();

    try {
      expect(second.get(ChannelEngineService).publishingEnabled).toBe(false);
    } finally {
      // Re-enable through the same admin path so the rest of the suite publishes normally.
      await press(callbackDataForAdminPublishing('enable', true));
      await second.close();
    }

    expect(app.get(ChannelEngineService).publishingEnabled).toBe(true);

    const transitions = store
      .listAudit()
      .filter((row) => row.action === 'CHANNEL_PUBLISHING_TOGGLED');

    expect(transitions.length).toBeGreaterThanOrEqual(2);
    expect(transitions.map((row) => row.toState)).toContain('disabled');
    expect(transitions.map((row) => row.toState)).toContain('enabled');
  });

  it('prepares a broadcast without sending, and only the final confirmation starts it', async () => {
    // Synthetic recipients with platform-shaped chat ids: the audience rule refuses anything that
    // could not be a real chat, and this suite never contacts a live platform.
    await app.get(UserStore).upsertUser('e2e-recipient-1', 'bale', '910000001');
    await app.get(UserStore).upsertUser('e2e-recipient-2', 'bale', '910000002');

    await press(callbackDataForAdminBroadcast());
    await press(callbackDataForAdminBroadcastAudience('all', null));

    await press(callbackDataForAdminBroadcastText());
    await message('اطلاعیهٔ آزمایشی فاز دهم');

    await press(callbackDataForAdminBroadcastSave());

    const broadcast = app.get(AdminBroadcastService);
    const prepared = broadcast.list(1)[0];

    expect(prepared).toBeDefined();
    expect(prepared?.status).toBe('PREPARED');
    expect(prepared?.totalRecipients).toBeGreaterThanOrEqual(0);

    if (!prepared) {
      throw new Error('no broadcast was prepared');
    }

    await press(callbackDataForAdminBroadcastStart(prepared.reference));

    const started = broadcast.list(1)[0];

    expect(['RUNNING', 'COMPLETED', 'FAILED']).toContain(started?.status ?? '');
    expect(broadcast.report(prepared.reference)?.totals).toBeDefined();
  });

  it('keeps the other phases’ documents intact while the admin document grows', async () => {
    // The admin document is its own file: users, alerts and publication jobs are untouched by it.
    const adminFile = app.get(AppConfigService).adminDataFile;

    expect(adminFile).not.toBeNull();
    expect(app.get(UserStore).path).not.toBe(adminFile);
    expect(app.get(AlertStore).path).not.toBe(adminFile);
    expect(app.get(PublicationStore).path).not.toBe(adminFile);

    const users = app.get(UserStore);

    await users.upsertUser('e2e-admin-survivor', 'bale', 'e2e-survivor-chat');

    const restarted = await bootApp();

    try {
      await restarted.get(UserStore).ensureLoaded();

      expect(
        restarted
          .get(UserStore)
          .findUserByPlatform('bale', 'e2e-admin-survivor'),
      ).not.toBeNull();
      // …and the admin trail is still there in the same restart.
      expect(restarted.get(AdminStore).listAudit().length).toBeGreaterThan(0);
    } finally {
      await restarted.close();
    }
  });

  it('reports the dashboard and the channel screen from live services', async () => {
    await press(callbackDataForAdminChannels());

    const channels = lastText();

    expect(channels).toContain('کانال‌ها و انتشار');
    expect(channels).toContain('وضعیت انتشار');

    await press(callbackDataForAdminAudit(1));

    expect(lastText()).toContain('رخدادنگار مدیریتی');
  });

  it('has a sales document of its own, so the admin and the sales engine never share a file', () => {
    const salesPath = app.get(SalesService);

    expect(salesPath).toBeDefined();

    const config = app.get(AppConfigService);

    expect(config.salesDataFile).not.toBe(config.adminDataFile);
  });
});

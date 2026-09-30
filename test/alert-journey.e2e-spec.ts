import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';

import { AppModule } from './../src/app.module';
import { AlertNotificationService } from './../src/alerts/alert-notification.service';
import { AlertService } from './../src/alerts/alert.service';
import { AlertStore } from './../src/alerts/alert.store';
import { Alert, AlertDelivery } from './../src/alerts/alert.types';
import { BotService } from './../src/bot/bot.service';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { MarketEngineService } from './../src/market/market-engine.service';
import { UserStore } from './../src/users/user.store';
import {
  InboundCallback,
  InboundMessage,
} from './../src/platform/platform.types';
import {
  DEFAULT_SEED_PRICES,
  rawPricePayload,
} from './../src/testing/test-doubles';

/**
 * Phase 3 end-to-end journey: the whole application boots (config, market engine, alert engine,
 * stores, platform adapters, UX router) and only the Bot API transport is replaced.
 *
 * What this proves beyond the integration suites: the alert pipeline works across the real module
 * graph, the notification leaves through the production transport code, one trigger produces
 * exactly one user-visible message, and nothing in the alert path reaches the external price API.
 *
 * Every test talks as its own fresh user (a new platform identity), so the shared data files of
 * the e2e run cannot leak state between tests.
 */

let updateId = 6000;
let userSequence = 0;

interface Identity {
  platformUserId: string;
  chatId: string;
}

let identity: Identity;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: identity.chatId,
  platformUserId: identity.platformUserId,
  messageId: 400 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: identity.chatId,
  platformUserId: identity.platformUserId,
  messageId: 800,
  callbackId: `cb-${updateId}`,
  data,
});

interface WireCall {
  url: string;
  body: Record<string, unknown>;
  /** True when the transport rejected this call (the platform was unreachable). */
  failed?: boolean;
}

interface Stack {
  app: INestApplication;
  wire: WireCall[];
  botUx: BotUxService;
  bot: BotService;
  engine: MarketEngineService;
  alerts: AlertService;
  alertStore: AlertStore;
  notifications: AlertNotificationService;
  users: UserStore;
  /** Make every `sendMessage` fail (used for the delivery-retry journey). */
  failSends: (fail: boolean) => void;
}

describe('Price alert journey (e2e)', () => {
  let stacks: Stack[] = [];
  const priceApiUrl =
    process.env.PRICE_API_URL ?? 'https://api.example.test/prices';

  beforeAll(() => {
    expect(process.env.ALERTS_DATA_FILE ?? '').not.toBe('');
    expect(process.env.ALERTS_DATA_FILE ?? '').not.toContain(
      '/home/user/atabak_gold',
    );
  });

  beforeEach(() => {
    const index = ++userSequence;
    identity = {
      platformUserId: `e2e-alert-user-${index}`,
      chatId: `e2e-alert-chat-${index}`,
    };
  });

  afterEach(async () => {
    for (const stack of stacks) {
      await stack.app.close();
    }
    stacks = [];
  });

  const boot = async (): Promise<Stack> => {
    const wire: WireCall[] = [];
    let sendFailure = false;

    const httpDouble = {
      post: (url: string, body: Record<string, unknown>) => {
        if (sendFailure && url.endsWith('/sendMessage')) {
          wire.push({ url, body, failed: true });
          return throwError(() => new Error('platform is down'));
        }

        wire.push({ url, body });

        if (url.endsWith('/getUpdates')) {
          return of({ data: { ok: true, result: [] } });
        }

        return of({
          data: { ok: true, result: { message_id: 900 + wire.length } },
        });
      },
      get: (url: string) => {
        wire.push({ url, body: {} });
        return of({ data: rawPricePayload(DEFAULT_SEED_PRICES) });
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      .compile();

    const app = moduleFixture.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    const stack: Stack = {
      app,
      wire,
      botUx: app.get(BotUxService),
      bot: app.get(BotService),
      engine: app.get(MarketEngineService),
      alerts: app.get(AlertService),
      alertStore: app.get(AlertStore),
      notifications: app.get(AlertNotificationService),
      users: app.get(UserStore),
      failSends: (fail) => {
        sendFailure = fail;
      },
    };

    stacks.push(stack);

    return stack;
  };

  /** One validated market cycle (the alert path never uses the external price API). */
  const cycle = async (
    stack: Stack,
    prices: Record<string, number> = {},
  ): Promise<void> => {
    await stack.engine.evaluateCycle(
      rawPricePayload(
        { ...DEFAULT_SEED_PRICES, ...prices },
        new Date().toISOString(),
      ),
      new Date(),
    );
    // Let the asynchronous notification dispatch finish.
    await stack.notifications.drain();
  };

  const userMessages = (stack: Stack): WireCall[] =>
    stack.wire.filter(
      (call) =>
        call.url.endsWith('/sendMessage') &&
        call.body.chat_id === identity.chatId,
    );

  /**
   * Trigger notifications of this chat: identified by the closing line of the notification body,
   * so a screen that merely mentions «هشدار» is never mistaken for one.
   */
  const alertNotifications = (stack: Stack): WireCall[] =>
    userMessages(stack).filter((call) => {
      const text = typeof call.body.text === 'string' ? call.body.text : '';

      return (
        text.includes('🔔 <b>هشدار قیمت</b>') &&
        text.includes('یک‌بار اجرا شد و غیرفعال شده است')
      );
    });

  const lastText = (stack: Stack): string => {
    const body = stack.wire.at(-1)?.body;

    return typeof body?.text === 'string' ? body.text : '';
  };

  /** The Phase 2 user created by the interaction (alerts never introduce a second identity). */
  const chatUser = (stack: Stack) =>
    stack.users
      .listUsers()
      .find((user) => user.platformUserId === identity.platformUserId) ?? null;

  const alertsOf = (stack: Stack): Alert[] => {
    const user = chatUser(stack);

    return user ? stack.alerts.listForUser(user.id) : [];
  };

  const deliveryOf = (stack: Stack, alertId: string): AlertDelivery | null =>
    stack.alerts.findDelivery(alertId);

  /** The whole creation wizard, exactly as a user would press it. */
  const createAlertInChat = async (
    stack: Stack,
    symbol: string,
    type: 'above' | 'below' | 'up' | 'down',
    value: string,
  ): Promise<void> => {
    await stack.botUx.handleUpdate(message('/start'));
    await stack.botUx.handleUpdate(callback('v1:alert:new'));
    await stack.botUx.handleUpdate(callback(`v1:alert:sym:${symbol}`));
    await stack.botUx.handleUpdate(callback(`v1:alert:type:${type}`));
    await stack.botUx.handleUpdate(message(value));
    await stack.botUx.handleUpdate(callback('v1:alert:confirm'));
  };

  // --- the whole journey ------------------------------------------------------

  it('creates an alert in the chat, fires it on a real price cycle and notifies once', async () => {
    const stack = await boot();

    // One validated Phase 1 cycle first: every screen must work against real market state.
    await cycle(stack);
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    expect(lastText(stack)).toContain('هشدار با موفقیت ایجاد شد');

    const created = alertsOf(stack)[0];
    expect(created.status).toBe('ACTIVE');
    expect(created.targetPrice).toBe(18_000_000);
    expect(created.userId).toBe(chatUser(stack)?.id);

    const providerCallsBefore = stack.wire.filter((call) =>
      call.url.startsWith(priceApiUrl),
    ).length;

    // A cycle below the target: nothing happens.
    await cycle(stack, { IR_GOLD_18K: 17_600_000 });
    expect(alertsOf(stack)[0]?.status).toBe('ACTIVE');
    expect(alertNotifications(stack)).toHaveLength(0);

    // A cycle that crosses the target.
    await cycle(stack, { IR_GOLD_18K: 18_050_000 });

    expect(alertsOf(stack)[0]?.status).toBe('TRIGGERED');
    const delivery = deliveryOf(stack, created.id) as AlertDelivery;
    expect(delivery.status).toBe('SENT');
    expect(delivery.reason).toBe('PRICE_ABOVE_REACHED');
    expect(delivery.attemptCount).toBe(1);

    const notifications = alertNotifications(stack);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.body.chat_id).toBe(identity.chatId);
    expect(notifications[0]?.body.text).toContain('طلای ۱۸ عیار');
    expect(notifications[0]?.body.text).toContain('۱۸٬۰۵۰٬۰۰۰');

    // The evaluation path itself never fetched a price.
    expect(
      stack.wire.filter((call) => call.url.startsWith(priceApiUrl)).length,
    ).toBe(providerCallsBefore);

    // A second crossing must not notify again (one-shot).
    await cycle(stack, { IR_GOLD_18K: 17_500_000 });
    await cycle(stack, { IR_GOLD_18K: 18_400_000 });
    expect(alertNotifications(stack)).toHaveLength(1);
    expect(deliveryOf(stack, created.id)?.status).toBe('SENT');

    // The user sees the outcome in the alert detail.
    await stack.botUx.handleUpdate(callback('v1:alert:list'));
    expect(lastText(stack)).toContain('هشدارهای من');

    await stack.botUx.handleUpdate(callback(`v1:alert:view:${created.id}`));
    const detail = lastText(stack);
    expect(detail).toContain('جزئیات هشدار');
    expect(detail).toContain('فعال شده');
    expect(detail).toContain('پیام هشدار برای شما ارسال شد');
  });

  it('keeps a triggered alert one-shot across a restart', async () => {
    const first = await boot();

    await cycle(first);
    await createAlertInChat(first, 'USD', 'above', '1,060,000');
    await cycle(first, { USD: 1_070_000 });

    const alertId = alertsOf(first)[0].id;
    expect(alertNotifications(first)).toHaveLength(1);
    expect(deliveryOf(first, alertId)?.status).toBe('SENT');

    await first.app.close();
    stacks = stacks.filter((stack) => stack !== first);

    // A brand-new process reading the same files.
    const second = await boot();
    await second.alertStore.ensureLoaded();

    expect(alertsOf(second)[0]?.id).toBe(alertId);
    expect(alertsOf(second)[0]?.status).toBe('TRIGGERED');

    await cycle(second, { USD: 1_050_000 });
    await cycle(second, { USD: 1_090_000 });

    expect(alertsOf(second)[0]?.status).toBe('TRIGGERED');
    expect(deliveryOf(second, alertId)?.status).toBe('SENT');
    expect(deliveryOf(second, alertId)?.attemptCount).toBe(1);
    expect(alertNotifications(second)).toHaveLength(0);
  });

  it('gives up after the configured attempts when the platform is unreachable, then recovers', async () => {
    const stack = await boot();
    await cycle(stack);
    stack.failSends(true);

    // The wizard also fails to render, but the user's presses are still processed: the alert
    // exists and the trigger happens on the next accepted cycle.
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(stack)[0];
    expect(created).toBeDefined();

    await cycle(stack, { IR_GOLD_18K: 18_050_000 });

    const delivery = deliveryOf(stack, created.id) as AlertDelivery;
    expect(delivery.status).toBe('FAILED');
    // 1 attempt + 3 configured retries.
    expect(delivery.attemptCount).toBe(4);
    expect(delivery.lastError).toContain('maximum number of attempts');

    // The alert is spent (one-shot) and every attempt to reach the user failed.
    expect(alertsOf(stack)[0]?.status).toBe('TRIGGERED');
    const attempts = alertNotifications(stack);
    expect(attempts).toHaveLength(4);
    expect(attempts.every((call) => call.failed === true)).toBe(true);

    // Once the platform is reachable again, a new alert works normally (no stuck state).
    stack.failSends(false);
    const second = await stack.alerts.create(chatUser(stack)?.id ?? '', {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 18_300_000,
    });
    expect(second.ok).toBe(true);

    await cycle(stack, { IR_GOLD_18K: 18_400_000 });
    expect(
      alertNotifications(stack).filter((call) => call.failed !== true),
    ).toHaveLength(1);
  });

  it('never notifies for a price Phase 1 rejects', async () => {
    const stack = await boot();
    await cycle(stack);
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(stack)[0];

    // A malformed value and a value far outside the accepted range: both are rejected upstream.
    await stack.engine.evaluateCycle(
      {
        gold: [{ symbol: 'IR_GOLD_18K', price: 'not-a-number' }],
        currency: [],
      },
      new Date(),
    );
    await stack.notifications.drain();

    await stack.engine.evaluateCycle(
      rawPricePayload({ IR_GOLD_18K: 90_000_000 }, new Date().toISOString()),
      new Date(),
    );
    await stack.notifications.drain();

    expect(alertsOf(stack)[0]?.status).toBe('ACTIVE');
    expect(alertNotifications(stack)).toHaveLength(0);
    expect(deliveryOf(stack, created.id)).toBeNull();

    // The alert still works when a valid price crosses the target.
    await cycle(stack, { IR_GOLD_18K: 18_050_000 });
    expect(alertsOf(stack)[0]?.status).toBe('TRIGGERED');
    expect(alertNotifications(stack)).toHaveLength(1);
  });

  it('refuses a second alert beyond the configured capacity and explains it in the chat', async () => {
    const stack = await boot();
    await cycle(stack);
    const user = await stack.users.upsertUser(
      identity.platformUserId,
      'bale',
      identity.chatId,
    );

    for (let index = 0; index < 5; index += 1) {
      const created = await stack.alerts.create(user.id, {
        type: 'PRICE_ABOVE',
        symbol: 'IR_GOLD_18K',
        targetPrice: 18_000_000 + index * 10_000,
      });
      expect(created.ok).toBe(true);
    }

    await stack.botUx.handleUpdate(message('/start'));
    await stack.botUx.handleUpdate(callback('v1:alert:new'));
    await stack.botUx.handleUpdate(callback('v1:alert:sym:IR_GOLD_18K'));
    await stack.botUx.handleUpdate(callback('v1:alert:type:above'));
    await stack.botUx.handleUpdate(message('19,000,000'));
    await stack.botUx.handleUpdate(callback('v1:alert:confirm'));

    expect(lastText(stack)).toContain('حداکثر تعداد هشدار مجاز');
    expect(alertsOf(stack)).toHaveLength(5);
  });

  it('keeps the Phase 1 publication path intact while alerts are active', async () => {
    const stack = await boot();
    await cycle(stack);
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(stack)[0];

    // The scheduled Phase 1 publication still runs (fetch → validate → publish to the channel).
    await stack.bot.handleHalfHourlyPriceUpdate();

    const channelSend = stack.wire.find(
      (call) =>
        call.url.endsWith('/sendMessage') &&
        call.body.chat_id === process.env.BALE_CHANNEL_ID,
    );
    expect(channelSend).toBeDefined();
    expect(stack.wire.some((call) => call.url.includes('/prices'))).toBe(true);

    // …and the alert layer is unaffected by it (the alert target was not crossed by the
    // publication's default payload).
    const delivery = deliveryOf(stack, created.id);
    expect(delivery === null || delivery.status === 'PENDING').toBe(true);
  });

  // §87 — Create → Disable → the market reaches the target → NO notification.
  it('never notifies a disabled alert, and re-enabling waits for a new crossing (§80/§16)', async () => {
    const stack = await boot();
    await cycle(stack);
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(stack)[0];

    // The user disables the alert from its detail screen.
    await stack.botUx.handleUpdate(callback(`v1:alert:view:${created.id}`));
    await stack.botUx.handleUpdate(callback(`v1:alert:disable:${created.id}`));
    expect(lastText(stack)).toContain('هشدار غیرفعال شد');
    expect(alertsOf(stack)[0]?.status).toBe('DISABLED');

    // The market crosses the target twice while the alert is disabled: nothing may be sent.
    await cycle(stack, { IR_GOLD_18K: 18_200_000 });
    await cycle(stack, { IR_GOLD_18K: 17_400_000 });
    await cycle(stack, { IR_GOLD_18K: 18_300_000 });

    expect(alertsOf(stack)[0]?.status).toBe('DISABLED');
    expect(alertNotifications(stack)).toHaveLength(0);
    expect(deliveryOf(stack, created.id)).toBeNull();

    // §16 — re-enabling does not fire on the already-true condition…
    await stack.botUx.handleUpdate(callback(`v1:alert:enable:${created.id}`));
    expect(lastText(stack)).toContain('هشدار دوباره فعال شد');
    await cycle(stack, { IR_GOLD_18K: 18_400_000 });
    expect(alertNotifications(stack)).toHaveLength(0);

    // …only a genuine new crossing does.
    await cycle(stack, { IR_GOLD_18K: 17_900_000 });
    await cycle(stack, { IR_GOLD_18K: 18_050_000 });

    expect(alertsOf(stack)[0]?.status).toBe('TRIGGERED');
    expect(alertNotifications(stack)).toHaveLength(1);
  });

  // §87 — Create → Delete → the market reaches the target → NO notification.
  it('never notifies a deleted alert and frees its capacity (§81)', async () => {
    const stack = await boot();
    await cycle(stack);
    await createAlertInChat(stack, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(stack)[0];

    // Deleting needs confirmation, exactly like the real keyboard flow.
    await stack.botUx.handleUpdate(callback(`v1:alert:del:${created.id}`));
    expect(lastText(stack)).toContain('حذف');
    await stack.botUx.handleUpdate(callback(`v1:alert:delok:${created.id}`));
    expect(lastText(stack)).toContain('هشدار حذف شد');

    // The alert is gone for the user and for the evaluator.
    expect(alertsOf(stack)).toHaveLength(0);
    await stack.alertStore.ensureLoaded();
    expect(stack.alerts.findDelivery(created.id)).toBeNull();

    await cycle(stack, { IR_GOLD_18K: 18_200_000 });
    await cycle(stack, { IR_GOLD_18K: 17_500_000 });
    await cycle(stack, { IR_GOLD_18K: 18_600_000 });

    expect(alertNotifications(stack)).toHaveLength(0);
    expect(alertsOf(stack)).toHaveLength(0);

    // §36/§67 — the deleted alert no longer consumes the configured capacity.
    const user = chatUser(stack);
    expect(user).not.toBeNull();
    const again = await stack.alerts.create(user!.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: 19_000_000,
    });
    expect(again.ok).toBe(true);
  });

  // §84 (first half) — an ACTIVE alert survives a restart and can still trigger normally.
  it('survives a restart as ACTIVE and triggers normally in the new process (§61/§84)', async () => {
    const first = await boot();
    await cycle(first);
    await createAlertInChat(first, 'IR_GOLD_18K', 'above', '18,000,000');
    const created = alertsOf(first)[0];
    expect(created.status).toBe('ACTIVE');

    await first.app.close();
    stacks = stacks.filter((stack) => stack !== first);

    // A brand-new process reading the same data files.
    const second = await boot();
    await second.alertStore.ensureLoaded();

    const restored = alertsOf(second);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(created.id);
    expect(restored[0].status).toBe('ACTIVE');
    expect(restored[0].targetPrice).toBe(18_000_000);

    // The restored alert evaluates and delivers normally in the new process.
    await cycle(second, { IR_GOLD_18K: 17_800_000 });
    expect(alertsOf(second)[0]?.status).toBe('ACTIVE');
    expect(alertNotifications(second)).toHaveLength(0);

    await cycle(second, { IR_GOLD_18K: 18_100_000 });

    expect(alertsOf(second)[0]?.status).toBe('TRIGGERED');
    expect(deliveryOf(second, created.id)?.status).toBe('SENT');
    expect(alertNotifications(second)).toHaveLength(1);
  });
});

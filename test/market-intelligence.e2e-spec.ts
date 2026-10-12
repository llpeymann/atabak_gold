import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { rmSync } from 'node:fs';
import { of } from 'rxjs';

import { AppModule } from './../src/app.module';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { MarketEngineService } from './../src/market/market-engine.service';
import {
  InboundCallback,
  InboundMessage,
} from './../src/platform/platform.types';
import { rawPricePayload } from './../src/testing/test-doubles';

/**
 * Phase 4 §46–§56 (journey level) — the market intelligence surfaces end to end.
 *
 * The real application boots (module graph, config validation, market engine, user store, platform
 * adapters). Prices always enter through the Phase 1 pipeline, so every assertion is about a
 * *validated* value; the interaction path is proven to be read-only.
 */

const PLATFORM_USER = 'intel-e2e-user';
const CHAT_ID = 'intel-e2e-chat';
const GOLD = 'IR_GOLD_18K';

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

let updateId = 0;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 700 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 777,
  callbackId: `cb-${updateId}`,
  data,
});

describe('Market intelligence (e2e)', () => {
  let app: INestApplication;
  let botUx: BotUxService;
  let engine: MarketEngineService;
  let wire: WireCall[];

  const boot = async (): Promise<void> => {
    const httpDouble = {
      post: (url: string, body: Record<string, unknown>) => {
        wire.push({ url, body });
        const result = url.endsWith('/getUpdates')
          ? []
          : { message_id: 1000 + wire.length };
        return of({ data: { ok: true, result } });
      },
      get: (url: string) => {
        wire.push({ url, body: {} });
        return of({ data: rawPricePayload({ [GOLD]: 17_000_000 }) });
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      .compile();

    app = moduleFixture.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    botUx = app.get(BotUxService);
    engine = app.get(MarketEngineService);
  };

  const accept = async (
    prices: Record<string, number>,
    at = new Date(),
  ): Promise<void> => {
    await engine.evaluateCycle(rawPricePayload(prices, at.toISOString()), at);
  };

  const open = async (
    data: string,
  ): Promise<{
    text: string;
    buttons: { text: string; callbackData?: string }[];
  }> => {
    await botUx.handleUpdate(callback(data));
    const body = wire.at(-1)?.body ?? {};
    const markup = body.reply_markup as
      | { inline_keyboard?: { text: string; callback_data?: string }[][] }
      | undefined;

    return {
      text: typeof body.text === 'string' ? body.text : '',
      buttons: (markup?.inline_keyboard ?? []).flat().map((button) => ({
        text: button.text,
        callbackData: button.callback_data,
      })),
    };
  };

  const providerCalls = (): WireCall[] =>
    wire.filter((call) => call.url.includes('api.example.test'));

  const marketCalls = (): WireCall[] =>
    wire.filter((call) => call.url.startsWith('https://tapi.bale.ai'));

  beforeEach(async () => {
    wire = [];
    // Each journey starts from an empty (throw-away) market-state file, so the asserted numbers
    // describe this test's own cycles only. The restart test still exercises persistence, because
    // it restarts *inside* the test.
    const stateFile = process.env.MARKET_STATE_FILE ?? '';
    expect(stateFile).not.toBe('');
    expect(stateFile).not.toContain('/home/user/atabak_gold');
    rmSync(stateFile, { force: true });

    await boot();
    await accept({ [GOLD]: 17_000_000 });
    await accept({ [GOLD]: 17_200_000 });
    await accept({ [GOLD]: 17_150_000 });
  });

  afterEach(async () => {
    await app.close();
  });

  it('walks the market intelligence journey from the main menu', async () => {
    await botUx.handleUpdate(message('/start'));

    const hub = await open('v1:screen:market');
    expect(hub.text).toContain('📊 <b>بازار</b>');
    expect(hub.buttons.map((button) => button.text)).toEqual([
      '📊 گزارش امروز',
      '📈 حرکت بازار',
      '🕐 آخرین بروزرسانی',
      '↻ بروزرسانی',
      '⬅️ بازگشت',
      '🏠 منوی اصلی',
    ]);

    const report = await open('v1:screen:report');
    expect(report.text).toContain('📊 <b>گزارش امروز</b>');
    expect(report.text).toContain('اکنون: ۱۷٬۱۵۰٬۰۰۰ ریال');
    // Daily change is measured from the open of the Tehran day (17,000,000).
    expect(report.text).toContain('تغییر روزانه: 🟢 +۱۵۰٬۰۰۰ ریال | +۰٫۸۸٪');

    const detailed = await open('v1:screen:report-full');
    expect(detailed.text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(detailed.text).toContain('بیشترین: ۱۷٬۲۰۰٬۰۰۰ ریال');
    // The low of the day is the open: the only lower value never arrived.
    expect(detailed.text).toContain('کمترین: ۱۷٬۰۰۰٬۰۰۰ ریال');

    const movement = await open('v1:screen:movement');
    // Movement is measured from the previous valid price (17,200,000) — a different basis.
    expect(movement.text).toContain('🔴 −۵۰٬۰۰۰ ریال | −۰٫۲۹٪');
    expect(movement.text).toContain('قیمت قبلی: ۱۷٬۲۰۰٬۰۰۰ ریال');

    const lastUpdate = await open('v1:screen:last-update');
    expect(lastUpdate.text).toContain('🕐 <b>آخرین بروزرسانی</b>');
    expect(lastUpdate.text).toContain('طلای ۱۸ عیار');
  });

  it('refreshes the report without fetching a price or moving the market time', async () => {
    const first = await open('v1:screen:report');
    const refresh = first.buttons.find(
      (button) => button.text === '↻ بروزرسانی',
    );
    expect(refresh?.callbackData).toBe('v1:screen:report');

    const firstTime = first.text.match(/🕐 ([۰-۹:]+)/)?.[1];
    expect(firstTime).toBeTruthy();

    // The button is pressed: the screen is re-rendered from the validated state only.
    const second = await open(refresh!.callbackData!);

    expect(second.text).toContain('اکنون: ۱۷٬۱۵۰٬۰۰۰ ریال');
    expect(second.text.match(/🕐 ([۰-۹:]+)/)?.[1]).toBe(firstTime);
    expect(providerCalls()).toHaveLength(0);
  });

  it('picks up a new validated cycle on the next render', async () => {
    const before = await open('v1:screen:report');

    await accept({ [GOLD]: 17_300_000 });

    const after = await open('v1:screen:report');

    expect(before.text).toContain('اکنون: ۱۷٬۱۵۰٬۰۰۰ ریال');
    expect(after.text).toContain('اکنون: ۱۷٬۳۰۰٬۰۰۰ ریال');

    // The latest accepted price extends the daily window (§7) — visible in the detailed report.
    const detailed = await open('v1:screen:report-full');
    expect(detailed.text).toContain('بیشترین: ۱۷٬۳۰۰٬۰۰۰ ریال');
    expect(detailed.text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(providerCalls()).toHaveLength(0);
  });

  it('keeps showing the last valid report when the provider starts failing', async () => {
    const failed = await engine.evaluateCycle({});
    expect(failed.update.publishable).toBe(false);

    const report = await open('v1:screen:report');

    expect(report.text).toContain('اکنون: ۱۷٬۱۵۰٬۰۰۰ ریال');
    expect(report.text).not.toContain('NaN');
  });

  it('answers every market screen after a restart from the persisted state', async () => {
    const before = await open('v1:screen:report-full');
    expect(before.text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');

    await app.close();
    wire = [];
    await boot();

    const after = await open('v1:screen:report-full');

    expect(after.text).toContain('شروع روز: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(after.text).toContain('بیشترین: ۱۷٬۲۰۰٬۰۰۰ ریال');
    expect(after.text).toContain('کمترین: ۱۷٬۰۰۰٬۰۰۰ ریال');
    expect(after.text).toContain('📈 افزایشی:');
  });

  it('never sends the market intelligence screens to the external provider', async () => {
    for (const screen of [
      'market',
      'report',
      'report-full',
      'movement',
      'last-update',
    ]) {
      await open(`v1:screen:${screen}`);
    }

    expect(providerCalls()).toHaveLength(0);
    expect(marketCalls().length).toBeGreaterThan(0);
  });

  it('rejects an unknown market screen identifier', async () => {
    const text = (await open('v1:screen:no-such-report')).text;

    expect(text).toContain('این گزینه دیگر معتبر نیست.');
  });
});

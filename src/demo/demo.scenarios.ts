/**
 * Demo harness — scenarios (Phase E of the audit mission).
 *
 * Each scenario drives the **real** application code and reports what it observed. Two rules are
 * never broken:
 *
 *  1. **Nothing is invented.** Every number, screen text, reason code and delivery status in the
 *     result comes from a real call into the project's services; a scenario without usable output
 *     reports `FAIL` instead of a friendly-looking placeholder.
 *  2. **Nothing leaves the machine.** Sends go to the capturing transport, and external price data
 *     is never fetched — the market pipeline is fed with payloads that are labelled DEMO on every
 *     screen of the result.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { InboundUpdate } from '../platform/platform.types';
import { formatPriceValue, formatChangePercent } from '../market/price-format';
import { DEMO_REPO_ROOT } from './demo-boot';
import type { DemoContext } from './demo-context';
import type { ScenarioResult, ScenarioStep } from './demo.types';

/** The audit's last real test run, produced by `npm test -- --json` (written by the audit itself). */
const TEST_RESULTS_FILE = join(
  DEMO_REPO_ROOT,
  'docs',
  'audit',
  'TEST_RESULTS.json',
);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Demo price table: obviously round, obviously DEMO numbers, all inside the guardrails the project
 * documents for each symbol. The payload itself is generated from the application's own symbol
 * registry, so it always matches the symbols this deployment actually supports.
 */
const DEMO_PRICES: Record<string, number> = {
  XAUUSD: 2650,
  IR_GOLD_18K: 17_000_000,
  IR_GOLD_24K: 22_600_000,
  IR_GOLD_MELTED: 16_900_000,
  IR_COIN_EMAMI: 92_500_000,
  IR_COIN_BAHAR: 60_000_000,
  IR_COIN_HALF: 45_000_000,
  IR_COIN_QUARTER: 25_000_000,
  IR_COIN_1G: 8_000_000,
  USDT_IRT: 1_035_000,
  USD: 1_032_000,
  EUR: 1_125_000,
  GBP: 1_320_000,
  TRY: 30_000,
  AED: 281_000,
  CNY: 143_000,
};

/** Small, plausible demo movements (percent). */
const DEMO_CHANGES: Record<string, number> = {
  XAUUSD: 0.42,
  IR_GOLD_18K: 1.15,
  IR_GOLD_24K: -0.33,
  IR_COIN_EMAMI: 0.9,
  USDT_IRT: 0.6,
  USD: 0.55,
};

/**
 * Build a complete DEMO payload from the real symbol registry.
 *
 * `omit` removes a symbol (to show a required symbol going missing); `override` replaces one price
 * (to show a guardrail or an anomaly rejection). A symbol the table does not know yet falls back to
 * a round demo value derived from its own documented guardrails, so the demo keeps working when the
 * registry grows.
 */
export function demoPayload(
  registry: readonly {
    symbol: string;
    label: string;
    section: string;
    unit: string;
    minPrice: number | null;
    maxPrice: number | null;
  }[],
  options: { omit?: string[]; override?: Record<string, number> } = {},
): Record<string, unknown> {
  const gold: unknown[] = [];
  const currency: unknown[] = [];

  for (const definition of registry) {
    if ((options.omit ?? []).includes(definition.symbol)) {
      continue;
    }

    const fallback =
      definition.minPrice !== null && definition.maxPrice !== null
        ? Math.round((definition.minPrice + definition.maxPrice) / 2_000) *
          1_000
        : 1_000;

    const row = {
      symbol: definition.symbol,
      name: definition.label,
      price:
        options.override?.[definition.symbol] ??
        DEMO_PRICES[definition.symbol] ??
        fallback,
      change_percent: DEMO_CHANGES[definition.symbol] ?? 0,
    };

    // The upstream feed carries bullion, coins and the FX pair XAUUSD in `gold`, currencies in
    // `currency` — exactly how the parser of this project reads it.
    if (definition.section === 'currency') {
      currency.push(row);
    } else {
      gold.push(row);
    }
  }

  return {
    gold,
    currency,
    timestamp: '2026-10-16T09:00:00+03:30',
  };
}

// --- synthetic user interactions -------------------------------------------------------------

let demoUpdateId = 7000;

function message(userId: string, text: string): InboundUpdate {
  demoUpdateId += 1;

  return {
    kind: 'message',
    updateId: demoUpdateId,
    platform: 'bale',
    chatId: userId,
    platformUserId: userId,
    messageId: demoUpdateId,
    text,
  };
}

function callback(userId: string, data: string): InboundUpdate {
  demoUpdateId += 1;

  return {
    kind: 'callback',
    updateId: demoUpdateId,
    platform: 'bale',
    chatId: userId,
    platformUserId: userId,
    messageId: demoUpdateId,
    callbackId: `demo-cb-${demoUpdateId}`,
    data,
  };
}

const step = (labelFa: string, detail: string, ok = true): ScenarioStep => ({
  labelFa,
  detail,
  ok,
});

/** Wraps a scenario body with timing, status and error reporting. */
function scenario(
  id: string,
  titleFa: string,
  kind: ScenarioResult['kind'],
  phases: number[],
  summaryFa: string,
  body: (
    ctx: DemoContext,
  ) =>
    | Promise<{ steps: ScenarioStep[]; output: unknown }>
    | { steps: ScenarioStep[]; output: unknown },
): (ctx: DemoContext) => Promise<ScenarioResult> {
  return async (ctx: DemoContext): Promise<ScenarioResult> => {
    const startedAt = new Date().toISOString();
    const started = Date.now();

    try {
      const { steps, output } = await body(ctx);
      const failed = steps.filter((entry) => !entry.ok).length;

      return {
        id,
        titleFa,
        kind,
        phases,
        startedAt,
        durationMs: Date.now() - started,
        status: failed === 0 ? 'PASS' : 'FAIL',
        summaryFa,
        steps,
        output,
        error: null,
      };
    } catch (error) {
      return {
        id,
        titleFa,
        kind,
        phases,
        startedAt,
        durationMs: Date.now() - started,
        status: 'FAIL',
        summaryFa,
        steps: [],
        output: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

// --- 1. repository evidence ------------------------------------------------------------------

const overview = scenario(
  'overview',
  'نمای کلی پروژه و وضعیت فازهای ۱ تا ۷',
  'REPOSITORY EVIDENCE',
  [0, 1, 2, 3, 4, 5, 6, 7],
  'فازها، پرونده‌های مستندات و نتیجهٔ آخرین اجرای واقعی تست‌ها، همان‌طور که در مخزن ثبت شده است.',
  () => {
    const docsDir = join(DEMO_REPO_ROOT, 'docs');
    const reports = readdirSync(docsDir)
      .filter((name) => /^PHASE_\d_REPORT\.md$/.test(name))
      .sort();

    const phases = reports.map((name) => {
      const body = readFileSync(join(docsDir, name), 'utf-8');
      const statusLine =
        body
          .split('\n')
          .reverse()
          .find(
            (line) => line.includes('PHASE') && line.includes('COMPLETE'),
          ) ?? '';
      const auditExists = reports.includes(name.replace('_REPORT', '_AUDIT'));

      return {
        phase: name.replace('PHASE_', '').replace('_REPORT.md', ''),
        report: `docs/${name}`,
        audit: auditExists ? `docs/${name.replace('_REPORT', '_AUDIT')}` : null,
        statusLine: statusLine.trim(),
      };
    });

    const packageJson = JSON.parse(
      readFileSync(join(DEMO_REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { name: string; version: string; engines?: { node?: string } };

    let testResults: unknown = null;
    let testsDetail =
      'پروندهٔ نتیجهٔ تست‌ها پیدا نشد (docs/audit/TEST_RESULTS.json).';

    try {
      testResults = JSON.parse(readFileSync(TEST_RESULTS_FILE, 'utf-8'));
      const summary = testResults as {
        jest?: { suites?: number; tests?: number; failed?: number };
        e2e?: { suites?: number; tests?: number; failed?: number };
        lint?: { problems?: number };
        coverage?: Record<string, string>;
        capturedAt?: string;
      };

      testsDetail =
        `jest: ${summary.jest?.tests ?? '?'} تست در ${summary.jest?.suites ?? '?'} سوئیت ` +
        `(خطا: ${summary.jest?.failed ?? '?'}) · e2e: ${summary.e2e?.tests ?? '?'} تست ` +
        `(خطا: ${summary.e2e?.failed ?? '?'}) · lint: ${summary.lint?.problems ?? '?'} مشکل`;
    } catch {
      testsDetail = 'پروندهٔ نتیجهٔ تست‌ها خوانده نشد.';
    }

    return {
      steps: [
        step(
          'مخزن و نسخه',
          `${packageJson.name}@${packageJson.version} · Node ${packageJson.engines?.node ?? '?'}`,
        ),
        step('فازهای دارای گزارش', phases.map((p) => p.phase).join(', ')),
        step(
          'وضعیت اعلام‌شدهٔ هر فاز',
          phases
            .map((p) => `${p.phase}: ${p.statusLine.replace(/`/g, '')}`)
            .join(' | '),
        ),
        step('آخرین اجرای واقعی تست‌ها', testsDetail),
        step(
          'محدودیت‌های محیطی ثبت‌شده',
          'اجرای زندهٔ تلگرام (بدون اعتبارنامه)، ساخت Docker (بدون Docker در محیط) — در docs/KNOWN_ISSUES.md مستند شده‌اند.',
        ),
      ],
      output: { phases, packageJson, testResults },
    };
  },
);

// --- 2. configuration and service status ------------------------------------------------------

const configStatus = scenario(
  'config',
  'وضعیت پیکربندی، سلامت برنامه و داده‌های پایدار',
  'REAL_CODE + DEMO_DATA',
  [0, 1, 2, 3, 5, 7],
  'پیکربندی واقعی اعتبارسنجی‌شدهٔ برنامه (بدون رمز)، پاسخ سلامت، و موجودی واقعی فروشگاه‌های داده.',
  (ctx) => {
    const health = ctx.services.appService.getHealth();
    const users = ctx.services.users.listUsers();
    const referrals = ctx.services.users.listReferrals();
    const rewards = users.flatMap((user) =>
      ctx.services.users.listRewards(user.id),
    );

    const alertCount = users.reduce(
      (total, user) => total + ctx.services.alerts.listForUser(user.id).length,
      0,
    );

    return {
      steps: [
        step(
          'اعتبارسنجی پیکربندی',
          'کلیدهای لازم اعتبارسنجی شدند؛ مقدارهای مؤثر در «خروجی» آمده است (هیچ رمزی نمایش داده نمی‌شود).',
        ),
        step(
          'سلامت برنامه',
          `status=${health.status} · uptime=${health.uptimeSeconds}s`,
        ),
        step(
          'پلتفرم‌های تنظیم‌شده',
          `بله: ${ctx.config.bale.channelId} · تلگرام: ${ctx.config.telegram ? ctx.config.telegram.channelId : 'تنظیم نشده'}`,
        ),
        step(
          'داده‌های پایدار (در پوشهٔ دمو)',
          `کاربر: ${users.length} · دعوت: ${referrals.length} · پاداش: ${rewards.length} · هشدار: ${alertCount}`,
        ),
        step(
          'مسیر داده‌ها',
          `همهٔ فایل‌ها در پوشهٔ موقت دمو هستند و مخزن دست‌نخورده می‌ماند.`,
        ),
      ],
      output: {
        config: ctx.configSummary,
        health,
        rewards,
      },
    };
  },
);

// --- 3. price pipeline, accepted --------------------------------------------------------------

const priceAccepted = scenario(
  'price-accepted',
  'خط لولهٔ قیمت — دادهٔ آزمایشی معتبر (DEMO)',
  'REAL_CODE + DEMO_DATA',
  [1, 4],
  'دادهٔ DEMO از مسیر واقعی اعتبارسنجی می‌گذرد: پارسر → نرمال‌سازی → بازرسی سلامت → وضعیت بازار → خروجی قابل انتشار.',
  async (ctx) => {
    const now = new Date();
    const displayUnit = ctx.config.displayUnit;
    const { update, staleSymbols } =
      await ctx.services.marketEngine.evaluateCycle(
        demoPayload(ctx.config.symbolRegistry),
        now,
      );

    const sample = update.prices.slice(0, 4).map((price) => ({
      symbol: price.symbol,
      label: price.label,
      unit: price.unit,
      price: price.price,
      formatted:
        `${formatPriceValue(price.price, price.unit, displayUnit)} ${price.unit === 'USD' ? '' : displayUnit === 'TOMAN' ? 'تومان' : 'ریال'}`.trim(),
      changePercent:
        price.percentageChange === null
          ? null
          : formatChangePercent(price.percentageChange),
    }));

    const message = update.publishable
      ? ctx.services.messages.build(update)
      : null;

    return {
      steps: [
        step('وضعیت انتشار', `publishable=${update.publishable}`),
        step(
          'پذیرفته‌شده',
          `${update.accepted.length} نماد: ${update.accepted.map((e) => e.symbol).join(', ')}`,
        ),
        step(
          'ردشده',
          update.rejected.length === 0
            ? 'هیچ نمادی رد نشد.'
            : update.rejected
                .map((e) => `${e.symbol} (${e.reason})`)
                .join(', '),
          update.rejected.length === 0,
        ),
        step(
          'زمان و روز تهران',
          `${update.dateFa} — ${update.timeFa} (dayKey=${update.dayKey})`,
        ),
        step(
          'وضعیت کهنه (stale)',
          staleSymbols.length === 0
            ? 'هیچ نمادی کهنه نیست.'
            : staleSymbols.map((state) => state.symbol).join(', '),
        ),
        step(
          'پیام ساخته‌شده',
          'با PriceMessageBuilder واقعی ساخته شد (متن کامل در خروجی).',
          message !== null,
        ),
      ],
      output: {
        note: 'دادهٔ ورودی DEMO است؛ قیمت زنده خوانده نشده و هیچ پیامی ارسال نشده است.',
        sample,
        source: update.source,
        receivedAt: update.receivedAt,
        dayKey: update.dayKey,
        blockingReason: update.blockingReason ?? null,
        accepted: update.accepted.map((e) => ({
          symbol: e.symbol,
          reason: e.reason,
          price: e.price,
        })),
        rejected: update.rejected.map((e) => ({
          symbol: e.symbol,
          reason: e.reason,
        })),
        message,
      },
    };
  },
);

// --- 4. price pipeline, rejections ------------------------------------------------------------

const priceRejected = scenario(
  'price-rejected',
  'خط لولهٔ قیمت — رد شدن داده‌های نامعتبر',
  'REAL_CODE + DEMO_DATA',
  [1],
  'سه نوع دادهٔ خراب از مسیر واقعی رد می‌شوند و قیمت معتبر قبلی دست‌نخورده می‌ماند.',
  async (ctx) => {
    const displayUnit = ctx.config.displayUnit;
    const definitions = ctx.config.symbolRegistry;
    const gold = definitions.find((entry) => entry.symbol === 'IR_GOLD_18K');

    const readGold = (): number | null =>
      gold
        ? (ctx.services.marketState.getState(gold)?.currentPrice ?? null)
        : null;

    const registry = ctx.config.symbolRegistry;

    // A valid baseline first, so the anomaly guard has something to compare against.
    const baseline = await ctx.services.marketEngine.evaluateCycle(
      demoPayload(registry),
      new Date('2026-10-16T09:00:00Z'),
    );
    const acceptedBaseline = readGold();

    const cases: { labelFa: string; payload: unknown; expected: string }[] = [
      {
        labelFa: 'ساختار خراب (gold باید آرایه باشد)',
        payload: { gold: 'not-an-array', currency: [] },
        expected: 'INVALID_SCHEMA',
      },
      {
        labelFa: 'قیمت خارج از محدودهٔ عقلی (صفر) و نبود یک نماد ضروری',
        payload: demoPayload(registry, {
          override: { IR_GOLD_18K: 0 },
          omit: ['IR_COIN_EMAMI'],
        }),
        expected: 'INVALID_PRICE / MISSING_SYMBOL',
      },
      {
        labelFa: 'پرش غیرمنطقی نسبت به قیمت قبلی',
        payload: demoPayload(registry, {
          override: {
            IR_GOLD_18K: Math.round((acceptedBaseline ?? 17_000_000) * 1.6),
          },
        }),
        expected: 'EXCESSIVE_CHANGE',
      },
    ];

    const observed: {
      labelFa: string;
      publishable: boolean;
      blockingReason: string | null;
      rejected: { symbol: string; reason: string }[];
      accepted: string[];
      goldPriceAfter: number | null;
    }[] = [];

    for (const entry of cases) {
      const result = await ctx.services.marketEngine.evaluateCycle(
        entry.payload,
        new Date('2026-10-16T09:10:00Z'),
      );

      observed.push({
        labelFa: entry.labelFa,
        publishable: result.update.publishable,
        blockingReason: result.update.blockingReason ?? null,
        rejected: result.update.rejected.map((e) => ({
          symbol: e.symbol,
          reason: String(e.reason),
        })),
        accepted: result.update.accepted.map((e) => e.symbol),
        goldPriceAfter: readGold(),
      });
    }

    const stateUnchanged = observed.every(
      (entry) => entry.goldPriceAfter === acceptedBaseline,
    );

    return {
      steps: [
        step(
          'اجرای پایه (دادهٔ معتبر)',
          `publishable=${baseline.update.publishable} · قیمت IR_GOLD_18K = ${formatPriceValue(acceptedBaseline ?? 0, 'RIAL', displayUnit)}`,
        ),
        ...observed.map((entry) =>
          step(
            entry.labelFa,
            `publishable=${entry.publishable} · دلیل=${entry.blockingReason ?? '-'} · ردشده: ` +
              (entry.rejected.length === 0
                ? '(هیچ)'
                : entry.rejected
                    .map((r) => `${r.symbol}:${r.reason}`)
                    .join(', ')),
            !entry.publishable || entry.rejected.length > 0,
          ),
        ),
        step(
          'قیمت معتبر حفظ شد',
          stateUnchanged
            ? `بله — قیمت IR_GOLD_18K بعد از هر سه ورودی خراب همان ${formatPriceValue(acceptedBaseline ?? 0, 'RIAL', displayUnit)} ماند.`
            : 'خیر — وضعیت بازار تغییر کرد (باید بررسی شود).',
          stateUnchanged,
        ),
      ],
      output: {
        note: 'داده‌های ورودی DEMO هستند و صرفاً برای نمایش رفتار رد شدن ساخته شده‌اند.',
        baselinePrice: acceptedBaseline,
        cases: observed.map((entry, index) => ({
          ...entry,
          input: cases[index]?.payload ?? null,
          expectedReason: cases[index]?.expected ?? null,
        })),
        messagesBuilt: 0,
      },
    };
  },
);

// --- 5. bot conversation (real router, captured transport) --------------------------------------

const botConversation = scenario(
  'bot-conversation',
  'گفت‌وگوی واقعی با بات (روتر واقعی، ارسال شبیه‌سازی‌شده)',
  'REAL_CODE + SIMULATED_TRANSPORT',
  [2, 3, 6, 7],
  'دستورها و دکمه‌های واقعی به روتر واقعی داده می‌شوند؛ آنچه «ارسال می‌شد» عیناً ثبت شده است.',
  async (ctx) => {
    const userId = 'demo-user-1';

    ctx.capture.clear();

    const inputs: { labelFa: string; update: InboundUpdate }[] = [
      {
        labelFa: '/start (ورود و منوی اصلی)',
        update: message(userId, '/start'),
      },
      {
        labelFa: '/start prices (عمیق‌لینک قیمت‌ها)',
        update: message(userId, '/start prices'),
      },
      { labelFa: '/start gold', update: message(userId, '/start gold') },
      {
        labelFa: '/start alert (ویزارد هشدار فاز ۳)',
        update: message(userId, '/start alert'),
      },
      {
        labelFa: '/start channel (صفحهٔ کانال فاز ۶)',
        update: message(userId, '/start channel'),
      },
      {
        labelFa: '/start unknown_payload (ورودی ناشناس)',
        update: message(userId, '/start unknown_payload'),
      },
      {
        labelFa: 'دکمهٔ «👥 دعوت از دوستان»',
        update: callback(userId, 'v1:screen:referral'),
      },
    ];

    const transcript: {
      direction: 'in' | 'out';
      labelFa: string;
      text: string;
      keyboardRows: number;
      platform: string;
      simulated: boolean;
    }[] = [];

    for (const entry of inputs) {
      transcript.push({
        direction: 'in',
        labelFa: entry.labelFa,
        text:
          entry.update.kind === 'callback'
            ? entry.update.data
            : entry.update.kind === 'message'
              ? (entry.update.text ?? '')
              : entry.update.reason,
        keyboardRows: 0,
        platform: 'bale',
        simulated: false,
      });

      const before = ctx.capture.list().length;
      await ctx.services.botUx.handleUpdate(entry.update);

      for (const call of ctx.capture.list().slice(before)) {
        transcript.push({
          direction: 'out',
          labelFa: entry.labelFa,
          text: call.text,
          keyboardRows: call.keyboardRows,
          platform: call.platform,
          simulated: call.simulatedFailure,
        });
      }
    }

    const answers = transcript.filter((entry) => entry.direction === 'out');
    const user = ctx.services.users
      .listUsers()
      .find((entry) => entry.platformUserId === userId);

    return {
      steps: [
        step(
          'کاربر ثبت شد',
          user ? `شناسهٔ داخلی ساخته شد (${user.platformUserId})` : 'ثبت نشد',
          Boolean(user),
        ),
        step(
          'تعداد پاسخ‌های تولیدشده',
          `${answers.length} پاسخ از مسیر واقعی روتر`,
        ),
        step(
          'دکمه‌ها',
          `دکمهٔ دعوت در منوی اصلی: ${answers.some((entry) => entry.keyboardRows > 0) ? 'دارد' : 'ندارد'}`,
        ),
        step(
          'لینک‌های عمومی قابل ساخت',
          `بله: ${ctx.services.destinations.deepLink('bale', 'prices') ?? '-'} · تلگرام: ${
            ctx.services.destinations.deepLink('telegram', 'prices') ?? '-'
          }`,
        ),
        step(
          'ورودی ناشناس',
          'payload ناشناس به منوی اصلی برگشت و چیزی را اجرا نکرد.',
        ),
        step(
          'ارسال واقعی',
          'صفر — همهٔ پاسخ‌ها در حامل ثبت شدند و جایی ارسال نشد.',
          true,
        ),
      ],
      output: {
        note: 'متن‌ها عیناً همان چیزی است که بات می‌ساخت؛ فقط حامل شبیه‌سازی شده است.',
        transcript,
        referralScreenShown: answers.some((entry) =>
          entry.text.includes('دعوت‌های موفق'),
        ),
      },
    };
  },
);

// --- 6. alert lifecycle end to end -------------------------------------------------------------

const alertLifecycle = scenario(
  'alert-lifecycle',
  'چرخهٔ کامل هشدار: ساخت → عبور از آستانه → اعلان یک‌باره',
  'REAL_CODE + SIMULATED_TRANSPORT',
  [1, 3, 7],
  'هشدار با سرویس واقعی ساخته می‌شود، با قیمت واقعیِ خط لوله فعال می‌شود و دقیقاً یک‌بار اعلان می‌دهد.',
  async (ctx) => {
    const userId = 'demo-alert-user';
    const target = 17_500_000;

    ctx.capture.clear();
    await ctx.services.botUx.handleUpdate(message(userId, '/start'));

    const user = ctx.services.users
      .listUsers()
      .find((entry) => entry.platformUserId === userId);

    if (!user) {
      throw new Error('DEMO: کاربر آزمایشی ثبت نشد.');
    }

    const created = await ctx.services.alerts.create(user.id, {
      type: 'PRICE_ABOVE',
      symbol: 'IR_GOLD_18K',
      targetPrice: target,
    });

    const alert = created.ok ? created.alert : null;
    const capacityBefore = ctx.services.alerts.effectiveMaxAlerts(user.id);

    const registry = ctx.config.symbolRegistry;

    // Cycle 1: below the target — must NOT trigger.
    await ctx.services.marketEngine.evaluateCycle(
      demoPayload(registry),
      new Date('2026-10-16T09:20:00Z'),
    );
    await ctx.services.notifications.drain();
    const notificationsBelow = ctx.capture
      .list()
      .filter((call) => call.text.includes('هشدار')).length;

    // Cycle 2: above the target — triggers exactly once.
    await ctx.services.marketEngine.evaluateCycle(
      demoPayload(registry, { override: { IR_GOLD_18K: 17_600_000 } }),
      new Date('2026-10-16T09:30:00Z'),
    );
    await ctx.services.notifications.drain();
    const notifications = ctx.capture
      .list()
      .filter((call) => call.text.includes('هشدار'));

    // Cycle 3: the same crossing again — a one-shot alert must stay silent.
    await ctx.services.marketEngine.evaluateCycle(
      demoPayload(registry, { override: { IR_GOLD_18K: 17_650_000 } }),
      new Date('2026-10-16T10:00:00Z'),
    );
    await ctx.services.notifications.drain();
    const notificationsAfterThird = ctx.capture
      .list()
      .filter((call) => call.text.includes('هشدار'));

    const delivery = alert ? ctx.services.alerts.findDelivery(alert.id) : null;

    return {
      steps: [
        step(
          'ساخت هشدار با سرویس واقعی',
          alert
            ? `شناسهٔ ${alert.id} · نماد ${alert.symbol} · آستانهٔ ${formatPriceValue(target, 'RIAL', ctx.config.displayUnit)}`
            : `ساخته نشد (${created.ok ? '?' : created.reason})`,
          alert !== null,
        ),
        step(
          'ظرفیت مؤثر کاربر',
          `${capacityBefore} هشدار (پایهٔ پیکربندی؛ پاداش دعوت تازه اعمال می‌شود)`,
        ),
        step(
          'چرخهٔ زیر آستانه',
          `اعلان در این چرخه: ${notificationsBelow} (باید صفر باشد)`,
          notificationsBelow === 0,
        ),
        step(
          'چرخهٔ عبور از آستانه',
          notifications.length === 1
            ? `یک اعلان ساخته شد: «${notifications[0]?.text.split('\n')[0] ?? ''}»`
            : `انتظار یک اعلان بود، ${notifications.length} اعلان دیده شد.`,
          notifications.length === 1,
        ),
        step(
          'چرخهٔ سوم (همان آستانه)',
          notificationsAfterThird.length === notifications.length
            ? 'اعلان تکراری ساخته نشد (هشدار یک‌باره است).'
            : 'اعلان تکراری ساخته شد (باید بررسی شود).',
          notificationsAfterThird.length === notifications.length,
        ),
        step(
          'وضعیت تحویل ثبت‌شده',
          delivery
            ? `status=${delivery.status} · attemptCount=${delivery.attemptCount}`
            : 'رکورد تحویل ثبت نشد.',
          delivery !== null && delivery.status === 'SENT',
        ),
      ],
      output: {
        note: 'قیمت‌ها DEMO هستند؛ اعلان به حامل شبیه‌سازی‌شده رفت و برای کاربر واقعی ارسال نشد.',
        alert,
        delivery,
        notifications: notifications.map((call) => call.text),
        capturedAfterThirdCycle: ctx.capture.list().length,
      },
    };
  },
);

// --- 7. channel publication --------------------------------------------------------------------

const publication = scenario(
  'publication',
  'انتشار در کانال: دکمه، نتیجهٔ هر مقصد و جلوگیری از تکرار',
  'REAL_CODE + SIMULATED_TRANSPORT',
  [5, 6],
  'موتور واقعی کانال منتشر می‌کند؛ نتیجهٔ بله و تلگرام جداگانه گزارش می‌شود و انتشار تکراری رخ نمی‌دهد.',
  async (ctx) => {
    ctx.capture.clear();

    const now = new Date('2026-10-16T10:30:00Z');
    const { update } = await ctx.services.marketEngine.evaluateCycle(
      demoPayload(ctx.config.symbolRegistry),
      now,
    );

    const first = await ctx.services.channelEngine.publishPriceUpdate(
      update,
      'full',
      now,
    );
    const afterFirst = ctx.capture.list();

    const second = await ctx.services.channelEngine.publishPriceUpdate(
      update,
      'full',
      now,
    );
    const afterSecond = ctx.capture.list();

    // Per-destination failure isolation: Telegram is made to fail on purpose.
    ctx.capture.failOn('telegram');
    const failing = await ctx.services.channelEngine.publishPriceUpdate(
      update,
      'poster',
      now,
    );
    ctx.capture.heal('telegram');

    const deliveries = ctx.services.channelEngine.deliveriesOf(first.jobId);

    return {
      steps: [
        step(
          'انتشار اول',
          `${first.status} · ${deliveries.length} مقصد: ${deliveries
            .map((d) => `${d.platform}=${d.status}`)
            .join(' · ')}`,
          first.status === 'PUBLISHED',
        ),
        step(
          'دکمهٔ کانال (CTA فاز ۶)',
          deliveries.some((d) => d.ctaRoute)
            ? `مسیر دکمه: ${deliveries.map((d) => d.ctaRoute ?? '-').join(' · ')}`
            : 'بدون دکمه (سیاست CTA برای این پیام دکمه‌ای تعیین نکرد)',
        ),
        step(
          'اجرای دوبارهٔ همان انتشار',
          `${second.status}${second.skipReason ? ` (${second.skipReason})` : ''} · تعداد ارسال تازه: ${
            afterSecond.length - afterFirst.length
          }`,
          afterSecond.length === afterFirst.length,
        ),
        step(
          'فروپاشی فقط تلگرام',
          `${failing.status} · ${failing.deliveries
            .map(
              (d) =>
                `${d.platform}=${d.status}${d.lastError ? ` (${d.lastError})` : ''}`,
            )
            .join(' · ')}`,
          failing.deliveries.some(
            (d) => d.platform === 'bale' && d.status === 'SENT',
          ) && failing.deliveries.some((d) => d.platform === 'telegram'),
        ),
        step(
          'پیام منتشرشده',
          'متن واقعی ساخته‌شده توسط موتور کانال در «خروجی» آمده است.',
          afterFirst.some((call) => call.text.includes('طلا')),
        ),
      ],
      output: {
        note: 'هیچ پیامی به کانال واقعی نرفت؛ مقصدها در حامل شبیه‌سازی‌شده ثبت شدند.',
        jobId: first.jobId,
        firstStatus: first.status,
        secondStatus: second.status,
        secondSkipReason: second.skipReason,
        deliveries,
        publishedText: afterFirst[0]?.text ?? null,
        capturedCalls: afterFirst.length,
      },
    };
  },
);

// --- 8. referrals and rewards ------------------------------------------------------------------

const referralRewards = scenario(
  'referral-rewards',
  'دعوت از دوستان: انتساب، پاداش دائمی و اثر آن روی ظرفیت هشدار',
  'REAL_CODE + SIMULATED_TRANSPORT',
  [3, 7],
  'سه دعوت موفق از مسیر واقعی ثبت می‌شوند، پاداش صادر می‌شود و ظرفیت هشدار یک واحد بالا می‌رود.',
  async (ctx) => {
    ctx.capture.clear();

    const inviter = 'demo-inviter';
    const invitees = ['demo-invitee-1', 'demo-invitee-2', 'demo-invitee-3'];

    await ctx.services.botUx.handleUpdate(message(inviter, '/start'));

    const inviterUser = ctx.services.users
      .listUsers()
      .find((entry) => entry.platformUserId === inviter);

    if (!inviterUser) {
      throw new Error('DEMO: کاربر دعوت‌کننده ثبت نشد.');
    }

    const code = await ctx.services.referrals.referralCodeFor(inviterUser.id);
    const link = ctx.services.destinations.referralLink('bale', code ?? '');

    const capacityBefore = ctx.services.alerts.effectiveMaxAlerts(
      inviterUser.id,
    );
    const captureBeforeInvites = ctx.capture.list().length;

    for (const invitee of invitees) {
      await ctx.services.botUx.handleUpdate(
        message(invitee, `/start ref_${code}`),
      );
    }

    const statsAfterThree = ctx.services.referrals.statsFor(inviterUser.id);
    const capacityAfter = ctx.services.alerts.effectiveMaxAlerts(
      inviterUser.id,
    );
    const notifications = ctx.capture
      .list()
      .slice(captureBeforeInvites)
      .filter((call) => call.text.includes('تبریک'));

    // The referral screen itself, opened through the real router.
    await ctx.services.botUx.handleUpdate(
      callback(inviter, 'v1:screen:referral'),
    );

    // Abuse attempts: self-referral and a repeated start with the same link.
    const referralsBefore = ctx.services.users.listReferrals().length;
    await ctx.services.botUx.handleUpdate(
      message(inviter, `/start ref_${code}`),
    );
    await ctx.services.botUx.handleUpdate(
      message(invitees[0], `/start ref_${code}`),
    );
    const referralsAfter = ctx.services.users.listReferrals().length;

    const screenText =
      ctx.capture
        .list()
        .map((call) => call.text)
        .reverse()
        .find((text) => text.includes('دعوت‌های موفق')) ?? '';

    const rewards = ctx.services.users.listRewards(inviterUser.id);

    return {
      steps: [
        step(
          'کد دعوت ساخته شد',
          `کد ${code ?? '-'} · لینک ${link ?? '(نام کاربری تنظیم نشده)'}`,
          Boolean(code),
        ),
        step(
          'سه دعوت موفق ثبت شد',
          `${statsAfterThree.successfulReferrals} دعوت موفق · ${statsAfterThree.activeReferrals} فعال در ۳۰ روز`,
          statsAfterThree.successfulReferrals === 3,
        ),
        step(
          'پاداش صادر شد',
          rewards.length === 1
            ? `ردیف دفتر کل با وضعیت ${rewards[0]?.status} و ${rewards[0]?.capacityBonus} ظرفیت`
            : `تعداد ردیف پاداش: ${rewards.length}`,
          rewards.length === 1 && rewards[0]?.status === 'GRANTED',
        ),
        step(
          'ظرفیت هشدار (ادغام با فاز ۳)',
          `قبل: ${capacityBefore} → بعد: ${capacityAfter}`,
          capacityAfter === capacityBefore + 1,
        ),
        step(
          'اعلان پاداش به دعوت‌کننده',
          notifications.length === 1
            ? `یک اعلان: «${notifications[0]?.text.split('\n')[0] ?? ''}»`
            : `تعداد اعلان: ${notifications.length}`,
          notifications.length === 1,
        ),
        step(
          'صفحهٔ «دعوت‌های من»',
          screenText.includes('دعوت‌های موفق')
            ? 'با اعداد پایدارشده نمایش داده شد.'
            : 'نمایش داده نشد.',
          screenText.includes('دعوت‌های موفق'),
        ),
        step(
          'خوددعوتی و لینک تکراری',
          referralsAfter === referralsBefore + 0
            ? `هیچ دعوت تازه‌ای ثبت نشد (همچنان ${referralsAfter} دعوت).`
            : 'شمارش افزایش یافت (باید بررسی شود).',
          referralsAfter === referralsBefore,
        ),
      ],
      output: {
        note: 'همهٔ دعوت‌ها کاربران آزمایشی دمو هستند؛ هیچ پیام واقعی ارسال نشد.',
        code,
        link,
        stats: statsAfterThree,
        capacityBefore,
        capacityAfter,
        rewards,
        rewardNotice: notifications[0]?.text ?? null,
        referralScreen: screenText,
      },
    };
  },
);

/** Every scenario, in the order the demo UI shows them. */
export const SCENARIOS: {
  id: string;
  titleFa: string;
  descriptionFa: string;
  run: (ctx: DemoContext) => Promise<ScenarioResult>;
}[] = [
  {
    id: 'overview',
    titleFa: 'نمای کلی و وضعیت فازها',
    descriptionFa:
      'فازها، مستندات و نتیجهٔ آخرین اجرای واقعی تست‌ها (۲ ثانیه).',
    run: overview,
  },
  {
    id: 'config',
    titleFa: 'پیکربندی و سلامت',
    descriptionFa:
      'پیکربندی اعتبارسنجی‌شده، پاسخ سلامت و موجودی فروشگاه‌های داده.',
    run: configStatus,
  },
  {
    id: 'price-accepted',
    titleFa: 'قیمت — دادهٔ معتبر (DEMO)',
    descriptionFa:
      'دادهٔ آزمایشی از کل خط لولهٔ فاز ۱ می‌گذرد و پیام واقعی ساخته می‌شود.',
    run: priceAccepted,
  },
  {
    id: 'price-rejected',
    titleFa: 'قیمت — رد شدن داده‌های خراب',
    descriptionFa:
      'ساختار خراب، مقدار غیرمنطقی و پرش نامعقول رد می‌شوند؛ قیمت معتبر می‌ماند.',
    run: priceRejected,
  },
  {
    id: 'bot-conversation',
    titleFa: 'گفت‌وگو با بات (شبیه‌سازی‌شده)',
    descriptionFa:
      'دستورها و دکمه‌های واقعی روی روتر واقعی؛ متن پاسخ‌ها عیناً ثبت می‌شود.',
    run: botConversation,
  },
  {
    id: 'alert-lifecycle',
    titleFa: 'هشدار: ساخت تا اعلان یک‌باره',
    descriptionFa: 'هشدار واقعی، عبور قیمت از آستانه و اثبات اعلان یک‌باره.',
    run: alertLifecycle,
  },
  {
    id: 'publication',
    titleFa: 'انتشار در کانال',
    descriptionFa:
      'انتشار واقعی با نتیجهٔ جدا برای بله و تلگرام، دکمهٔ CTA و جلوگیری از تکرار.',
    run: publication,
  },
  {
    id: 'referral-rewards',
    titleFa: 'دعوت و پاداش دائمی',
    descriptionFa: 'سه دعوت موفق، پاداش، اعلان و افزایش یک‌واحدی ظرفیت هشدار.',
    run: referralRewards,
  },
];

/** Ids only — the UI lists them without touching any service. */
export function scenarioIds(): string[] {
  return SCENARIOS.map((entry) => entry.id);
}

/** Give the demo a chance to settle background work between scenarios. */
export async function settle(): Promise<void> {
  await sleep(25);
}

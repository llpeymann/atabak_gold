/**
 * Demo harness — entry point.
 *
 *   npm run demo              # dashboard on http://0.0.0.0:3210 (DEMO_PORT to change)
 *   npm run demo -- --run all # every scenario, printed as JSON (CI/audit friendly)
 *   npm run demo -- --run referral-rewards
 *   npm run demo -- --list
 *
 * The demo is a development tool: it boots the real application context with the transport
 * replaced by a capturing double (see `demo-transport.ts`) and never sends anything anywhere.
 */

import { DEMO_DATA_DIR, DEMO_PORT } from './demo-boot';
import { DemoRunner } from './demo.runner';
import { startDemoServer } from './demo.server';
import type { DemoRunSummary } from './demo.types';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);

  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function printRun(run: DemoRunSummary): void {
  const { result } = run;

  console.log(
    `\n=== ${result.id} — ${result.titleFa} [${result.status}] (${result.durationMs} ms)`,
  );
  console.log(`نوع: ${result.kind} · فازها: ${result.phases.join(', ')}`);
  console.log(result.error ? `خطا: ${result.error}` : result.summaryFa);

  for (const step of result.steps) {
    console.log(`${step.ok ? '  ✔' : '  ✘'} ${step.labelFa}: ${step.detail}`);
  }

  if (run.capture.length > 0) {
    console.log(
      `  ↳ ${run.capture.length} ارسال شبیه‌سازی‌شده (هیچ‌کدام واقعی نیست).`,
    );
  }
}

async function main(): Promise<void> {
  const runner = new DemoRunner();

  if (process.argv.includes('--list')) {
    for (const scenario of runner.list()) {
      console.log(
        `${scenario.id.padEnd(20)} ${scenario.titleFa} — ${scenario.descriptionFa}`,
      );
    }
    return;
  }

  const requested = argument('--run');

  if (requested) {
    const summaries =
      requested === 'all'
        ? await runner.runAll()
        : [await runner.run(requested)];

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(summaries, null, 2));
    } else {
      summaries.forEach(printRun);

      const failed = summaries.filter(
        (entry) => entry.result.status !== 'PASS',
      );

      console.log(
        `\nخلاصه: ${summaries.length - failed.length}/${summaries.length} سناریو PASS` +
          (failed.length > 0
            ? ` — ناموفق: ${failed.map((entry) => entry.result.id).join(', ')}`
            : ''),
      );
    }

    await runner.dispose();
    process.exitCode = summaries.some((entry) => entry.result.status !== 'PASS')
      ? 1
      : 0;

    return;
  }

  const server = await startDemoServer(DEMO_PORT);

  console.log('🌱 دمو طلای اتابک — فازهای ۱ تا ۷');
  console.log(`   آدرس:      http://0.0.0.0:${server.port}`);
  console.log(`   داده‌ها در: ${DEMO_DATA_DIR}`);
  console.log(
    '   حالت: ارسال واقعی و دریافت قیمت زنده غیرفعال است (شبیه‌سازی + دادهٔ DEMO).',
  );
  console.log('   توقف: Ctrl+C');

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error('Demo failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

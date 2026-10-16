/**
 * Demo harness — HTTP surface.
 *
 * A tiny `node:http` server (no new dependency, no framework) that serves one self-contained HTML
 * page and a handful of JSON endpoints. The page has no external assets, so it also works behind
 * sandboxed previews with no network access.
 *
 * Endpoints
 *   GET  /                → the dashboard (HTML)
 *   GET  /api/scenarios   → scenario list
 *   POST /api/run         → { "id": "<scenario>" } → result + captured calls
 *   POST /api/run-all     → every scenario, in order
 *   POST /api/reset       → dispose the context and wipe the scratch directory
 *   GET  /api/capture     → the calls captured in the last run
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { DEMO_DATA_DIR, DEMO_PORT } from './demo-boot';
import { DemoRunner } from './demo.runner';
import type { DemoRunSummary } from './demo.types';

const runner = new DemoRunner();

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

let lastRun: DemoRunSummary | null = null;

async function route(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? '/';

  if (path === '/api/scenarios') {
    json(res, 200, { scenarios: runner.list(), dataDir: DEMO_DATA_DIR });
    return true;
  }

  if (path === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const id = typeof body.id === 'string' ? body.id : '';

    try {
      lastRun = await runner.run(id);
      json(res, 200, lastRun);
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  }

  if (path === '/api/run-all' && req.method === 'POST') {
    try {
      const runs = await runner.runAll();
      lastRun = runs[runs.length - 1] ?? null;
      json(res, 200, { runs });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  }

  if (path === '/api/reset' && req.method === 'POST') {
    await runner.reset();
    lastRun = null;
    json(res, 200, { ok: true, dataDir: DEMO_DATA_DIR });
    return true;
  }

  if (path === '/api/capture') {
    json(res, 200, { capture: lastRun?.capture ?? [] });
    return true;
  }

  return false;
}

/** The dashboard: one self-contained page, no external resources. */
const PAGE = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>دمو طلای اتابک — فازهای ۱ تا ۷</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Tahoma, Vazirmatn, system-ui, sans-serif; background: #f4f6f9; color: #10192c; }
  header { background: linear-gradient(135deg,#1b2a4a,#2f4a7d); color: #fff; padding: 18px 22px; }
  header h1 { margin: 0 0 6px; font-size: 20px; }
  header p { margin: 0; font-size: 13px; opacity: .9; line-height: 1.7; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 18px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .card { background: #fff; border: 1px solid #dde3ec; border-radius: 12px; padding: 14px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; }
  .card p { margin: 0 0 10px; font-size: 12px; color: #55617a; line-height: 1.7; }
  button { font-family: inherit; cursor: pointer; border: 0; border-radius: 8px; padding: 8px 12px; font-size: 13px; background: #2f4a7d; color: #fff; }
  button.ghost { background: #e8edf6; color: #22314f; }
  button:disabled { opacity: .55; cursor: progress; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2f8; color: #33415c; }
  .pass { background: #e7f6ec; color: #12633a; }
  .fail { background: #fdeaea; color: #8c1c1c; }
  h2 { font-size: 16px; margin: 22px 0 10px; }
  .step { border-right: 3px solid #cfd8e6; padding: 8px 10px; margin-bottom: 8px; background: #fff; border-radius: 0 8px 8px 0; }
  .step.ok { border-color: #2f9e63; }
  .step.bad { border-color: #cc4b4b; }
  .step .l { font-size: 13px; font-weight: bold; }
  .step .d { font-size: 12px; color: #4b5768; white-space: pre-wrap; line-height: 1.8; }
  pre { background: #0f1b2d; color: #d7e3f4; padding: 12px; border-radius: 10px; overflow: auto; font-size: 12px; direction: ltr; text-align: left; max-height: 420px; }
  .note { background: #fff7e6; border: 1px solid #f0d9a8; padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 1.8; }
  .bubble { border-radius: 10px; padding: 8px 10px; margin: 6px 0; font-size: 12px; white-space: pre-wrap; line-height: 1.8; }
  .bubble.in { background: #e8edf6; }
  .bubble.out { background: #e7f6ec; }
  .muted { color: #6b7688; font-size: 11px; }
  footer { text-align: center; color: #6b7688; font-size: 11px; padding: 18px; }
</style>
</head>
<body>
<header>
  <h1>🌱 دمو واقعی طلای اتابک — فازهای ۱ تا ۷</h1>
  <p>
    هر سناریو کد <b>واقعی پروژه</b> را اجرا می‌کند: خط لولهٔ قیمت، موتور هشدار، روتر بات، موتور کانال و موتور دعوت/پاداش.
    ارسال به بیرون و دریافت قیمت زنده <b>غیرفعال</b> است؛ حامل پیام شبیه‌سازی و دادهٔ قیمت با برچسب DEMO است.
  </p>
</header>
<div class="wrap">
  <div class="row">
    <button id="runAll" class="ghost">اجرای همهٔ سناریوها</button>
    <button id="reset" class="ghost">پاک‌سازی و شروع تازه</button>
    <span id="status" class="muted">آماده</span>
  </div>
  <h2>سناریوها</h2>
  <div class="grid" id="grid"></div>
  <h2>نتیجه</h2>
  <div id="result"><div class="note">یک سناریو را اجرا کن. هر اجرا از حالت تازه شروع می‌شود تا نتیجه تکرارپذیر باشد.</div></div>
</div>
<footer>Atabak Gold · Demo harness خارج از مسیر تولید · داده و ارسال‌ها شبیه‌سازی‌شده‌اند</footer>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const grid = document.getElementById('grid');
const result = document.getElementById('result');
const status = document.getElementById('status');

let scenarios = [];

function card(s) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = '<h3>' + esc(s.titleFa) + '</h3><p>' + esc(s.descriptionFa) + '</p>'
    + '<button data-id="' + esc(s.id) + '">اجرا</button>';
  el.querySelector('button').addEventListener('click', () => run(s.id, el.querySelector('button')));
  return el;
}

async function load() {
  const res = await fetch('api/scenarios');
  const data = await res.json();
  scenarios = data.scenarios;
  grid.innerHTML = '';
  scenarios.forEach((s) => grid.appendChild(card(s)));
  status.textContent = 'پوشهٔ داده‌های دمو: ' + data.dataDir;
}

async function run(id, button) {
  button.disabled = true;
  status.textContent = 'در حال اجرا…';
  result.innerHTML = '<div class="note">در حال اجرا…</div>';

  try {
    const res = await fetch('api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    render(data);
  } catch (error) {
    result.innerHTML = '<div class="note">خطا در اجرا: ' + esc(error) + '</div>';
  } finally {
    button.disabled = false;
    status.textContent = 'آماده';
  }
}

function render(run) {
  const r = run.result;
  const badge = r.status === 'PASS' ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>';
  let html = '<div class="card"><h3>' + esc(r.titleFa) + ' ' + badge + '</h3>'
    + '<div class="row"><span class="badge">' + esc(r.kind) + '</span>'
    + '<span class="badge">فازها: ' + esc((r.phases || []).join(', ')) + '</span>'
    + '<span class="badge">' + esc(r.durationMs) + ' ms</span></div>'
    + '<p class="muted">' + esc(r.summaryFa) + '</p>';

  if (r.error) { html += '<div class="note">خطا: ' + esc(r.error) + '</div>'; }

  (r.steps || []).forEach((s) => {
    html += '<div class="step ' + (s.ok ? 'ok' : 'bad') + '"><div class="l">' + esc(s.labelFa) + '</div><div class="d">' + esc(s.detail) + '</div></div>';
  });

  html += '</div>';

  const out = r.output;
  if (out && out.transcript) {
    html += '<h2>گفت‌وگو</h2><div class="card">';
    out.transcript.forEach((t) => {
      html += '<div class="bubble ' + (t.direction === 'in' ? 'in' : 'out') + '">'
        + (t.direction === 'in' ? '👤 → 🤖 ' : '🤖 → 👤 ') + esc(t.text)
        + (t.keyboardRows ? '\\n' + esc('[' + t.keyboardRows + ' ردیف دکمه]') : '') + '</div>';
    });
    html += '</div>';
  }

  if (run.capture && run.capture.length) {
    html += '<h2>ارسال‌های ثبت‌شده (شبیه‌سازی) — ' + run.capture.length + ' مورد</h2>'
      + '<div class="card"><p class="muted">این‌ها پیام‌هایی هستند که بات می‌ساخت؛ هیچ‌کدام واقعاً ارسال نشد.</p>'
      + '<pre>' + esc(run.capture.map((c) => '[' + c.platform + '] ' + c.method + ' → ' + c.chatId + '\\n' + c.text).join('\\n\\n---\\n\\n')) + '</pre></div>';
  }

  html += '<h2>خروجی ساخت‌یافته (JSON)</h2><pre>' + esc(JSON.stringify(out, null, 2)) + '</pre>';
  result.innerHTML = html;
}

document.getElementById('runAll').addEventListener('click', async (event) => {
  event.target.disabled = true;
  status.textContent = 'در حال اجرای همه…';
  try {
    const res = await fetch('api/run-all', { method: 'POST' });
    const data = await res.json();
    result.innerHTML = '<div class="card"><h3>خلاصهٔ اجرای همهٔ سناریوها</h3>'
      + data.runs.map((r) => '<div class="step ' + (r.result.status === 'PASS' ? 'ok' : 'bad') + '">'
        + '<div class="l">' + esc(r.result.titleFa) + '</div><div class="d">' + esc(r.result.status + ' — ' + r.result.durationMs + ' ms') + '</div></div>').join('')
      + '</div><pre>' + esc(JSON.stringify(data.runs.map((r) => ({ id: r.scenarioId, status: r.result.status, error: r.result.error })), null, 2)) + '</pre>';
  } catch (error) {
    result.innerHTML = '<div class="note">خطا: ' + esc(error) + '</div>';
  } finally {
    event.target.disabled = false;
    status.textContent = 'آماده';
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  await fetch('api/reset', { method: 'POST' });
  result.innerHTML = '<div class="note">پاک شد. سناریوها از حالت تازه اجرا می‌شوند.</div>';
});

load();
</script>
</body>
</html>`;

export function startDemoServer(port: number = DEMO_PORT): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (await route(req, res)) {
          return;
        }

        if ((req.url ?? '/') === '/' || (req.url ?? '').startsWith('/?')) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(PAGE);
          return;
        }

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(port, '0.0.0.0', () => {
      resolve({
        port,
        close: async (): Promise<void> => {
          await runner.dispose();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

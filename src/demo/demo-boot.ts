/**
 * Demo harness — boot-time environment (Phase E of the audit mission).
 *
 * This module is imported **first** by `demo-context.ts` so that its side effect (preparing a
 * deterministic, offline environment) runs *before* `AppModule` is evaluated and `ConfigModule`
 * reads its environment file.
 *
 * Three guarantees, all of them about safety rather than convenience:
 *
 *  1. **Nothing can reach a real platform.** The demo never relies on this alone — the transport
 *     itself is replaced by a capturing double — but the configured tokens are obviously fake and
 *     `PRICE_API_URL` points at a closed local port.
 *  2. **The repository's own `.env` is never read.** The working directory is moved to a scratch
 *     directory, so a developer's real tokens cannot silently leak into a demo run.
 *  3. **The demo never writes into the repository.** Every persisted file lives in the scratch
 *     directory (`DEMO_DATA_DIR`), so a demo run cannot corrupt production data.
 *
 * It is a *development* tool: it is not imported by `AppModule` and it is never part of the
 * production process.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** `<repo>/dist/demo` → `<repo>`. */
export const DEMO_REPO_ROOT = resolve(__dirname, '..', '..');

/** Where the demo keeps its data, logs and scratch files (override with `DEMO_DATA_DIR`). */
export const DEMO_DATA_DIR =
  process.env.DEMO_DATA_DIR && process.env.DEMO_DATA_DIR.trim() !== ''
    ? resolve(process.env.DEMO_DATA_DIR)
    : join(tmpdir(), 'atabak-demo');

/** The demo HTTP port (`DEMO_PORT`, default 3210). */
export const DEMO_PORT = Number(process.env.DEMO_PORT ?? 3210);

/** Fake tokens that are recognisable on sight; they are never sent anywhere. */
const DEMO_BALE_TOKEN = 'DEMO-BALE-TOKEN-NOT-REAL';
const DEMO_TELEGRAM_TOKEN = 'DEMO-TELEGRAM-TOKEN-NOT-REAL';

/** Public bot names used to build deep links in the demo. */
const DEMO_BALE_BOT = 'atabak_demo_bot';
const DEMO_TELEGRAM_BOT = 'atabak_demo_tg_bot';

/** The complete environment profile of a demo run — every value is deterministic. */
export function demoEnvProfile(): Record<string, string> {
  return {
    // --- surfaces -----------------------------------------------------------
    PORT: '3300',
    BALE_BOT_TOKEN: DEMO_BALE_TOKEN,
    BALE_CHANNEL_ID: '@atabak_demo_channel',
    BALE_BOT_USERNAME: DEMO_BALE_BOT,
    TELEGRAM_BOT_TOKEN: DEMO_TELEGRAM_TOKEN,
    TELEGRAM_CHANNEL_ID: '@atabak_demo_channel_tg',
    TELEGRAM_BOT_USERNAME: DEMO_TELEGRAM_BOT,
    // Kept intentionally partial-free: both platforms are configured, which is what makes the
    // per-destination delivery result visible in the publication scenario.

    // --- the external provider is *not* called in demo mode -------------------
    PRICE_API_URL: 'http://127.0.0.1:9/demo-mock-prices',

    // --- no inbound polling: the demo drives the router directly -------------
    BOT_POLLING_ENABLED: 'false',

    // --- persistence always lands in the scratch directory -------------------
    MARKET_STATE_FILE: join(DEMO_DATA_DIR, 'market-state.json'),
    USER_DATA_FILE: join(DEMO_DATA_DIR, 'users.json'),
    ALERTS_DATA_FILE: join(DEMO_DATA_DIR, 'alerts.json'),
    CHANNEL_DATA_FILE: join(DEMO_DATA_DIR, 'channel.json'),
    // Phase 10 — same rule as every other document: the admin trail (audit, incidents, activity days,
    // broadcast jobs) lives in the scratch directory and never escapes into the repository.
    ADMIN_DATA_FILE: join(DEMO_DATA_DIR, 'admin.json'),

    // --- scheduled publications stay quiet -----------------------------------
    CHANNEL_DAILY_REPORT_ENABLED: 'false',
    CHANNEL_DAILY_RANGE_ENABLED: 'false',
    CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '0',

    // --- demo tuning only (production defaults are untouched) ---------------
    // The deliberate Telegram failure below would otherwise wait 2 × 5s of production backoff.
    CHANNEL_PUBLICATION_RETRY_DELAY_MS: '300',

    // --- the features the demo shows ----------------------------------------
    CHANNEL_CTA_ENABLED: 'true',
    REFERRAL_ENABLED: 'true',
    REFERRAL_REWARDS_ENABLED: 'true',
    BALE_REFERRAL_BOT_USERNAME: DEMO_BALE_BOT,
    TELEGRAM_REFERRAL_BOT_USERNAME: DEMO_TELEGRAM_BOT,
    // A small base capacity makes "one permanent extra slot" visible in the demo.
    MAX_ALERTS_PER_USER: '3',
  };
}

/**
 * Prepare the scratch directory and move the working directory there.
 *
 * Must run before `AppModule` is imported (see the module comment). Idempotent: calling it twice
 * does not wipe data that a scenario just produced.
 */
export function prepareDemoEnvironment(): void {
  mkdirSync(DEMO_DATA_DIR, { recursive: true });

  // Moving the working directory is what keeps the repository's `.env` out of a demo run:
  // `ConfigModule` resolves its default `.env` relative to the current working directory.
  process.chdir(DEMO_DATA_DIR);

  for (const [key, value] of Object.entries(demoEnvProfile())) {
    process.env[key] = value;
  }
}

/** Delete every demo artefact so the next run starts from nothing. */
export function resetDemoData(): void {
  rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DATA_DIR, { recursive: true });
  // Wiping the directory the process is standing in leaves a dangling cwd: re-enter the recreated
  // directory so every relative path resolves again.
  process.chdir(DEMO_DATA_DIR);
}

prepareDemoEnvironment();

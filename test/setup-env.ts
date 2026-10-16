/**
 * E2E environment: the application validates its configuration during startup, so the
 * required variables are provided here before any module is imported.
 */
process.env.PRICE_API_URL =
  process.env.PRICE_API_URL ?? 'https://api.example.test/prices';
process.env.BALE_BOT_TOKEN = process.env.BALE_BOT_TOKEN ?? 'e2e-bale-token';
process.env.BALE_CHANNEL_ID = process.env.BALE_CHANNEL_ID ?? 'e2e-bale-channel';
process.env.PORT = process.env.PORT ?? '3000';

// The real application boots in e2e tests, so:
//  - inbound long-polling must never run there (it would talk to a live platform and keep the
//    process busy),
//  - user data and market state must live in a throw-away directory, never in the repository.
// These variables must be set *before* `AppModule` is imported, because `ConfigModule.forRoot`
// snapshots the environment when the module is loaded.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_POLLING_ENABLED = 'false';

if (!process.env.USER_DATA_FILE) {
  const directory = mkdtempSync(join(tmpdir(), 'atabak-e2e-'));
  process.env.ATABAK_E2E_DIR = directory;
  process.env.USER_DATA_FILE = join(directory, 'users.json');
  process.env.MARKET_STATE_FILE = join(directory, 'market-state.json');
  process.env.ALERTS_DATA_FILE = join(directory, 'alerts.json');
  // Phase 5: publication history lives in the same throw-away directory, and the admin surface is
  // enabled only for a synthetic test admin id.
  process.env.CHANNEL_DATA_FILE = join(directory, 'channel.json');
  // Phase 8: campaign data lives in the same throw-away directory, and the redirect endpoint gets a
  // synthetic public base URL so tracked links can be exercised over real HTTP.
  process.env.CAMPAIGN_DATA_FILE = join(directory, 'campaigns.json');
}

process.env.CAMPAIGN_TRACKING_BASE_URL =
  process.env.CAMPAIGN_TRACKING_BASE_URL ?? 'https://track.e2e.test';

// Phase 9: the sales engine keeps its leads in the same throw-away directory, and the customer /
// operator surfaces are enabled for a synthetic admin id so authorization can be exercised.
process.env.SALES_DATA_FILE =
  process.env.SALES_DATA_FILE ??
  join(process.env.ATABAK_E2E_DIR ?? tmpdir(), 'sales.json');
process.env.SALES_ENGINE_ENABLED = process.env.SALES_ENGINE_ENABLED ?? 'true';
process.env.SALES_ADMIN_USER_IDS =
  process.env.SALES_ADMIN_USER_IDS ?? 'bale:e2e-sales-admin';
process.env.SALES_NOTIFICATION_RETRY_DELAY_MS =
  process.env.SALES_NOTIFICATION_RETRY_DELAY_MS ?? '0';

// Phase 6: a synthetic public bot username so the channel → bot CTA path is exercised end to end.
// It is clearly a test value; the e2e suite never talks to a real platform.
process.env.BALE_BOT_USERNAME =
  process.env.BALE_BOT_USERNAME ?? 'atabak_e2e_bot';
// Phase 8: both platform usernames exist so a tracked link can be resolved for either platform
// (the “other platform is not configured” fallback is covered by the unit suite).
process.env.TELEGRAM_BOT_USERNAME =
  process.env.TELEGRAM_BOT_USERNAME ?? 'atabak_e2e_tg_bot';

// Phase 5: publication retries must not slow the suite down (their *count* is what is asserted).
process.env.CHANNEL_PUBLICATION_RETRY_DELAY_MS =
  process.env.CHANNEL_PUBLICATION_RETRY_DELAY_MS ?? '0';
process.env.CHANNEL_ADMIN_USER_IDS =
  process.env.CHANNEL_ADMIN_USER_IDS ?? 'bale:e2e-admin';

// Phase 3: notify retries must be immediate in tests (the retry *count* is what is asserted).
process.env.ALERT_NOTIFICATION_RETRY_DELAY_MS =
  process.env.ALERT_NOTIFICATION_RETRY_DELAY_MS ?? '0';

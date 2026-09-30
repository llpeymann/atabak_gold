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
}

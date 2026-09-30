/**
 * E2E environment: the application validates its configuration during startup, so the
 * required variables are provided here before any module is imported.
 */
process.env.PRICE_API_URL =
  process.env.PRICE_API_URL ?? 'https://api.example.test/prices';
process.env.BALE_BOT_TOKEN = process.env.BALE_BOT_TOKEN ?? 'e2e-bale-token';
process.env.BALE_CHANNEL_ID = process.env.BALE_CHANNEL_ID ?? 'e2e-bale-channel';
process.env.PORT = process.env.PORT ?? '3000';

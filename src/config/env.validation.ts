import { Logger } from '@nestjs/common';

import { isMoneyUnit, MoneyUnit } from '../common/money';
import {
  CTA_CHOICES,
  isMessageType,
  MESSAGE_TYPES,
} from '../channel/channel.types';

/**
 * Startup validation for environment variables.
 *
 * Registered as `ConfigModule.forRoot({ validate })`, so the application refuses to start
 * with a clear message when a required variable is missing — instead of starting fine and
 * failing later inside a cron execution.
 *
 * The returned object keeps flat string values (it is merged into the runtime config),
 * while `AppConfigService` exposes a typed view of it.
 */

export class EnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentValidationError';
  }
}

export const REQUIRED_ENVIRONMENT_VARIABLES = [
  'PRICE_API_URL',
  'BALE_BOT_TOKEN',
  'BALE_CHANNEL_ID',
] as const;

/**
 * Frozen defaults of the Phase 7 rules: three successful referrals per reward, one permanent alert
 * slot per reward, a thirty-day activity window. They live here so that the environment defaults, the
 * config service and the documentation all read the same numbers (§12).
 */
export const REFERRAL_DEFAULTS = {
  rewardsPerThreshold: 3,
  bonusSlots: 1,
  activeWindowDays: 30,
} as const;

const ENVIRONMENT_DEFAULTS: Readonly<Record<string, string>> = {
  PORT: '3000',
  PRICE_API_TIMEOUT_MS: '20000',
  PRICE_API_MAX_ATTEMPTS: '3',
  PRICE_API_RETRY_DELAY_MS: '1500',
  PRICE_API_UNIT: 'RIAL',
  PRICE_DISPLAY_UNIT: 'RIAL',
  PRICE_SYMBOL_UNITS: '',
  DELIVERY_TIMEOUT_MS: '20000',
  // --- Phase 1: market reliability ---
  // Per-update change tolerance (%) used for symbols without a registry-specific value.
  PRICE_MAX_CHANGE_PERCENT: '8',
  // Optional per-symbol tolerance overrides, e.g. "XAUUSD=10,TRY=12".
  PRICE_THRESHOLD_OVERRIDES: '',
  // Multiplier applied when the comparison baseline comes from a previous Tehran day.
  PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '2',
  // A symbol whose last successful update is older than this is reported as STALE.
  PRICE_STALE_AFTER_MINUTES: '45',
  // Where the minimal market state is persisted (empty string disables persistence).
  MARKET_STATE_FILE: './data/market-state.json',
  // Admin alert destination for rejected anomalies (empty = log-only).
  ANOMALY_ALERT_CHAT_ID: '',
  // De-duplication window per symbol+reason for anomaly alerts.
  ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
  // --- Phase 2: bot UX ---
  // Where users and their favorites are persisted (empty string disables persistence).
  USER_DATA_FILE: './data/users.json',
  // Maximum number of favorite symbols per user (enforced server-side).
  MAX_FAVORITES: '10',
  // Official channel (single source of truth for the CTA).
  CHANNEL_HANDLE: '@tala_atabak',
  CHANNEL_URL: 'https://ble.ir/tala_atabak',
  // Inbound interaction (long polling). Disabled keeps the previous publish-only behaviour.
  BOT_POLLING_ENABLED: 'true',
  // Long-poll wait in seconds, passed to the platform on every getUpdates call.
  BOT_POLL_TIMEOUT_SECONDS: '25',
  // Delay between two polling attempts after a transport failure.
  BOT_POLL_RETRY_DELAY_MS: '3000',
  // --- Phase 3: price alerts ---
  // Where alerts and their delivery records are persisted (empty string disables persistence).
  ALERTS_DATA_FILE: './data/alerts.json',
  // Maximum number of live alerts per user (ACTIVE + DISABLED count, TRIGGERED/DELETED do not).
  MAX_ALERTS_PER_USER: '5',
  // Extra send attempts after the first delivery failure (0 = no retry at all).
  ALERT_NOTIFICATION_MAX_RETRIES: '3',
  // Delay between two notification attempts.
  ALERT_NOTIFICATION_RETRY_DELAY_MS: '5000',
  // Safety bounds for the magnitude of a percentage alert (documented, configurable).
  ALERT_MIN_TARGET_PERCENT: '0.01',
  ALERT_MAX_TARGET_PERCENT: '100',
  // How long an unfinished "create alert" wizard may stay open before it is dropped.
  ALERT_WIZARD_TTL_MINUTES: '15',
  // --- Phase 5: Channel Engine ---
  // Where editorial content, publication jobs, deliveries and event state are persisted
  // (empty string disables persistence — publications then cannot survive a restart).
  CHANNEL_DATA_FILE: './data/channel.json',
  // Platform user ids allowed to manage editorial content (empty = admin surface disabled).
  CHANNEL_ADMIN_USER_IDS: '',
  // Longest editorial body an admin may submit.
  CHANNEL_MAX_CONTENT_CHARS: '3000',
  // Longest text that may accompany a photo (platform caption limit).
  CHANNEL_MEDIA_CAPTION_LIMIT: '1000',
  // Maximum number of publication jobs kept in the history document.
  CHANNEL_HISTORY_LIMIT: '500',
  // Total delivery attempts per destination (1 = no retry).
  CHANNEL_PUBLICATION_MAX_ATTEMPTS: '3',
  // Base delay between delivery attempts (exponential: delay x 2^(n-1)).
  CHANNEL_PUBLICATION_RETRY_DELAY_MS: '5000',
  // Grace after which a missed scheduled publication is skipped instead of published late.
  CHANNEL_MISSED_JOB_GRACE_MINUTES: '30',
  // Default movement threshold in percent (0 disables automatic movement publication).
  CHANNEL_MOVEMENT_THRESHOLD_PERCENT: '1',
  // Optional per-symbol movement thresholds, e.g. "XAUUSD=0.5,GOLD_18=0.8" (0 disables a symbol).
  CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES: '',
  // Minimum time between two movement publications for the same symbol.
  CHANNEL_MOVEMENT_COOLDOWN_MINUTES: '120',
  // Scheduled daily high/low publication (off by default: it changes the channel cadence).
  CHANNEL_DAILY_RANGE_ENABLED: 'false',
  CHANNEL_DAILY_RANGE_TIME: '21:00',
  // Event-driven high/low messages when a new daily extreme is established.
  CHANNEL_DAILY_RANGE_EVENTS_ENABLED: 'false',
  CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES: '90',
  // Scheduled daily market report (off by default for the same reason).
  CHANNEL_DAILY_REPORT_ENABLED: 'false',
  CHANNEL_DAILY_REPORT_TIME: '23:00',
  // --- Phase 6: channel <-> bot integration ---
  // Public bot username per platform (used to build deep links such as t.me/<username>?start=gold).
  // Empty disables every link that would point at that platform's bot (no guessed usernames, ever).
  BALE_BOT_USERNAME: '',
  TELEGRAM_BOT_USERNAME: '',
  // Public channel link for Telegram. Bale keeps using CHANNEL_URL; the two are different objects.
  TELEGRAM_CHANNEL_URL: '',
  // Channel -> bot call-to-action buttons on eligible publications.
  CHANNEL_CTA_ENABLED: 'true',
  // Optional per-type CTA override, e.g. "DAILY_REPORT=prices,EDUCATIONAL=none".
  CHANNEL_CTA_ROUTES: '',
  // Bot -> channel invitation row on the market-intelligence screens.
  BOT_CHANNEL_INVITE_ENABLED: 'true',

  // --- Phase 7: growth engine (referrals & rewards) ---
  // Master switch. `false` = no new referral registration, attribution, approval or reward; every
  // existing user, referral and already granted capacity is preserved untouched.
  REFERRAL_ENABLED: 'true',
  // Reward issuance switch (permanent extra price-alert slots). Independent of REFERRAL_ENABLED:
  // referrals keep being recorded while issuance is paused, and the ledger catches up on restart.
  REFERRAL_REWARDS_ENABLED: 'true',
  // Successful referrals required per reward, and permanent alert slots added per reward.
  REFERRAL_REWARDS_PER_THRESHOLD: String(REFERRAL_DEFAULTS.rewardsPerThreshold),
  REFERRAL_REWARD_BONUS_SLOTS: String(REFERRAL_DEFAULTS.bonusSlots),
  // Rolling window (days) used by the "active referred member" metric. Reporting only.
  REFERRAL_ACTIVE_WINDOW_DAYS: String(REFERRAL_DEFAULTS.activeWindowDays),
  // Upper bound on bonus alert slots per user: a misconfigured threshold can never turn into an
  // unlimited alert capacity.
  REFERRAL_MAX_BONUS_SLOTS: '50',
  // Bot destinations used to build referral links. Empty = the screen explains the missing
  // configuration instead of showing a guessed or dead link.
  BALE_REFERRAL_BOT_USERNAME: '',
  TELEGRAM_REFERRAL_BOT_USERNAME: '',

  // --- Phase 8: campaign tracking & attribution ---
  // Where campaigns, attribution records, funnel events, imported aggregates and manual
  // conversions are persisted (empty string disables persistence).
  CAMPAIGN_DATA_FILE: './data/campaigns.json',
  // Master switch. `false` = no new click/import/manual ingestion and no admin surface, while every
  // already recorded campaign, event, attribution and conversion stays readable (nothing erased).
  CAMPAIGN_TRACKING_ENABLED: 'true',
  // Click-to-conversion attribution window in days (the frozen default is 30).
  CAMPAIGN_ATTRIBUTION_WINDOW_DAYS: '30',
  // Public base URL of this deployment used to build tracked redirect links (`<base>/c/<token>`).
  // Empty = no redirect link is generated; direct platform deep links always keep working.
  CAMPAIGN_TRACKING_BASE_URL: '',
  // Channel-join verification: 'disabled' (default, assumes nothing) or 'getChatMember'
  // (only platforms that actually answer it can ever report a verified join).
  CAMPAIGN_CHANNEL_JOIN_VERIFICATION: 'disabled',
  // Retention for *raw click requests* only. Conversions, leads, customers, attributions and
  // imported aggregates are never pruned. 0 disables pruning.
  CAMPAIGN_RAW_EVENT_RETENTION_DAYS: '90',
  // Upper bound on retained raw click events per campaign (0 = no cap).
  CAMPAIGN_MAX_RAW_EVENTS: '20000',

  // --- Phase 9: sales engine ---
  // Master switch. `false` = no purchase entry, no new lead, no admin surface; every stored lead
  // stays readable (nothing is erased).
  SALES_ENGINE_ENABLED: 'true',
  // Where leads, their activity history, sales outcomes and notification state are persisted
  // (empty string keeps the Sales Engine in memory only).
  SALES_DATA_FILE: './data/sales.json',
  // Dedicated sales administrators. Empty = the existing CHANNEL_ADMIN_USER_IDS allow-list is used,
  // so a deployment needs no second configuration to work.
  SALES_ADMIN_USER_IDS: '',
  // Lifetime of an unfinished purchase form (the customer is asked to start again afterwards).
  SALES_FORM_TTL_MINUTES: '30',
  // Maximum delivery attempts for one notification (admin and customer), 1 = no retry.
  SALES_NOTIFICATION_MAX_ATTEMPTS: '3',
  // Base delay between notification attempts (linear backoff, bounded by the attempt limit).
  SALES_NOTIFICATION_RETRY_DELAY_MS: '5000',
  // Retention of *leads they are tied to*: 0 = never delete a lead automatically (the documented
  // default policy). A positive value only ever removes leads in a terminal status.
  SALES_LEAD_RETENTION_DAYS: '0',
  // Abuse bound: how many open leads one identity may have at the same time (0 = unlimited).
  SALES_MAX_OPEN_LEADS_PER_IDENTITY: '5',
};

const logger = new Logger('EnvironmentValidation');

/** Safe conversion to a plain string (objects never end up as `[object Object]`). */
function toPlainString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  return '';
}

function isBlank(value: unknown): boolean {
  return toPlainString(value).trim() === '';
}

function asString(env: Record<string, unknown>, key: string): string {
  return toPlainString(env[key]).trim();
}

function readInteger(
  env: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string {
  const raw = asString(env, key);
  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected an integer between ${min} and ${max}`,
    );
  }

  return raw;
}

/** Read a decimal number (thresholds are percentages, so they are not necessarily integers). */
function readNumber(
  env: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string {
  const raw = asString(env, key);
  const value = Number(raw);

  if (!Number.isFinite(value) || value < min || value > max) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected a number between ${min} and ${max}`,
    );
  }

  return raw;
}

/**
 * Read a boolean flag. Only explicit truthy/falsy spellings are accepted, so a typo like
 * `BOT_POLLING_ENABLED=yes` fails loudly instead of silently disabling user interaction.
 */
function readBoolean(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key).toLowerCase();

  if (raw !== 'true' && raw !== 'false') {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected "true" or "false"`,
    );
  }

  return raw;
}

/** Validate an absolute http(s) URL and return it unchanged. */
function readUrl(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" is not a valid absolute URL`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvironmentValidationError(
      `Invalid ${key}: protocol "${parsed.protocol}" is not supported (use http or https)`,
    );
  }

  return raw;
}

function readMoneyUnit(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key).toUpperCase();

  if (!isMoneyUnit(raw)) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected one of RIAL, TOMAN`,
    );
  }

  return raw;
}

/**
 * Parse `PRICE_SYMBOL_UNITS` (format: `SYMBOL=UNIT,SYMBOL=UNIT`) into a lookup table.
 * Symbols absent from the table are treated as being expressed in `PRICE_API_UNIT`.
 */
export function parseSymbolUnits(raw: unknown): Record<string, MoneyUnit> {
  const result: Record<string, MoneyUnit> = {};

  if (isBlank(raw)) {
    return result;
  }

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (entry === '') {
      continue;
    }

    const [symbolPart, unitPart] = entry.split('=');
    const symbol = (symbolPart ?? '').trim();
    const unit = (unitPart ?? '').trim().toUpperCase();

    if (symbol === '' || !isMoneyUnit(unit)) {
      throw new EnvironmentValidationError(
        `Invalid PRICE_SYMBOL_UNITS entry "${entry}" — expected the format SYMBOL=RIAL|TOMAN`,
      );
    }

    result[symbol] = unit;
  }

  return result;
}

/**
 * Parse `PRICE_THRESHOLD_OVERRIDES` (format: `SYMBOL=PERCENT,SYMBOL=PERCENT`) into a lookup table.
 * Symbols absent from the table keep their registry-defined tolerance.
 */
export function parseThresholdOverrides(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};

  if (isBlank(raw)) {
    return result;
  }

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (entry === '') {
      continue;
    }

    const [symbolPart, percentPart] = entry.split('=');
    const symbol = (symbolPart ?? '').trim();
    const percent = Number((percentPart ?? '').trim());

    if (
      symbol === '' ||
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent > 100
    ) {
      throw new EnvironmentValidationError(
        `Invalid PRICE_THRESHOLD_OVERRIDES entry "${entry}" — expected the format SYMBOL=PERCENT (0 < percent ≤ 100)`,
      );
    }

    result[symbol] = percent;
  }

  return result;
}

/** Validate a `HH:MM` time of day (Asia/Tehran wall clock). */
function readTimeOfDay(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key);

  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw)) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected a 24h time such as 21:00`,
    );
  }

  return raw;
}

/**
 * Parse `CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES` (`SYMBOL=PERCENT`) into a lookup table.
 * `0` is accepted and means "this symbol never publishes a movement event" — a missing or
 * invalid threshold must never silently allow unrestricted publication (§21).
 */
export function parseMovementThresholdOverrides(
  raw: unknown,
): Record<string, number> {
  const result: Record<string, number> = {};

  if (isBlank(raw)) {
    return result;
  }

  for (const chunk of String(raw).split(',')) {
    const entry = chunk.trim();
    if (entry === '') {
      continue;
    }

    const [symbolPart, percentPart] = entry.split('=');
    const symbol = (symbolPart ?? '').trim();
    const percent = Number((percentPart ?? '').trim());

    if (
      !/^[A-Z0-9_]{2,32}$/.test(symbol) ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      throw new EnvironmentValidationError(
        `Invalid CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES entry "${entry}" — expected the format SYMBOL=PERCENT (0 ≤ percent ≤ 100)`,
      );
    }

    result[symbol] = percent;
  }

  return result;
}

/**
 * Read a public bot username (Phase 6).
 *
 * A bot username cannot be derived from a bot token, so it is *configuration*: empty means “no public
 * link for this platform” and every deep link / CTA for that platform is then omitted instead of being
 * guessed. A non-empty value must be a syntactically valid platform username.
 */
function readBotUsername(env: Record<string, unknown>, key: string): string {
  const raw = asString(env, key);

  if (raw === '') {
    return '';
  }

  const normalized = raw.startsWith('@') ? raw.slice(1) : raw;

  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(normalized)) {
    throw new EnvironmentValidationError(
      `Invalid ${key}: "${raw}" — expected a bot username such as atabak_gold_bot (letters, digits, underscore)`,
    );
  }

  return normalized;
}

/**
 * Read an optional public URL. An empty value is a *disabled destination* (the affected link is not
 * rendered), while a non-empty malformed value still fails startup — a typo must never degrade into a
 * silently missing link.
 */
function readOptionalUrl(
  env: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const raw = asString(env, key);

  if (raw === '') {
    return fallback === '' ? '' : fallback;
  }

  return readUrl(env, key);
}

/**
 * Routes a CTA may point at (Phase 6 §6).
 *
 * Derived from the canonical `CTA_CHOICES` of the channel contract — `auto` is a content-editorial
 * choice, not a route an environment may name, so it is the only value excluded here.
 */
export const CTA_ROUTE_VALUES: readonly string[] = CTA_CHOICES.filter(
  (choice) => choice !== 'auto',
);

/**
 * Parse `CHANNEL_CTA_ROUTES` (`TYPE=route,TYPE=route`) into a lookup table.
 * Only the seven registered message types and the approved routes are accepted; `none` disables the
 * CTA for that type. An unknown key fails startup instead of being ignored silently.
 */
export function parseCtaRouteOverrides(raw: unknown): Record<string, string> {
  const text = toPlainString(raw).trim();

  if (text === '') {
    return {};
  }

  const overrides: Record<string, string> = {};

  for (const entry of text.split(',')) {
    const trimmed = entry.trim();

    if (trimmed === '') {
      continue;
    }

    const parts = trimmed.split('=');

    // Exactly one `=`: a second one is a typo, and accepting it would silently ignore half the value.
    if (parts.length !== 2) {
      throw new EnvironmentValidationError(
        `Invalid CHANNEL_CTA_ROUTES entry "${trimmed}" — expected <${ctaOverrideTypes()}>=<${CTA_ROUTE_VALUES.join('|')}>`,
      );
    }

    const type = (parts[0] ?? '').trim().toUpperCase();
    const route = (parts[1] ?? '').trim().toLowerCase();

    if (!isMessageTypeName(type) || !CTA_ROUTE_VALUES.includes(route)) {
      throw new EnvironmentValidationError(
        `Invalid CHANNEL_CTA_ROUTES entry "${trimmed}" — expected <${ctaOverrideTypes()}>=<${CTA_ROUTE_VALUES.join('|')}>`,
      );
    }

    overrides[type] = route;
  }

  return overrides;
}

/** The seven registered message types, taken from the registry that defines them (single source). */
/**
 * Referral bot usernames follow the exact same shape as the Phase 6 deep-link destinations; the
 * separate keys let operators point referral links at a different bot without touching the channel
 * call-to-action. Blank is a valid, documented value (the referral screen then explains what is
 * missing instead of showing a dead link).
 */
function readReferralBotUsername(
  env: Record<string, unknown>,
  key: string,
): string {
  return readBotUsername(env, key);
}

/**
 * Validate the referral thresholds and produce the normalized values consumed by the config service.
 *
 * Rules: at least one full referral per reward (a `0`/negative value would make every user instantly
 * eligible), a strictly positive bonus in slots, a positive active window (reporting), and an upper
 * bound on bonus slots so a misconfigured `REFERRAL_MAX_BONUS_SLOTS` can never mean "unlimited" (§12).
 */
function validateReferralThresholds(env: Record<string, unknown>): void {
  // The defaults are merged into `env` before validation, so these reads are always populated; the
  // ranges are the real guard (a `0` per threshold would make every user instantly eligible).
  env.REFERRAL_REWARDS_PER_THRESHOLD = readInteger(
    env,
    'REFERRAL_REWARDS_PER_THRESHOLD',
    1,
    10_000,
  );
  env.REFERRAL_REWARD_BONUS_SLOTS = readInteger(
    env,
    'REFERRAL_REWARD_BONUS_SLOTS',
    1,
    100,
  );
  env.REFERRAL_ACTIVE_WINDOW_DAYS = readInteger(
    env,
    'REFERRAL_ACTIVE_WINDOW_DAYS',
    1,
    3_650,
  );
  env.REFERRAL_MAX_BONUS_SLOTS = readInteger(
    env,
    'REFERRAL_MAX_BONUS_SLOTS',
    1,
    10_000,
  );
  // --- Phase 9: sales engine ---
  env.SALES_FORM_TTL_MINUTES = readInteger(
    env,
    'SALES_FORM_TTL_MINUTES',
    1,
    1_440,
  );
  env.SALES_NOTIFICATION_MAX_ATTEMPTS = readInteger(
    env,
    'SALES_NOTIFICATION_MAX_ATTEMPTS',
    1,
    10,
  );
  env.SALES_NOTIFICATION_RETRY_DELAY_MS = readInteger(
    env,
    'SALES_NOTIFICATION_RETRY_DELAY_MS',
    0,
    600_000,
  );
  env.SALES_LEAD_RETENTION_DAYS = readInteger(
    env,
    'SALES_LEAD_RETENTION_DAYS',
    0,
    36_500,
  );
  env.SALES_MAX_OPEN_LEADS_PER_IDENTITY = readInteger(
    env,
    'SALES_MAX_OPEN_LEADS_PER_IDENTITY',
    0,
    100,
  );

  // --- Phase 8: campaign tracking ---
  env.CAMPAIGN_ATTRIBUTION_WINDOW_DAYS = readInteger(
    env,
    'CAMPAIGN_ATTRIBUTION_WINDOW_DAYS',
    1,
    3_650,
  );
  env.CAMPAIGN_RAW_EVENT_RETENTION_DAYS = readInteger(
    env,
    'CAMPAIGN_RAW_EVENT_RETENTION_DAYS',
    0,
    3_650,
  );
  env.CAMPAIGN_MAX_RAW_EVENTS = readInteger(
    env,
    'CAMPAIGN_MAX_RAW_EVENTS',
    0,
    10_000_000,
  );
}

function isMessageTypeName(value: string): boolean {
  return isMessageType(value);
}

/** Human-readable list of the types an override may name (used in the error message only). */
function ctaOverrideTypes(): string {
  return MESSAGE_TYPES.join('|');
}

/**
 * Parse the admin allow-list (`CHANNEL_ADMIN_USER_IDS`).
 *
 * Each entry is either `bale:<userId>` / `telegram:<userId>` (recommended: the platform is part of
 * the identity, so an id on one platform can never be treated as an admin on the other) or a bare
 * `<userId>`, which matches on every platform. The list is empty by default, which disables the
 * whole editorial surface.
 */
export function parseAdminUserIds(
  raw: unknown,
  key = 'CHANNEL_ADMIN_USER_IDS',
): string[] {
  if (isBlank(raw)) {
    return [];
  }

  const ids = String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const id of ids) {
    const [head, ...tail] = id.split(':');
    const candidate = tail.length === 0 ? head : tail.join(':');

    if (
      tail.length > 1 ||
      !/^[A-Za-z0-9_@.-]{2,64}$/.test(candidate) ||
      (tail.length === 1 && head !== 'bale' && head !== 'telegram')
    ) {
      throw new EnvironmentValidationError(
        `Invalid ${key} entry "${id}" — expected "<userId>" or "<bale|telegram>:<userId>"`,
      );
    }
  }

  return [...new Set(ids)];
}

export function validateEnvironment(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> {
  const env: Record<string, unknown> = { ...rawConfig };

  for (const [key, value] of Object.entries(ENVIRONMENT_DEFAULTS)) {
    if (isBlank(env[key])) {
      env[key] = value;
    }
  }

  for (const key of REQUIRED_ENVIRONMENT_VARIABLES) {
    if (isBlank(env[key])) {
      throw new EnvironmentValidationError(
        `Missing required environment variable: ${key}`,
      );
    }
  }

  const priceApiUrl = asString(env, 'PRICE_API_URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(priceApiUrl);
  } catch {
    throw new EnvironmentValidationError(
      `Invalid PRICE_API_URL: "${priceApiUrl}" is not a valid absolute URL`,
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new EnvironmentValidationError(
      `Invalid PRICE_API_URL: protocol "${parsedUrl.protocol}" is not supported (use http or https)`,
    );
  }

  env.PORT = readInteger(env, 'PORT', 1, 65535);
  env.PRICE_API_TIMEOUT_MS = readInteger(
    env,
    'PRICE_API_TIMEOUT_MS',
    1000,
    300_000,
  );
  env.PRICE_API_MAX_ATTEMPTS = readInteger(
    env,
    'PRICE_API_MAX_ATTEMPTS',
    1,
    10,
  );
  env.PRICE_API_RETRY_DELAY_MS = readInteger(
    env,
    'PRICE_API_RETRY_DELAY_MS',
    0,
    60_000,
  );
  env.DELIVERY_TIMEOUT_MS = readInteger(
    env,
    'DELIVERY_TIMEOUT_MS',
    1000,
    300_000,
  );

  env.PRICE_MAX_CHANGE_PERCENT = readNumber(
    env,
    'PRICE_MAX_CHANGE_PERCENT',
    0.1,
    100,
  );
  env.PRICE_CROSS_DAY_CHANGE_MULTIPLIER = readNumber(
    env,
    'PRICE_CROSS_DAY_CHANGE_MULTIPLIER',
    1,
    20,
  );
  env.PRICE_STALE_AFTER_MINUTES = readInteger(
    env,
    'PRICE_STALE_AFTER_MINUTES',
    1,
    10_080,
  );
  env.ANOMALY_ALERT_COOLDOWN_MINUTES = readInteger(
    env,
    'ANOMALY_ALERT_COOLDOWN_MINUTES',
    0,
    10_080,
  );
  parseThresholdOverrides(env.PRICE_THRESHOLD_OVERRIDES); // validation only

  const channelHandle = asString(env, 'CHANNEL_HANDLE');
  if (!/^@[A-Za-z0-9_]{3,64}$/.test(channelHandle)) {
    throw new EnvironmentValidationError(
      `Invalid CHANNEL_HANDLE: "${channelHandle}" — expected a handle such as @tala_atabak`,
    );
  }

  env.MAX_FAVORITES = readInteger(env, 'MAX_FAVORITES', 1, 100);
  env.BOT_POLLING_ENABLED = readBoolean(env, 'BOT_POLLING_ENABLED');
  env.BOT_POLL_TIMEOUT_SECONDS = readInteger(
    env,
    'BOT_POLL_TIMEOUT_SECONDS',
    0,
    120,
  );
  env.BOT_POLL_RETRY_DELAY_MS = readInteger(
    env,
    'BOT_POLL_RETRY_DELAY_MS',
    100,
    300_000,
  );
  // Phase 6: an empty value means "no public channel destination" (the link is then omitted);
  // a malformed, non-empty value still fails startup.
  env.CHANNEL_URL = readOptionalUrl(
    env,
    'CHANNEL_URL',
    'https://ble.ir/tala_atabak',
  );

  env.MAX_ALERTS_PER_USER = readInteger(env, 'MAX_ALERTS_PER_USER', 1, 100);
  env.ALERT_NOTIFICATION_MAX_RETRIES = readInteger(
    env,
    'ALERT_NOTIFICATION_MAX_RETRIES',
    0,
    10,
  );
  env.ALERT_NOTIFICATION_RETRY_DELAY_MS = readInteger(
    env,
    'ALERT_NOTIFICATION_RETRY_DELAY_MS',
    0,
    600_000,
  );
  env.CHANNEL_MAX_CONTENT_CHARS = readInteger(
    env,
    'CHANNEL_MAX_CONTENT_CHARS',
    100,
    20_000,
  );
  env.CHANNEL_MEDIA_CAPTION_LIMIT = readInteger(
    env,
    'CHANNEL_MEDIA_CAPTION_LIMIT',
    50,
    4_096,
  );
  env.CHANNEL_HISTORY_LIMIT = readInteger(
    env,
    'CHANNEL_HISTORY_LIMIT',
    50,
    100_000,
  );
  env.CHANNEL_PUBLICATION_MAX_ATTEMPTS = readInteger(
    env,
    'CHANNEL_PUBLICATION_MAX_ATTEMPTS',
    1,
    10,
  );
  env.CHANNEL_PUBLICATION_RETRY_DELAY_MS = readInteger(
    env,
    'CHANNEL_PUBLICATION_RETRY_DELAY_MS',
    0,
    600_000,
  );
  env.CHANNEL_MISSED_JOB_GRACE_MINUTES = readInteger(
    env,
    'CHANNEL_MISSED_JOB_GRACE_MINUTES',
    0,
    1_440,
  );
  env.CHANNEL_MOVEMENT_THRESHOLD_PERCENT = readNumber(
    env,
    'CHANNEL_MOVEMENT_THRESHOLD_PERCENT',
    0,
    100,
  );
  parseMovementThresholdOverrides(env.CHANNEL_MOVEMENT_THRESHOLD_OVERRIDES);
  env.CHANNEL_MOVEMENT_COOLDOWN_MINUTES = readInteger(
    env,
    'CHANNEL_MOVEMENT_COOLDOWN_MINUTES',
    0,
    10_080,
  );
  env.CHANNEL_DAILY_RANGE_ENABLED = readBoolean(
    env,
    'CHANNEL_DAILY_RANGE_ENABLED',
  );
  env.CHANNEL_DAILY_RANGE_TIME = readTimeOfDay(env, 'CHANNEL_DAILY_RANGE_TIME');
  env.CHANNEL_DAILY_RANGE_EVENTS_ENABLED = readBoolean(
    env,
    'CHANNEL_DAILY_RANGE_EVENTS_ENABLED',
  );
  env.CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES = readInteger(
    env,
    'CHANNEL_DAILY_RANGE_COOLDOWN_MINUTES',
    0,
    10_080,
  );
  env.CHANNEL_DAILY_REPORT_ENABLED = readBoolean(
    env,
    'CHANNEL_DAILY_REPORT_ENABLED',
  );
  env.CHANNEL_DAILY_REPORT_TIME = readTimeOfDay(
    env,
    'CHANNEL_DAILY_REPORT_TIME',
  );
  // --- Phase 6: channel <-> bot integration ---
  env.BALE_BOT_USERNAME = readBotUsername(env, 'BALE_BOT_USERNAME');
  env.TELEGRAM_BOT_USERNAME = readBotUsername(env, 'TELEGRAM_BOT_USERNAME');
  env.TELEGRAM_CHANNEL_URL = readOptionalUrl(env, 'TELEGRAM_CHANNEL_URL', '');
  env.CHANNEL_CTA_ENABLED = readBoolean(env, 'CHANNEL_CTA_ENABLED');
  parseCtaRouteOverrides(env.CHANNEL_CTA_ROUTES);
  env.BOT_CHANNEL_INVITE_ENABLED = readBoolean(
    env,
    'BOT_CHANNEL_INVITE_ENABLED',
  );
  // --- Phase 7: growth engine ---
  env.REFERRAL_ENABLED = readBoolean(env, 'REFERRAL_ENABLED');
  env.REFERRAL_REWARDS_ENABLED = readBoolean(env, 'REFERRAL_REWARDS_ENABLED');
  // --- Phase 9: sales engine ---
  env.SALES_ENGINE_ENABLED = readBoolean(env, 'SALES_ENGINE_ENABLED');
  // Reuses the same allow-list parser (and therefore the same accepted syntax) as the channel
  // admins, so both surfaces cannot drift apart.
  parseAdminUserIds(env.SALES_ADMIN_USER_IDS, 'SALES_ADMIN_USER_IDS');

  // --- Phase 8: campaign tracking ---
  env.CAMPAIGN_TRACKING_ENABLED = readBoolean(env, 'CAMPAIGN_TRACKING_ENABLED');
  env.CAMPAIGN_CHANNEL_JOIN_VERIFICATION =
    readCampaignJoinVerificationMode(env);
  env.CAMPAIGN_TRACKING_BASE_URL = readCampaignTrackingBaseUrl(env);
  env.BALE_REFERRAL_BOT_USERNAME = readReferralBotUsername(
    env,
    'BALE_REFERRAL_BOT_USERNAME',
  );
  env.TELEGRAM_REFERRAL_BOT_USERNAME = readReferralBotUsername(
    env,
    'TELEGRAM_REFERRAL_BOT_USERNAME',
  );

  if (readBoolean(env, 'REFERRAL_ENABLED') === 'true') {
    // Thresholds are validated only for the platform that actually needs them (Bale is mandatory,
    // Telegram is optional) — an unconfigured optional platform must never block startup.
    validateReferralThresholds(env);
  }
  parseAdminUserIds(env.CHANNEL_ADMIN_USER_IDS);

  env.ALERT_MIN_TARGET_PERCENT = readNumber(
    env,
    'ALERT_MIN_TARGET_PERCENT',
    0.0001,
    50,
  );
  env.ALERT_MAX_TARGET_PERCENT = readNumber(
    env,
    'ALERT_MAX_TARGET_PERCENT',
    0.001,
    1000,
  );

  if (
    Number(env.ALERT_MIN_TARGET_PERCENT) > Number(env.ALERT_MAX_TARGET_PERCENT)
  ) {
    throw new EnvironmentValidationError(
      'Invalid alert percentage bounds: ALERT_MIN_TARGET_PERCENT must not exceed ' +
        'ALERT_MAX_TARGET_PERCENT',
    );
  }

  env.ALERT_WIZARD_TTL_MINUTES = readInteger(
    env,
    'ALERT_WIZARD_TTL_MINUTES',
    1,
    10_080,
  );

  env.PRICE_API_UNIT = readMoneyUnit(env, 'PRICE_API_UNIT');
  env.PRICE_DISPLAY_UNIT = readMoneyUnit(env, 'PRICE_DISPLAY_UNIT');
  parseSymbolUnits(env.PRICE_SYMBOL_UNITS); // validation only — the raw string is kept as is

  const hasTelegramToken = !isBlank(env.TELEGRAM_BOT_TOKEN);
  const hasTelegramChannel = !isBlank(env.TELEGRAM_CHANNEL_ID);

  if (hasTelegramToken !== hasTelegramChannel) {
    logger.warn(
      'Telegram is only partially configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID): ' +
        'Telegram delivery stays disabled until both are provided.',
    );
  }

  return env;
}

/**
 * Channel-join verification mode (§8.4).
 *
 * `disabled` is the honest default: no platform capability is assumed. `getChatMember` is only
 * meaningful for platforms that actually answer that query — Telegram does; Bale's support is not
 * verified by this project, so a Bale response is recorded as unverified, never as a join.
 */
export function readCampaignJoinVerificationMode(
  env: Record<string, unknown>,
): string {
  const raw = asString(env, 'CAMPAIGN_CHANNEL_JOIN_VERIFICATION')
    .trim()
    .toLowerCase();

  if (raw === '' || raw === 'disabled') {
    return 'disabled';
  }

  if (raw === 'getchatmember') {
    return 'getChatMember';
  }

  throw new EnvironmentValidationError(
    `Invalid CAMPAIGN_CHANNEL_JOIN_VERIFICATION: "${raw}" (use "disabled" or "getChatMember")`,
  );
}

/**
 * Public base URL used to build tracked redirect links (§7.2).
 *
 * An empty value is a *valid* configuration: the deployment then has no redirect endpoint and only
 * direct platform deep links are offered. A non-empty value must be an absolute http(s) URL without
 * a trailing slash — guessing a public URL would produce links that silently never resolve.
 */
export function readCampaignTrackingBaseUrl(
  env: Record<string, unknown>,
): string {
  const raw = asString(env, 'CAMPAIGN_TRACKING_BASE_URL').trim();

  if (raw === '') {
    return '';
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvironmentValidationError(
      `Invalid CAMPAIGN_TRACKING_BASE_URL: "${raw}" is not a valid absolute URL`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvironmentValidationError(
      `Invalid CAMPAIGN_TRACKING_BASE_URL: protocol "${parsed.protocol}" is not supported (use http or https)`,
    );
  }

  return parsed.toString().replace(/\/+$/, '');
}

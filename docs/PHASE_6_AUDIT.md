# PHASE 6 AUDIT — 🔗 CHANNEL ↔ BOT (Atabak Gold)

Written **before** any Phase 6 code, against the real repository state (commit `e02c288`, Phase 5 pushed).

## 1. What actually exists (verified by reading the code, not the specs)

| Area | Reality in this repository | Reused by Phase 6 |
| --- | --- | --- |
| Stack | NestJS 11, TypeScript strict, Node ≥ 20; one flat `AppModule` | — |
| Platforms | `src/platform/`: `PlatformAdapter`, `BotApiClient` (Telegram-compatible JSON API; Bale = `https://tapi.bale.ai/bot<token>`, Telegram = `https://api.telegram.org/bot<token>`), `PlatformRegistryService`, long-poll `UpdatePollerService` | yes |
| Inbound model | `InboundMessage { text }`, `InboundCallback { data }`; commands parsed by `asCommand()` (`/start@bot arg`) — arguments are currently **dropped** | extended |
| `/start` | `BotUxService.handleMessage` → welcome screen + `mainMenuKeyboard()`; no payload handling | extended |
| Main menu | `mainMenuKeyboard()` already contains `📢 کانال اتابک` → `screen:channel`; `channelKeyboard(url)` renders a URL button from `CHANNEL_URL` | kept, made config-safe |
| Screens | `ScreenKey`: prices, gold, coins, market, report, report-full, movement, last-update, favorites, alerts, channel | deep links map onto them |
| Alerts (Phase 3) | `startWizard(userId, 'symbol')` + `renderScreen('alert-wizard')` behind the `alert-new` callback; own store, validation, notification service | deep link reuses the same entry |
| Market intelligence (Phase 4) | `MarketViewService.buildIntelligence(now)` + `market-format.ts` screens; keyboards `marketKeyboard`, `dailyReportKeyboard`, `fullReportKeyboard`, `sectionKeyboard` | invitation row added here |
| Channel engine (Phase 5) | registry (7 types), `ChannelPolicyService`, `channel-format.ts`, `ChannelPublisher`, `ChannelEngineService`, `PublicationStore`, `ContentService`/`ContentAdminService` | CTA added inside this pipeline |
| Publishing transport | `BotApiClient.publishText/publishPhoto` — **no `reply_markup` support** (Phase 5 never needed buttons) | extended with an optional keyboard |
| Bot–channel link | `KeyboardButton` already supports `url`; `toReplyMarkup()` already serialises URL buttons — used by the channel screen | reused for CTAs |
| Config | `env.validation.ts` (defaults + typed readers) + `AppConfigService` getters; unknown keys are ignored; `CHANNEL_URL` is **required** to be a valid URL today | 6 new keys |
| Tests | 51 unit suites / 781 tests, 5 e2e suites / 31 tests, all green at `e02c288` | extended |
| Docker/README | multi-stage image, README §4.5 for Phase 5 | extended |

## 2. Platform facts that constrain the design (evidence, not assumption)

* **Telegram deep links**: `https://t.me/<bot_username>?start=<payload>`; the payload arrives as the text
  `/start <payload>` and must match `[A-Za-z0-9_-]{1,64}`.
* **Bale deep links** (official docs, `https://docs.bale.ai/` → «پیوندهای بازو»): structure
  `ble.ir/<bot_username>?start=<parameter>`; “اگر مقدار parameter پر شده باشد، بهصورت یک پیام متنی با
  قالب `/start <parameter>` برای سرور ارسال میشود” — i.e. the **same** `/start <payload>` contract as
  Telegram, only the host differs. Confirmed in the same document: the API base is
  `https://tapi.bale.ai/bot<token>/METHOD_NAME` (what `BotApiClient` already uses), updates carry
  `message` / `callback_query`, and inline keyboards support `url` and `callback_data` buttons — which
  the project already uses for the channel screen.
* Consequence: **one logical route contract**, two URL hosts, no Bale-specific business logic. The
  payloads are short lowercase words (`alert`, `prices`, `coin`, `gold`, `channel`) and satisfy both
  platforms' character rules.
* Bot **usernames** are not derivable from a bot token: they must be configured. Guessing one would
  fabricate a destination, which the phase forbids → new explicit configuration, and a missing username
  disables the affected link instead of producing a broken one.

## 3. Gaps found in the current tree (to be closed by Phase 6)

1. `/start <payload>` arguments are parsed away — no deep-link routing exists.
2. No bot-username configuration → no deep-link URL can be built safely today.
3. Channel publications cannot carry buttons: `publishText`/`publishPhoto` never send `reply_markup`.
4. `PublicationPayload` has no CTA field, and no policy decides *which* message may link to *which* bot
   feature.
5. `CHANNEL_URL` must currently be a valid URL — an empty value would crash startup, so the
   “channel destination unavailable” path cannot be expressed in configuration.
6. Market screens have no channel invitation; the only channel entry point is the main menu and the
   dedicated channel screen.
7. There is no explicit place where a *alert-promotion* post can be marked as such: the seven Phase 5
   message types contain no “promotion” type, and adding an eighth type would violate the Phase 5
   registry. The CTA must therefore be attachable **per content item** (admin decision through the
   existing approval workflow), not by inventing a new type.

## 4. Decisions taken for the implementation

* **D1 — Route registry in `src/bot/deep-link.ts`**: `BotRoute = alert | prices | coin | gold | channel`,
  one parser (`parseStartPayload`), one screen mapping. Payload parsing stays separate from feature
  execution and is shared by both platforms.
* **D2 — Destination building in `src/bot/bot-destination.service.ts`**: the single place that turns
  `(platform, route)` into a URL, using only configured usernames; returns `null` when unconfigured, so
  no caller can invent a link. Channel URLs are per platform (`CHANNEL_URL` = Bale,
  `TELEGRAM_CHANNEL_URL` = Telegram) because the two platform links are not the same object.
* **D3 — CTA policy in `src/channel/cta-policy.ts`**: type-driven default (registry) + subject-group
  refinement (gold/coin) + per-content override set by an admin. The alert CTA is *only* produced for a
  content item explicitly marked as alert promotion — never for routine price updates.
* **D4 — CTA inside the existing payload, keyboard built per destination**: `PublicationPayload.cta`
  carries `{ route, labelFa }`; `ChannelPublisher` asks the destination service for the platform-specific
  URL, so one publication can carry a Bale link on Bale and a Telegram link on Telegram — or no button at
  all on a platform whose username is unconfigured. Delivery records store the CTA route for auditability.
* **D5 — Invitation is opt-in and contextual**: a single helper adds one short line + one URL button to
  the four market-intelligence screens only, and only when the invitation is enabled *and* the platform
  channel URL is configured. No universal footer, no cadence claim (the copy does not promise a
  publication time).
* **D6 — Nothing else changes**: no new dependency, no new store, no new endpoint, no new cron, no change
  to price/alert/intelligence/publishing semantics.

## 5. Explicitly out of scope (unchanged by this phase)

AI/LLM content, predictions, signals, CRM/referral/attribution, analytics dashboards, payments,
subscriptions, new market providers, new persistence, new infrastructure, an eighth message type, a
second publishing pipeline, and any rewrite of the bot framework.

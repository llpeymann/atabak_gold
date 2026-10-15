# PHASE 6 REPORT — 🔗 CHANNEL ↔ BOT (Atabak Gold)

Reporter: implementation agent · Date: 2026-10-16 · Branch: `main` · Base commit: `e02c288` (Phase 5 closure)
Verification environment: the real repository tree at `/home/user/atabak_gold`, the real `npm` scripts,
the real built application (`dist/main.js`) driven over a real HTTP wire by a test-only rig outside the
repository.

---

## 1. Repository Audit

The phase started by reading the actual tree instead of trusting phase names.

* **Phase 1 (price truth)** — `src/market/*`, `src/price/*`: the only source of prices. Phase 6 **reads
  nothing from it directly**: it only routes a user to the screens that Phase 1 already feeds.
* **Phase 3 (alerts)** — `src/alerts/*`, `src/bot/ux/alert-*`: the alert wizard, validation, persistence
  and limits. Phase 6 **enters** this flow (`alert` route) and changes none of it.
* **Phase 4 (market intelligence)** — `src/intelligence/*`, the four market-report screens. Phase 6
  **appends one invitation line** to those screens; it does not compute or duplicate a single statistic.
* **Phase 5 (publication)** — `src/channel/*`: registry (7 message types), content lifecycle, approval,
  scheduling, idempotency, per-destination delivery, retry/ambiguity classification. Phase 6 **attaches a
  button inside this pipeline** (`ChannelPublisher`) instead of building a second publishing path.
* **Bot surface** — `src/bot/ux/*`: one router, one screen renderer, one keyboard module, one callback
  grammar. Phase 6 adds **one** start handler and **one** rendering helper to it.
* **Platform layer** — `src/platform/*`: `BotApiClient` (the only code that calls a Bot API) and
  `PlatformRegistry`/adapters. Phase 6 extends `sendMessage`/`sendPhoto` with an optional keyboard, so
  there is still exactly one place that talks to a platform.
* **Gaps found** (recorded as D1–D6 in `docs/PHASE_6_AUDIT.md`): no startup payload vocabulary, no public
  bot/channel URL source, no CTA policy, no per-platform channel destination, no `cta` field on content,
  and no way for an admin to express "this post promotes alerts" (the registry has seven types and no
  promotion type). The audit also fixed the plan to *not* invent an eighth message type.

---

## 2. Scope Delivered (and what was explicitly not changed)

Delivered:

1. **Channel → Bot**: publications can carry a purpose-specific bot button, decided by a policy, built
   per platform from configuration, threaded through the existing publisher, and recorded per delivery.
2. **Bot → Channel**: a channel entry in the bot, with a labelled fallback when no destination is
   configured, plus the market-report invitation on the four intelligence answers.
3. **Deep links**: one logical route registry with five approved routes, a safe parser, and routing that
   reuses the existing screens and the existing alert wizard.
4. **Safety**: untrusted payloads, missing configuration, unsupported platform capability, delivery
   failure, and platform asymmetry are all handled without fabrication and without crashes.
5. **Configuration, documentation, tests and runtime verification** (sections 11–14).

Not changed (deliberately):

* the seven message types and the registry contract (no eighth type was invented);
* the Phase 5 approval/scheduling/idempotency/retry logic, its stores and its persistence format
  (`ctaRoute` is an additive field; older documents load unchanged);
* the Phase 1 price pipeline, the Phase 3 alert engine, the Phase 4 intelligence layer;
* the bot's menu structure (no second menu, no universal footer, no promo appended to every reply);
* dependency files (`package.json`/`package-lock.json` untouched — no new dependency was needed).

---

## 3. Architecture and Data Flow

```
                        Phase 6 seams (new)                     Owner of the capability
  ─────────────────────────────────────────────────────────────────────────────────────────
  Channel → Bot:
    registry default / config override / content choice
        ↓  CtaPolicyService.decide()                       (policy only — no data, no I/O)
    { route, labelFa }  →  PublicationPayload.cta          (Phase 5 payload, extended)
        ↓  ChannelPublisher.ctaKeyboardFor(destination)    (Phase 5 publisher)
    Keyboard  →  BotDestinationService.ctaKeyboard()        (per platform URL construction)
        ↓  BotApiClient.publishText/publishPhoto(reply_markup)  (Phase 5 transport)
    ChannelDeliveryOutcome.ctaRoute → PublicationDelivery.ctaRoute   (per-destination record)

  Bot → Channel:
    renderScreen('report'|'report-full'|'movement'|'last-update')
        ↓  BotUxService.withChannelInvite(screen, platform) (one shared helper)
    + invitation line, + one URL row    ← BotDestinationService.channelInviteRow(platform)

  Deep links:
    /start <payload>  →  parseStartPayload()  →  screenForRoute()  →  existing screens
                                              ↘  alert → startWizard() (existing Phase 3 entry)
```

Two new services carry the whole phase:

* `src/bot/destination.service.ts` — `BotDestinationService`: the **only** place a public bot username or
  channel URL becomes a link. Everything is configuration-derived; a missing value returns `null`.
* `src/channel/cta-policy.service.ts` — `CtaPolicyService`: the **only** place the CTA decision is made.
  Pure, deterministic, no I/O, no market data, no state mutation.

---

## 4. Route Registry and Start-Payload Parsing

`src/bot/deep-link.ts` (new).

* `BotRoute = 'alert' | 'prices' | 'coin' | 'gold' | 'channel'` and `BOT_ROUTES` — the closed set of
  approved routes. `isBotRoute()` is the runtime guard; anything else is refused before routing.
* `screenForRoute(route)`: `prices → prices`, `coin → coins`, `gold → gold`, `channel → channel`,
  `alert → null` (it starts the Phase 3 wizard instead of rendering a screen).
* `parseStartPayload(text)` returns one of three shapes and never throws:
  * `{ kind: 'none' }` — no payload (empty/blank/`/start`): the **preserved default**;
  * `{ kind: 'route', route, raw }` — an approved payload;
  * `{ kind: 'unknown', raw }` — a payload the product does not define.
* Parsing rules: only the **second whitespace token** is interpreted (so `/start`, `/start prices`,
  `/start@bot prices`, `/start prices extra` are all handled and extra tokens are ignored — they can
  never become a second route, a symbol or a permission); the value is lowercased for comparison but the
  accepted **syntax** is narrow (`^[a-z0-9_-]{1,32}$`, max 32 characters); anything that fails the
  syntax or is not one of the five routes is `unknown`.
* Parsing is separated from execution: `parseStartPayload` is a pure function, and the router is the only
  caller that acts on it. There is no second parser and no parsing inside a screen renderer.

Documented rule for extra parameters (also in the README): **only the first parameter is a route; every
further parameter is ignored** — the phase specification left this to be documented, and it is.

---

## 5. CTA Policy (Channel → Bot eligibility)

`src/channel/cta-policy.service.ts` (new). Three layers, in priority order:

1. **Explicit admin choice on the content item** (`ContentItem.ctaRoute`, set with
   `/content cta <id> <choice>`). This is the *only* way an alert-promotion post exists — the Phase 5
   registry has no promotion type and no eighth type was invented.
2. **Configuration override** (`CHANNEL_CTA_ROUTES`, `TYPE=route|none`), validated at startup.
3. **Registry default** (`specFor(type).defaultCta`), optionally refined by the publication's **subject
   group** (from Phase 1 symbols, never from text matching).

Fixed behaviour, all covered by tests:

| Type | Default CTA |
| --- | --- |
| `PRICE_UPDATE`, `MARKET_MOVEMENT`, `DAILY_RANGE` | subject group: all-gold → `gold`, all-coin → `coin`, mixed/empty → `prices` |
| `DAILY_REPORT`, `NIGHTLY_ANALYSIS` | `prices` |
| `EDUCATIONAL`, `BRANDED` | **no button** |

Consequences that satisfy the acceptance rules: a routine price update **never** carries the alert CTA; an
unrelated educational post **never** carries a price/coin/gold button; `auto` and a missing value behave
identically (documents written before Phase 6 keep working); `none` silences a type or an item; and the
whole feature can be switched off with `CHANNEL_CTA_ENABLED=false`. The policy is pure — it does not
read market data, does not mutate the item it is given, and does not build a URL.

---

## 6. Channel → Bot Delivery (per platform)

Wiring inside the **existing** Phase 5 pipeline (no second publisher):

* `ChannelEngineService.payloadOf()` decides the CTA and puts `{ route, labelFa }` into the publication
  payload (the payload carries **intent only** — never a URL).
* `ChannelPublisher.publish()` resolves the keyboard **per destination**
  (`ctaKeyboardFor(destination, payload)` → `BotDestinationService.ctaKeyboard(platform, cta)`) and hands
  it to `BotApiClient.publishText`/`publishPhoto`, which add `reply_markup` only when a keyboard exists.
* Placement rule: the button sits on the **primary** message of the publication — the caption message
  when the text fits the caption limit, otherwise the separate text message that carries the text. It is
  never duplicated onto both.
* `ChannelDeliveryOutcome.ctaRoute` and `PublicationDelivery.ctaRoute` record **what actually went out**
  (`null` = no button). A failed send is never recorded as "the button was published": the outcome
  normalizes `ctaRoute` to `null` unless the call succeeded.
* A missing/unsupported destination does **not** block distribution: the post is published without a
  button. This is verified per platform (Bale without a username still receives the post; Telegram gets
  its own link in the same run).

---

## 7. Bot → Channel

* **Menu entry**: the existing `channel` screen shows the configured channel destination as a URL button
  (`channelKeyboard(url)`), and when no destination exists it shows a concise explanation
  (`formatChannelUnavailableScreen()`) with **no dead button**.
* **Market-report invitation**: `BotUxService.withChannelInvite(screen, platform)` — one shared helper,
  applied at the two places a market screen is rendered (callback navigation and the start-route path).
  It appends exactly one line — `📢 تحلیل کاملتر بازار در کانال طلای اتابک` — and one row
  (`📢 دیدن تحلیل در کانال`) to the **four report screens** (`report`, `report-full`, `movement`,
  `last-update`), and nowhere else. The `market` hub, the price screens and the menu are untouched, so
  there is no universal footer and no second menu.
* The invitation claims nothing: no publication time, no "the report is complete", no duplicated
  statistics. A test asserts the report text with the invitation **starts with** the report text without
  it — byte-identical statistics.
* It disappears completely when `BOT_CHANNEL_INVITE_ENABLED=false` or the platform has no channel
  destination.

---

## 8. Deep-Link Feature Routing

`BotUxService.handleStart()` is the single execution point for `/start` (the previous inline handling was
moved into it unchanged for the empty-payload case):

| Payload | Result |
| --- | --- |
| *(none)* | the preserved default: welcome screen + main menu |
| `prices` / `gold` / `coin` | the corresponding existing Phase 1-backed screen (freshness/stale rules untouched) |
| `channel` | the channel screen (configured destination) or the safe explanation |
| `alert` | the **existing** Phase 3 wizard (`startWizard` + `renderScreen('alert-wizard')`) |
| unknown | main menu + a short explanation, plus one diagnostic log line (`Unknown start payload …`) |

Safety properties, verified by tests: a deep link **never creates an alert** (the wizard only asks for
the symbol; `AlertService` is untouched and the alert store stays empty), it **cannot invoke an admin
operation** (`/start admin`, `/start content`, `/start publish`, `/start ../../admin` all end at the main
menu, never at the content surface), it cannot widen a decision (`/start prices extra` is the ordinary
price screen with no url button), and a malformed payload never throws (the router's existing catch-all
still returns a safe message).

---

## 9. Platform Reality: Telegram and Bale, Verified Independently

| Aspect | Telegram | Bale |
| --- | --- | --- |
| Deep-link shape | `https://t.me/<username>?start=<payload>` | `https://ble.ir/<username>?start=<payload>` |
| Payload delivery | `/start <payload>` | `/start <payload>` (documented) |
| Inline URL buttons | supported | supported (`url` / `callback_data`) |
| Configuration key | `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHANNEL_URL` | `BALE_BOT_USERNAME`, `CHANNEL_URL` |

* Capabilities are modelled as data (`PlatformLinkCapabilities`), not as a Telegram-shaped assumption, and
  each platform is tested on its own: its own host, its own key, its own missing-config behaviour.
* Nothing is claimed beyond what is verifiable here. **Live verification against the real Bale/Telegram
  APIs was NOT possible in this environment** (no real credentials are available to the agent, and
  sending real messages is out of scope) — the live checks were performed against a wire-level emulation
  of both APIs (section 14) and the manual live checklist is provided for the operator (§10 below).
* A value that is not a usable username (wrong length, illegal characters, a stray `@` handled by
  normalization, spaces, `@` alone) is refused at startup (`BALE_BOT_USERNAME`/`TELEGRAM_BOT_USERNAME`
  validation) **and** re-checked in the destination builder, so a malformed value can never become a
  malformed URL.

Manual live checklist (safe environment only, no production channel writes): 1) set
`BALE_BOT_USERNAME`; 2) open `https://ble.ir/<bot>?start=prices` and confirm the price screen; 3) repeat
with `alert` and confirm the wizard (and that no alert exists yet); 4) repeat with `gold`, `coin`,
`channel`; 5) open `https://ble.ir/<bot>?start=unknown_route` and confirm the menu; 6) publish one test
content item with `/content cta <id> alert` in a test channel and confirm the button opens the bot on a
phone; 7) repeat the CTA check for Telegram with `TELEGRAM_BOT_USERNAME`/`TELEGRAM_CHANNEL_URL`.

---

## 10. Security and Failure Behaviour

* **Untrusted payloads**: only the five approved route ids are accepted; the parser is syntax-first and
  length-bounded; unknown input never reaches a feature.
* **No arbitrary destinations**: every URL comes from `BotDestinationService`, derived from configuration
  (`ble.ir`/`t.me` hosts only). A missing destination yields `null` → the button is omitted, never
  fabricated.
* **No privilege escalation**: deep links cannot reach admin operations, cannot override permissions
  (the admin surface is still gated by `CHANNEL_ADMIN_USER_IDS` server-side), and cannot bypass alert
  validation or the per-user alert limit.
* **Parse-mode safety**: the invitation and all new texts are static Persian strings rendered through the
  existing HTML escaping rules; user input is never interpolated into a new template.
* **No secret leakage**: tokens are never put into a URL, a label, a message body or a log line. The rig
  asserts that no token appears in any user-visible field and that every button URL is a public
  `https://ble.ir/...` or `https://t.me/...` link.
* **Failure behaviour**: a failed primary send records `ctaRoute: null`; a media-only failure still
  delivers the text **with** its CTA; a platform without a destination publishes without a button; a
  disabled feature flag publishes without a button; an unknown payload or an invalid callback never
  crashes the bot (the router's existing safe-failure path is preserved).

---

## 11. Configuration

Six new optional keys, all documented in `.env.example` and the README table, all validated at startup:

| Key | Default | Meaning |
| --- | --- | --- |
| `BALE_BOT_USERNAME` | *(empty)* | public Bale bot username (no `@`); empty → no Bale CTA/deep link |
| `TELEGRAM_BOT_USERNAME` | *(empty)* | public Telegram bot username; independent of the Bale value |
| `TELEGRAM_CHANNEL_URL` | *(empty)* | public Telegram channel link; empty → the entry is omitted |
| `CHANNEL_CTA_ENABLED` | `true` | master switch for channel CTAs |
| `CHANNEL_CTA_ROUTES` | *(empty)* | `TYPE=route` overrides, `route ∈ none·alert·prices·coin·gold·channel` |
| `BOT_CHANNEL_INVITE_ENABLED` | `true` | market-report invitation on/off |

* `CHANNEL_URL` keeps its Phase 1/5 default (`https://ble.ir/tala_atabak`); Telegram has its own key
  because a Bale address is not a Telegram destination.
* Validation fails startup with a clear message for an unusable username, a malformed channel URL and an
  invalid `CHANNEL_CTA_ROUTES` entry (including a doubled `=` such as `PRICE_UPDATE=gold=gold`, which is
  now refused instead of silently truncated).
* Single-sourcing: the route vocabulary lives in `CTA_CHOICES` (channel contract) and the message-type
  vocabulary in the registry; `env.validation.ts` derives `CTA_ROUTE_VALUES` from `CTA_CHOICES` and the
  type list from `MESSAGE_TYPES`, so a choice can no longer be accepted in one place and refused in
  another.
* An unconfigured optional platform (Telegram, or the CTA keys) never prevents boot.

---

## 12. Documentation

* `.env.example` — a new “channel ↔ bot integration (Phase 6)” block with every key, its default and the
  exact effect of an empty value.
* `README.md` — new section **4.6 پیوند کانال و بات (Phase 6)**: policy order, defaults per type, URL
  construction per platform, the CTA-on-primary-message rule, the Bot → Channel invitation scope, a
  complete deep-link table (including "unknown payload" and "no payload"), the extra-parameter rule, and
  the security statements. The environment table gained the six keys, and the Phase-5 configuration
  paragraph now names the two `CHANNEL_*` keys the phase adds.
* `docs/PHASE_6_AUDIT.md` — the repository audit, the design decisions (D1–D6) and the plan this report
  closes out.
* This report (`docs/PHASE_6_REPORT.md`).

---

## 13. Tests and Quality Gates

### 13.1 Required scenarios (§13) — all covered

| Required | Where |
| --- | --- |
| Route registry / parser | `src/bot/deep-link.spec.ts` (12 tests: registry, five routes, `/start@bot`, case, extra params, 10 malformed payloads, determinism) |
| Feature routing | `src/bot/ux/deep-link-flow.integration.spec.ts` (alert wizard without an alert, prices/gold/coin/channel, uppercase, extra params, unknown payload, admin-op refusal, malformed payloads) + `test/bot-ux.e2e-spec.ts` through the real module graph |
| CTA policy | `src/channel/cta-policy.spec.ts` (18 tests: subject groups, per-type defaults, no alert on price updates, no button on editorial, admin choice, `none`, `auto`/legacy equality, overrides, kill switch, purity, log without secrets) |
| Bot → Channel | same integration spec (invitation on exactly the four report screens, off-switch, byte-identical statistics, menu actions still working) |
| Telegram and Bale independently | `src/bot/destination.service.spec.ts` (13 tests: hosts, keys, `@` normalization, missing config, token-free links, capabilities, invitation row) + `src/channel/channel-cta.spec.ts` (16 tests: per-platform keyboard, per-platform usernames, no button/failed send, caption vs separate text, media-only failure, deterministic output) |
| Fallbacks / missing config | destination spec, channel-cta spec, deep-link-flow spec, `test/bot-ux.e2e-spec.ts`, and the runtime rig (boot C with `BALE_BOT_USERNAME=''`) |
| API failure | `channel-cta.spec.ts` (`FAILED` → `ctaRoute: null`, media failure → text+CTA still delivered) |
| No token leakage | destination spec, channel-cta spec, cta-policy log test, runtime rig (wire + log scan) |
| Full Phase 1–5 regression | the whole existing suite (51 suites stay green) + `test/*.e2e-spec.ts` + the rig re-running the Phase 5 publication path |
| Configuration contract | `src/config/env.validation.spec.ts` (new “Phase 6 configuration” block: defaults, unusable usernames, malformed URL, override parsing/refusal, switchable flags, boots without Telegram) |
| Admin surface | `src/bot/content/content-cta.spec.ts` (8 tests: grammar, all seven choices, invalid choice, revision+approval reset, no-op, non-admin refusal, item view, help text) |

### 13.2 Test counts on the tree being reported on

| Command | Result |
| --- | --- |
| `npm ci` | ✅ install clean (lockfile unchanged) |
| `npx tsc -p tsconfig.json --noEmit` | ✅ 0 errors |
| `npx tsc -p tsconfig.build.json --noEmit` | ✅ 0 errors |
| `npm run build` | ✅ `nest build` OK |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ **57 suites / 884 tests passed** (Phase 5 closure: 51 / 781 → **+6 suites, +103 tests**) |
| `npm run test:e2e` | ✅ **5 suites / 36 tests passed** (Phase 5: 31 → **+5**) |
| `npm run test:cov` | ✅ statements **91.41 %**, branches **81.35 %**, functions **92.71 %**, lines **91.41 %** (Phase 5: 91.1 / 81.13 / 92.44 / 91.14) |
| `docker build` / container boot | ⚠️ **NOT RUN — no docker binary in this environment.** The Dockerfile and dependency files are unchanged in this phase; the Phase 5 image verification is unaffected, but no new docker claim is made here. |

### 13.3 §33 hard rules (quality) — status

| Rule | Status |
| --- | --- |
| No prototype / no fake functionality | ✅ every path is the production path |
| Never fabricate a result, a URL or a platform capability | ✅ links come only from configuration; capabilities are declared per platform and unverified claims are marked as such (§9) |
| Never bypass Phase 1 for prices | ✅ the phase reads no price itself |
| No duplicate notifications / publications | ✅ the Phase 5 idempotency key and duplicate guard were not touched |
| No infra additions without asking | ✅ no new service, no new dependency, no new pipeline |
| Strong typing, no `any`, no magic numbers | ✅ strict TS, route/label/limit constants are named |
| Diagnosable logs without secrets | ✅ one policy line at boot + one diagnostic line per unknown payload; no token anywhere |
| Deterministic behaviour | ✅ policy and URL builders are pure and covered by determinism tests |
| No claim without evidence | ✅ every number in this report is a command output produced on this tree |

---

## 14. Runtime Verification (real clock, real HTTP wire, real built artifact)

Rig: `/home/user/.tmp-p6-runtime/` (test-only, **outside** the repository, never committed). It runs the
**built** application (`dist/main.js`) against a real HTTP wire: an HTTPS server on :443 emulating both
Bot APIs (Host-based routing) and an HTTP server on :80 for the Phase 1 price API. Nothing inside the
application is patched.

Result: **39 checks / 39 PASSED**, across three real boots of the application:

* **Boot A** (both usernames configured): `/start` → welcome + main menu; `/start prices` → price screen;
  `/start GOLD` → gold screen (case-insensitive); `/start alert` → wizard asking for the symbol with the
  alert store still empty (0 → 0 alerts); `/start totally_unknown_route` → menu **and** a logged
  `Unknown start payload` diagnostic; `/start channel` → channel screen.
* **Real publication, two platforms** (through the real admin chat surface, real approval, real publisher):
  `/content new …` → `/content cta <id> alert` → `/content approve` → `/content publish` produced on the
  wire
  `{"inline_keyboard":[[{"text":"🔔 فعالسازی هشدار قیمت","url":"https://ble.ir/atabak_bale_bot?start=alert"}]]}`
  for Bale and
  `{"inline_keyboard":[[{"text":"🔔 فعالسازی هشدار قیمت","url":"https://t.me/atabak_telegram_bot?start=alert"}]]}`
  for Telegram, with the delivery records stating `bale:alert telegram:alert`.
  A second, unrelated educational item was published **without any button**, with records
  `bale:null telegram:null`.
* **Boot B** (`CHANNEL_CTA_ENABLED=false`): the same publication still went out on both platforms with
  **no** `reply_markup`.
* **Boot C** (`BALE_BOT_USERNAME=''`, Telegram configured): the Bale message went out with no button and
  no `ble.ir` string anywhere, while the Telegram message carried
  `https://t.me/atabak_telegram_bot?start=prices` — per-platform independence observed on the wire.
* **Leakage scan**: no token in any message text, caption or button; every button URL is a public
  `https://ble.ir/...` / `https://t.me/...` link; no token in the application log; the boot log line
  `Channel CTAs: enabled | PRICE_UPDATE: گروه نمادها … | EDUCATIONAL: بدون دکمه (پیشفرض) | …` is present.

---

## 15. Risks, Limitations and Untouched Areas

* **Live platform verification** (real Bale, real Telegram, real channel writes) is **NOT RUN** — no
  credentials are available to the agent and publishing to a production channel without authorization is
  forbidden. The manual checklist in §9 is the operator's step; everything else is verified against a
  wire-level emulation that uses the real request shapes.
* **Bale deep-link support** is implemented from Bale's documented behaviour (`ble.ir/<username>?start=…`
  delivered as `/start <parameter>`). It is implemented, not assumed at runtime: if Bale ever does not
  deliver the parameter, the user simply lands on the default start screen — no crash, no wrong feature.
* **`CHANNEL_URL` has a product default**, so the "no channel destination at all" state cannot be reached
  from a valid `.env`; the defensive explanation path is therefore covered by a unit-level assertion
  (clearly labelled as such in the test) instead of an unreachable integration scenario.
* **No analytics/attribution**: the phase deliberately adds no click tracking, no referral ids and no
  observability stack. The only new signals are the boot policy line, the unknown-payload diagnostic and
  the existing UX event log (`start_route`, `start_unknown_payload`).
* **Out of scope and untouched** (per §17): no new alert engine or price provider, no second market
  state, no AI/prediction/signals, no CRM/referrals, no analytics dashboard, no payments/premium, no
  microservices/brokers, no second publishing pipeline, no bot-framework rewrite.

---

## 16. Final Status

Every acceptance criterion of Phase 6 is implemented, documented and verified on this tree: the
channel→bot CTA (policy, per-platform URL, payload threading, per-destination record), the bot→channel
invitation and channel screen, the five deep-link routes with a safe parser, the security and failure
rules, the configuration contract with startup validation, the documentation, the required test scenarios
and the runtime verification. The only item that could not be executed here is live verification against
the real platforms, which is explicitly marked NOT RUN (with a manual checklist) rather than claimed.

PHASE 6 COMPLETE — READY FOR THE NEXT PHASE

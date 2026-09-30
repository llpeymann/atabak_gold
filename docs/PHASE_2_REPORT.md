# PHASE 2 REPORT — Bot UX (Atabak Gold)

**PHASE 2 RESULT: COMPLETE**

Repository: `github.com/llpeymann/atabak_gold` · branch `main` · base commit `daa22b6` (Phase 1)
Deliverable: **one commit on top of `daa22b6`** (the exact SHA/tree are reported in the hand-off message and in the header of `phase2-atabak-gold.patch`) · Date: 2026-09-30 · Timezone: Asia/Tehran

> Push status: **BLOCKED** (no repository credentials in this environment — see section 6). The full
> commit is shipped as `phase2-atabak-gold.patch` + `phase2-atabak-gold.bundle`, verified by
> re-applying the patch to the base commit and comparing Git tree hashes.

---

## 1. Repository Audit

Audit report: [`docs/PHASE_2_AUDIT.md`](./PHASE_2_AUDIT.md) (written before any code was changed).

Findings that shaped the implementation:

| # | Finding | Consequence |
| --- | --- | --- |
| A1 | Inbound updates were not consumed at all: the bot could only publish to the channel on a cron. | Phase 2 needed an inbound path; long-polling was chosen (webhook would add a public HTTP surface and infra that the scope forbids). |
| A2 | The only price source was `MarketEngineService` → `MarketStateService`; the external API is touched exclusively by `PriceService.fetchRawPayload`. | The UX layer was built as a **read-only projection** of the market state; no second price path, no recalculation. |
| A3 | `SECTION_TITLES` in `src/market/symbols.ts` already contained delivery markup (`🟨 <b>طلا</b>`). | The view model must carry **plain** titles (`SECTION_NAMES`), otherwise the formatter escapes them and users see literal tags. A rendering bug of exactly this class was caught in the live container run and fixed (section 8). |
| A4 | Persistence existed only for market state (atomic JSON + rename). | The user/favourite store reuses the same approach (`USER_DATA_FILE`) instead of introducing a database (explicitly out of scope). |
| A5 | Telegram support was outbound-only and `BaleService` was coupled to Bale's request shapes. | A platform abstraction (`src/platform/`) was introduced with Telegram + Bale adapters; **no business logic branches on platform**. |
| A6 | No user identity existed. | A minimal user model (`id`, `platform`, `platformUserId`, `createdAt`, `updatedAt`) with a unique identity per platform; no personal data is collected. |
| A7 | Scheduled publication, anomaly rejection and daily stats are Phase 1 assets. | They were left untouched except for the shared `DeliveryPlatform = Platform` type; all Phase 1 tests still pass. |

## 2. Architecture Changes

```
Inbound (new)                                  Outbound (unchanged Phase 1)
─────────────                                  ────────────────────────────
platform update                                PriceService → MarketEngine → MarketState
      │                                                     │
      ▼                                                     ▼
UpdatePollerService ──► PlatformRegistry                BotService (cron)
      │                        │                             │
      ▼                        ▼                             ▼
PlatformAdapter (Bale/Telegram)                    PriceMessageBuilder / Poster / BaleService
      │
      ▼
 BotUxService (router, sessions, callback grammar)
      │
      ├─► UserService ──► UserStore ──► USER_DATA_FILE (atomic JSON)
      ├─► MarketViewService ──► MarketStateService (READ ONLY)
      └─► ux-format / ux-keyboards ──► PlatformAdapter ──► BotApiClient (single HTTP layer)
```

New modules:

* `src/platform/` — `platform.types.ts` (platform-neutral model), `bot-api.client.ts` (the only HTTP
  layer for the Telegram-compatible Bot API: never throws, returns `{ok,result,error}`, redacts the
  token in every message, supports cancellation), `platform-adapter.ts` (edit-in-place with a send
  fallback, wire-format keyboards, command parsing), `platform-registry.service.ts` (Bale always,
  Telegram only when fully configured), `update-poller.service.ts` (long-poll loop with offset
  tracking, retry/backoff on failure, `AbortController` cancelled on shutdown).
* `src/users/` — `user.types.ts`, `user.store.ts` (atomic JSON document, serialized write chain,
  tolerant load), `user.service.ts` (registry validation, `MAX_FAVORITES`, idempotent add,
  per-user scoping).
* `src/bot/ux/` — `callback-data.ts` (`v1:` grammar + parser), `ux-view.types.ts`,
  `market-view.service.ts`, `ux-format.ts`, `ux-keyboards.ts`, `ux-event-log.service.ts`,
  `bot-ux.service.ts` (router + screen rendering + safe invalid-callback screen).

Wiring: `AppModule` provides the new services; `main.ts` awaits `UserStore.ensureLoaded()` before the
application starts serving (so favourites are available before the first interaction). `env.validation.ts`
/ `app-config.service.ts` gained the Phase 2 variables with typed getters; `.env.example` and `README`
document them.

Deliberate decisions (documented, not accidents):

* **Long-polling instead of webhooks** — no public endpoint, no new infrastructure, one process.
* **Edit-in-place is an optimisation, never a dependency** — the adapter falls back to `sendMessage`
  when a platform rejects an edit; the router never assumes an editable message.
* **Presentation separated from domain** — the view model is plain data; every Persian string lives in
  `ux-format.ts`; the router only decides *what* to show.
* **Sessions are in memory only** (navigation state may reset on restart — stated in the acceptance
  criteria); persistence is reserved for users and favourites.

## 3. Features Implemented

| Feature | Behaviour | Evidence |
| --- | --- | --- |
| `/start` → main menu | Persian welcome + 8 buttons: 💰 قیمت لحظهای، 🟡 طلا، 🪙 سکه، 📊 بازار، 🔔 هشدار، ⭐ علاقهمندیها، 📢 کانال اتابک | `bot-ux.service.spec.ts`, e2e, live container transcript |
| 💰 Live prices | All registry symbols with prices, change direction/percentage, last-update time (Asia/Tehran), stale notice, `↻ بروزرسانی` | `market-view.service.spec.ts`, `ux-format.spec.ts`, live transcript |
| Refresh | Re-reads **only** the market state; never calls the price API | `market-flow.integration.spec.ts` (§55), e2e |
| 🟡 Gold / 🪙 Coins | Real registry sections only; missing instruments listed explicitly as unavailable — never fabricated | `bot-ux.service.spec.ts`, live transcript (`ℹ️ بدون اطلاعات معتبر: …`) |
| 📊 Market | Daily snapshot per symbol: open / high / low / current / change / last update. No indicators, no predictions | `market-view.service.spec.ts`, `ux-format.spec.ts` |
| ⭐ Favourites | Toggle-style management keyboard (`☐`/`☑`), list with live prices, `⚙️ مدیریت علاقهمندیها`, `📌 n از m مورد انتخاب شده است.` | `user.service.spec.ts`, `favorites.integration.spec.ts` (§54), e2e, live restart test |
| 🔔 Alerts | Placeholder screen only: `این قابلیت بهزودی فعال میشود.` + exactly `['⬅️ بازگشت','🏠 منوی اصلی']` | `bot-ux.service.spec.ts` |
| 📢 Channel | URL button to `config.channelUrl`; no duplicated URL literals (single source: config/constants) | `bot-ux.service.spec.ts`, `ux-keyboards.ts` |
| Stale / empty / error UX | `⚠️ آخرین قیمت معتبر…`; per-screen empty texts; errors show `دریافت اطلاعات بازار با مشکل مواجه شد` while the technical detail stays in the server log; no zero/null substitution ever | `bot-ux.service.spec.ts`, `market-flow.integration.spec.ts` |
| Invalid / outdated buttons | `این گزینه دیگر معتبر نیست.` + `🏠 منوی اصلی`; logged as `event=invalid_callback`; never crashes | unit, e2e, live container (button from a "previous version") |
| Event logging | `start`, `menu_open`, `prices_view`, `gold_view`, `coin_view`, `market_view`, `favorites_view`, `favorite_added`, `favorite_removed`, `channel_clicked`, `alerts_clicked` — no personal data, no dashboards | `ux-event-log.service.ts`, `bot-ux.service.spec.ts` |
| Markup integrity guard | Every rendered screen is validated: no escaped tags (`&lt;b&gt;`), no nested emphasis, balanced tags | `markup-integrity.spec.ts` (15 tests) |

## 4. Persistence

* One additional file: `USER_DATA_FILE` (default `./data/users.json`, `''` disables persistence).
  Document `version:1`, `users[]`, `favorites[]` with `symbol`; favourites are keyed `userId::symbol`
  (**UNIQUE**) and written through a serialized chain (read-modify-write is never interleaved).
* Atomic write (temporary file + `rename`), tolerant load (missing file → log + empty store, corrupt
  file → warning + empty store, never a crash), no second database, no schema migration machinery.
* Restart semantics (verified in the live container test): **users and favourites survive**; navigation
  state does not (in memory); market state keeps its Phase 1 behaviour.

## 5. Files Changed

Base `daa22b6` → the Phase 2 commit, 43 paths in the change set: 30 new files, 13 modified, 0 deleted.
The deliverable is reproducible from the base commit with `git am phase2-atabak-gold.patch` (verified) or `git clone phase2-atabak-gold.bundle` (verified, same tree).

New (source): `src/users/{user.types,user.store,user.service}.ts`,
`src/platform/{platform.types,bot-api.client,platform-adapter,platform-registry.service,update-poller.service}.ts`,
`src/bot/ux/{callback-data,ux-view.types,market-view.service,ux-format,ux-keyboards,ux-event-log.service,bot-ux.service}.ts`.
New (tests/docs): `src/users/{user.store,user.service}.spec.ts`,
`src/platform/{bot-api.client,platform-adapter,update-poller.service}.spec.ts`,
`src/bot/ux/{callback-data,ux-format,market-view.service,bot-ux.service,markup-integrity,favorites.integration,market-flow.integration}.spec.ts`,
`test/bot-ux.e2e-spec.ts`, `docs/PHASE_2_AUDIT.md`, `docs/PHASE_2_REPORT.md`.

Modified: `src/app.module.ts`, `src/main.ts`, `src/config/env.validation.ts`,
`src/config/app-config.service.ts`, `src/bale/delivery-result.ts`, `src/market/symbols.ts`,
`src/testing/test-doubles.ts`, `test/setup-env.ts`, `README.md`, `.env.example`,
`src/market/{market-engine.integration,market-state.service,symbols}.spec.ts` (spec-only adjustments:
platform-neutral type imports and the audit-verified `SECTION_NAMES` assertion).

Unchanged by design: the whole Phase 1 pipeline (`src/price/`, `src/market/market-engine*`,
`market-state*`, `anomaly-alert.service.ts`, `src/bot/bot.service.ts`, `price-message.builder.ts`,
`src/poster/`, `src/bale/bale.service.ts`) — behaviour preserved, all its tests green.

## 6. Tests

| Gate | Command | Result |
| --- | --- | --- |
| Dependencies | `npm ci` | **PASS** (clean install from `package-lock.json`) |
| Build | `npm run build` (`nest build`) | **PASS** (also `tsc --noEmit` clean) |
| Lint | `npm run lint` | **PASS** (0 errors, 0 warnings) |
| Unit + integration | `npx jest` | **PASS** — 32 suites / 352 tests |
| End-to-end | `npx jest --config ./test/jest-e2e.json` | **PASS** — 2 suites / 9 tests |
| Docker build | `sudo docker build -t atabak-gold .` | **PASS** |
| Runtime smoke (extra) | `docker run` + mocked Bale/price APIs | **PASS** — see below |
| Push | `git push origin main` | **BLOCKED** — `fatal: could not read Username for 'https://github.com'`; remote `HEAD` is still `f2ba8e0d`. Not skipped: `phase2-atabak-gold.patch` + `.bundle` were produced and verified to reproduce the byte-identical tree (section 5) (via `git apply` **and** `git am`). |

### 6.1 Test inventory (Phase 2 focus)

* `callback-data.spec.ts` — grammar round-trip, symbol validation, unknown/oversized payloads rejected.
* `ux-format.spec.ts` (25) — price/percentage/absolute-change/timestamp/snapshot formatting, Persian
  digits, Rial/Tooman units, stale and empty texts, error text without technical detail.
* `market-view.service.spec.ts` — read-only projection, registry order, missing symbols, stale flag,
  favourites view, market (daily) view.
* `bot-ux.service.spec.ts` (44) — every screen, keyboard layout, navigation stack, invalid callback,
  empty states, error path, per-user isolation, `MAX_FAVORITES`.
* `user.store.spec.ts` / `user.service.spec.ts` (43) — atomic persistence, corrupt/missing file,
  idempotent add, UNIQUE per user+symbol, cap enforcement, removal, cross-user isolation.
* `bot-api.client.spec.ts` (15) — token redaction, `HTTP <status>` errors, unparsable update tolerance,
  poll vs delivery timeouts (35 s / 1.5 s asserted), `AbortSignal` propagation.
* `update-poller.service.spec.ts` (6) — offset accounting, resilience when one update throws,
  disabled polling, shutdown abort.
* `favorites.integration.spec.ts` (§54) — favourites survive a rebuilt store; no duplicates; isolation.
* `market-flow.integration.spec.ts` (§55) — the price screen is served from the Phase 1 pipeline; the
  provider double records **zero** calls while a user navigates, refreshes, or hits an error; a rejected
  anomalous price never reaches the screen.
* `markup-integrity.spec.ts` — 15 scenarios; fails on the pre-fix code (negative control: 6 failures),
  passes after the fix.
* `test/bot-ux.e2e-spec.ts` (§57, 9 tests) — full `AppModule` boot with only `HttpService` doubled:
  `/start` menu, full first-time journey, edit-in-place (exactly one `editMessageText`), favourites
  persisted across a rebuilt application, no price-API call from the interaction path, outdated button,
  Phase 1 channel publication regression.
* §56 regressions: `test/app.e2e-spec.ts` and all Phase 0/1 suites stay green (20 suites / 177 tests
  from Phase 1 remain a subset of the current 348).

### 6.2 Runtime smoke test (real container, mocked platforms)

The built image was run against a mocked Bale Bot API (HTTPS, certificate trusted via
`NODE_EXTRA_CA_CERTS`) and a mocked price API, with a scripted user conversation:

| # | What was driven | Observed |
| --- | --- | --- |
| 1 | `/start` | welcome text + the 8-button main menu |
| 2 | `v1:screen:prices` | one `editMessageText` in place, prices from the seeded market state, `🕐 آخرین بروزرسانی: ۱۴:۳۰`, missing instruments listed explicitly |
| 3 | `v1:screen:gold` | gold-only screen, same in-place edit |
| 4 | `v1:fav:add:IR_GOLD_18K` | management keyboard with `☑ 🟡 طلای ۱۸ عیار`, `✅ انتخابشده: ۱ از ۱۰` |
| 5 | `v1:back` | favourites list with the price and `📌 ۱ از ۱۰ مورد انتخاب شده است.` |
| 6 | `v1:this-button-is-old` | `این گزینه دیگر معتبر نیست.` + `🏠 منوی اصلی`, no crash |
| 7 | `docker rm -f` + new container, same volume, `/start` + favourites screen | favourites still there (persistence across a real restart) |
| 8 | scheduled publication (cron) | at 15:30 Tehran the Phase 1 chain fetched prices, approved 10 symbols, logged `7 symbol(s) not published` with reasons (`UNKNOWN_SYMBOL`, `MISSING_SYMBOL` — never fabricated) and delivered the report to the channel id through the same mocked Bot API: Phase 1 publishing is untouched |
| 9 | Price-API calls during steps 1–7 | zero (only the scheduled cycle touched the provider) |
| 10 | 📊 بازار / 🪙 سکه / 🔔 هشدار / 📢 کانال screens | daily snapshot (شروع روز / اکنون / بیشترین / کمترین / تغییر), section screen without a duplicated header, alerts placeholder, channel CTA — all rendered in place |
| 11 | favourite toggle on/off (`fav:add:USD`, `fav:remove:USD`) | `✅ انتخابشده: ۱ از ۱۰ → ۲ از ۱۰ → ۱ از ۱۰`, list updated accordingly |
| 12 | second platform user (7002) opening favourites | `هنوز موردی به علاقهمندیها اضافه نکردهاید.` while user 7001 has one → live cross-user isolation |

## 7. Test Coverage

```
Statements : 92.75% (1806/1947)     Branches : 83.46% (1050/1258)
Functions  : 94.87% ( 370/390)      Lines    : 92.75% (1742/1878)

src/bot/ux    98.56% stmts / 86.08% branches      (router 97.38%, formatter 100%)
src/users     95.17% stmts / 86.15% branches
src/platform  90.70% stmts / 78.12% branches      (bot-api 94.82%, poller 83.33%)
```

Phase 1 coverage was 91.23% statements / 84.21% branches; Phase 2 raised statements while adding
~5.3k lines of new source, so no asset was traded away for the new features.

## 8. Behavioral Changes

1. The bot now **receives** user updates (long-polling) — previously it was publish-only. Controlled by
   `BOT_POLLING_ENABLED`; disabling it restores the exact Phase 1 behaviour (publishing keeps working).
2. New files are written: `USER_DATA_FILE` (default `./data/users.json`).
3. `AppModule` startup now waits for the user store to load. A corrupt/missing file logs and continues.
4. Outbound channel messages are byte-identical to Phase 1 (asserted by `price-message.builder.spec.ts`);
   the shared `DeliveryPlatform` type was aliased to `Platform` (type-level only).
5. **Rendering fix found by the live run:** section titles reached the formatter with their own markup,
   producing `&lt;b&gt;…&lt;/b&gt;` (literal tags) in every price/favourites screen. Fixed by splitting
   `SECTION_NAMES` (plain, used by the UX view model) from `SECTION_TITLES` (delivery markup, unchanged
   Phase 1 output), plus a permanent guard (`markup-integrity.spec.ts`) that fails on escaped tags,
   nested emphasis or unbalanced tags in any rendered screen.
6. Single-section screens no longer repeat their section title: `🟡 طلا` / `🪙 سکه` used to print the
   screen title *and* the identical section header. The formatter gained an explicit
   `includeSectionTitles` option (multi-section screens such as `💰 قیمت لحظهای` and the favourites
   list keep their headers).
7. Shutdown no longer hangs on a long poll: an `AbortController` cancels in-flight polling on destroy.
8. The `↻ بروزرسانی` button re-renders the current screen (it previously only acknowledged the tap).

## 9. Security

* No cross-user access: favourites are always scoped by the resolved internal user id; the owner of a
  callback is never trusted (the platform user id comes from the update, and screens are rebuilt from
  persisted state each time).
* Every callback payload is validated (version, action, symbol regex); unknown or oversized payloads
  cannot reach a handler and produce the safe "این گزینه دیگر معتبر نیست." screen.
* All price/symbol data is escaped before insertion into HTML messages; the markup guard prevents a
  future regression from leaking tags.
* Technical errors never reach users; they are logged with the token redacted (`***`) and URLs/handles
  kept out of user-facing text.
* No personal data is collected (no names, no phone numbers, no message history); event logs carry only
  the internal user id and the action.
* Tokens come only from environment variables; `.env` stays git-ignored and was **not** committed.

## 10. Remaining Issues

| # | Item | Impact | Status |
| --- | --- | --- | --- |
| R1 | `git push` — no credentials in this environment | Remote `main` still at the Phase 1 commit | **BLOCKED** — patch + bundle delivered, verified |
| R2 | `update-poller.service.ts` long-loop body (lines 122–139) is not covered by unit tests | Low; the loop was exercised in the container run | Open, documented (test-only gap) |
| R3 | `USDT_IRT` is labelled `تتر (فی)` in the Phase 1 registry | Wording only; no fabrication | Open — Phase 1 data, deliberately unchanged |
| R4 | Polling has no jitter/backoff cap beyond the fixed retry delay | Low | Documented for Phase 3 hardening |

## 11. Out-of-Scope Items (untouched, no accidental implementation)

Alerts engine · sales/orders · marketing, referral, campaigns, lead capture · AI/ML, predictions,
signals · admin dashboard/CRM · portfolio · microservices, Kafka, Redis, RabbitMQ, queues, new
databases · i18n beyond Persian · web UI.

## 12. Definition of Done

| # | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Inbound user interaction works (menu, navigation, edit-in-place) | PASS | e2e + live container transcript |
| 2 | All screens implemented (prices, gold, coins, market, favourites, alerts placeholder, channel) | PASS | specs + live transcript |
| 3 | Prices come only from the Phase 1 market state; zero external API calls from the UX path | PASS | `market-flow.integration.spec.ts`, e2e, live run (0 provider calls) |
| 4 | No fabricated/estimated prices; missing instruments shown as unavailable | PASS | `bot-ux.service.spec.ts`, live transcript |
| 5 | Stale prices are marked and never presented as fresh | PASS | `ux-format.spec.ts`, `bot-ux.service.spec.ts`, integration |
| 6 | Favourites: add/remove/list, no duplicates, cap enforced, invalid symbols rejected | PASS | `user.service.spec.ts` (43) |
| 7 | Favourites persist across restart | PASS | `favorites.integration.spec.ts`, e2e, live container restart |
| 8 | Strict user isolation (no cross-user visibility) | PASS | `user.service.spec.ts`, `bot-ux.service.spec.ts` |
| 9 | Callback design: short, deterministic, validated; invalid → safe screen, never a crash | PASS | `callback-data.spec.ts`, e2e, live run |
| 10 | Central formatting utilities; no scattered unit conversions | PASS | `ux-format.ts`, `ux-format.spec.ts` (no `price / 10` outside `money.ts`) |
| 11 | Error UX hides technical detail; empty states are intentional | PASS | `bot-ux.service.spec.ts` |
| 12 | Alerts is a placeholder only (no engine, no scheduler, no notifications) | PASS | keyboard/text assertions |
| 13 | Channel CTA centralised in config | PASS | `ux-keyboards.ts`, config getters |
| 14 | Persian UX, Asia/Tehran timestamps, readable numbers, consistent emojis | PASS | formatter specs + live transcript |
| 15 | Base event logging, no personal data | PASS | `ux-event-log.service.ts` |
| 16 | Persistence reuses the atomic-JSON approach (no second DB) | PASS | `user.store.spec.ts` |
| 17 | Phase 1 behaviour preserved (publishing, delivery, validation, anomalies, stats) | PASS | Phase 1 suites green + live cron publication |
| 18 | Architecture: presentation separated from domain; platform abstraction without business branching | PASS | module layout, adapter specs |
| 19 | Configurable, documented limits (no magic numbers) | PASS | `.env.example`, README, `env.validation.ts` |
| 20 | `npm ci` | PASS | section 6 |
| 21 | `npm run build` | PASS | section 6 |
| 22 | `npm run lint` | PASS (0 errors) | section 6 |
| 23 | `npx jest` | PASS (32 suites / 352 tests) | section 6 |
| 24 | `npm run test:e2e` | PASS (2 suites / 9 tests) | section 6 |
| 25 | `docker build` | PASS | section 6 |
| 26 | Commit created | PASS | one commit on `daa22b6`; SHA reported in the hand-off |
| 27 | Push to origin | **BLOCKED** | no credentials; patch + bundle delivered |

## 13. Phase 3 Readiness

All Phase 2 requirements are implemented, verified and green; the only non-pass is the environment-bound
`git push` (patch + bundle provided). The alert placeholder, the event log and the persistence layer are
the intended seams for the Phase 3 alerts engine.

**PHASE 2 COMPLETE — READY FOR PHASE 3**

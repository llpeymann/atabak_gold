# PHASE 0 — PROJECT AUDIT (atabak_gold)

> Internal audit performed before any modification, as required by **Step 1** of the Phase 0 instructions.
> Repository: `github.com/llpeymann/atabak_gold` · Commit audited: `f2ba8e0` (`main`) · Audit date: 2026-09-30

---

## 1. Current architecture

Single NestJS 11 application (`talaye-atabak`) with four feature services wired in one root module and no HTTP business routes:

```
PriceService ──► BotService ──► BaleService ──► Bale API  (tapi.bale.ai)
 (Axios/HTTP)     (Cron)          (HTTP)     └─► Telegram API (api.telegram.org)
                       │
                       └──────► PosterService (plain-text poster builder)
```

* `AppController` / `AppService` exist but are **not registered**, so the application exposes no routes at all.
* State is in-memory only (`BotService.lastPrices: Map`). No database, no Redis, no queue (out of scope for Phase 0 too).

## 2. Application entry point

`src/main.ts` — `NestFactory.create(AppModule)`, listen on `process.env.PORT || 3000` bound to `0.0.0.0`, `console.log` of the URL. No graceful-shutdown hooks, no startup error handling.

## 3. Current NestJS modules

* `ConfigModule.forRoot({ isGlobal: true })` — no validation whatsoever.
* `HttpModule` (from `@nestjs/axios`) — global Axios instance, no default timeout.
* `ScheduleModule.forRoot()` — enables `@Cron` decorators.
* No `controllers`, no feature modules; all four services are declared as `providers` of `AppModule`.

## 4. Current services

| Service | Responsibility | Notes |
| --- | --- | --- |
| `PriceService` | `GET PRICE_API_URL` via Axios, `timeout: 60000`, browser User-Agent header, returns `response.data` as `any`. | No retry, no response validation (only `null` check at caller). |
| `BotService` | 3 cron definitions, message formatting (`formatMessage`), trend emoji via `lastPrices`, HTML escaping. | Contains the logic bugs fixed in Phase 0. |
| `BaleService` | `sendMessage(chatId, text, parseMode)` and `sendPhotoBuffer(...)`; posts to Bale + Telegram; converts `<b>` → `<strong>`; `Promise.allSettled`. | Errors swallowed inside promises → caller always sees success. |
| `PosterService` | `generatePricePoster(data)` builds a Markdown-ish text poster. | `async` without `await`; hard-codes «ریال»; hard-codes `@atabak_gold`. |

## 5. Current dependencies

**Runtime:** `@nestjs/axios`, `@nestjs/common`, `@nestjs/config`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/schedule`, `axios`, `form-data`, `reflect-metadata`, `rxjs`.
**Dev:** Nest CLI/schematics/testing, eslint 9 stack, jest 30 + ts-jest, supertest, typescript 5.7, ts-node, ts-loader, source-map-support, globals.

* `form-data` is imported **only** by `BaleService.sendPhotoBuffer` (dead code).
* `canvas` was previously a dependency and was removed from `package.json` (see commit `2c464f9`), yet its native libraries (`libcairo2`, `libpango-1.0-0`, …) are still installed in the Docker runtime stage.

## 6. Current npm scripts

`build` (nest build), `format`, `start`, `start:dev`, `start:debug`, `start:prod` (`node dist/main`), `lint` (`eslint "{src,apps,libs,test}/**/*.ts" --fix`), `test`, `test:watch`, `test:cov`, `test:debug`, `test:e2e`.

## 7. Current environment variables

| Variable | Used by | Required today |
| --- | --- | --- |
| `PRICE_API_URL` | `PriceService` | yes (but only fails when a cron runs) |
| `BALE_BOT_TOKEN` | `BaleService` | yes |
| `BALE_CHANNEL_ID` | `BotService` | yes (constructor only logs an error) |
| `TELEGRAM_BOT_TOKEN` | `BaleService` | optional |
| `TELEGRAM_CHANNEL_ID` | `BaleService` | optional |
| `PORT` | `main.ts` | optional (default 3000) |

No `.env` file is committed (good) and **no `.env.example` exists**.

## 8. Current cron jobs

| # | Decorator | Schedule (Asia/Tehran) | Method | Publishes |
| --- | --- | --- | --- | --- |
| 1 | `@Cron('0 0,30 8-21 * * *')` | every 30 min, 08:00→21:30 | `handleCron` | price list message |
| 2 | `@Cron('0 0 22 * * *')` | 22:00 | `handleCron` (second decorator on same method) | price list message |
| 3 | `@Cron('0 0 12,16,19 * * *')` | 12:00 / 16:00 / 19:00 | `sendPricePoster` | poster text |

**Overlap:** jobs 1 and 3 fire in the same minute at 12:00, 16:00 and 19:00 → the channel receives two messages at once. This overlap has existed since the poster job was introduced (`git log` shows the same `0 0 12,16,19` schedule when the poster was still an image).

## 9. Current timezone handling

All three crons carry `timeZone: 'Asia/Tehran'` (explicit, good). But the *displayed* date/time is built with `toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' })`, while `PosterService` uses `fa-IR` with an explicit timezone too — consistent today, yet duplicated in several places (no single source of truth).

## 10. Current price API flow

`BotService` → `PriceService.getPrices()` → `httpService.get(url, { timeout: 60000, headers })` → `firstValueFrom` → returns `response.data` untyped. On error it logs and throws a generic `Error('Could not fetch market data from API')`. **No retry, no timeout configuration per-request, no shape validation, no distinction between retryable and permanent failures.**

## 11. Current price parsing

None. The raw payload is used directly; `formatMessage` reads `data.gold` / `data.currency` with `Array.isArray`-free access (`data?.gold || []`) and looks up items by `symbol`. Numeric coercion happens per item inside the formatter (`Number(item.price)`, `Number.isNaN` → `'---'`).

## 12. Current price formatting

`BotService.formatMessage` + `PosterService.generatePricePoster` — duplicated logic with divergent unit labels:

* price list: header `💰 ارز (تومان)` but the per-line unit comes from the API field `item.unit` (may be empty).
* poster: hard-coded `ریال` for the same values.

Both use `toLocaleString('fa-IR')`. Percent value is printed raw with no rounding.

## 13. Current Bale delivery flow

`BaleService.sendMessage(chatId, text, 'HTML')` builds `firstValueFrom(this.httpService.post(<bale>/sendMessage, {...}))`, appends a `.then(log)`, `.catch(err => log)`, pushes into an array and returns `Promise.allSettled(...)`. The `.catch()` **returns normally**, so every entry of `allSettled` is `fulfilled` — failures are invisible to the caller. No request timeout (Axios default = none).

## 14. Current Telegram delivery flow

Same method: sends the same text to `TELEGRAM_CHANNEL_ID` when both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` are configured. Telegram uses the `chatId` of its own channel (correct), Bale uses the passed `chatId`. Same swallow-error pattern.

## 15. Current error handling

* `PriceService` — logs and rethrows a generic error.
* `BaleService` — swallows delivery errors (returns resolved promises).
* `BotService` — `try/catch` per cron that logs `❌ ...` **(but then unconditionally logs `✅ Market update sent successfully.` inside the same try block, before knowing whether delivery worked)**.
* `main.ts` — no handling of startup failure.

## 16. Current logging

`@nestjs/common` `Logger` per service; emoji-prefixed messages. Secrets are not logged today, but the price API URL (which may contain an API key in its query string) is logged verbatim on HTTP error (`Status: ... Data: ...` includes the response only, but `error.message` may contain the URL).

## 17. Current Docker behavior

`dockerfile` (lower-case) — two stages:

* **Builder:** `node:22-bullseye-slim`; rewrites `sources.list` to `linux-mirror.liara.ir`; installs `python3 make g++`; `npm install`; `npm run build`.
* **Runtime:** `python:3.11-slim-bullseye`; rewrites mirrors again; `apt-get install nodejs libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2`; copies `dist`, **the whole `node_modules` (including dev dependencies)** and the entire build context; runs `pip install --no-cache-dir -r requirements.txt` — **a file that does not exist in the repository** (it was never committed; the only Python file, `scripts/generate_chart.py`, was deleted in `2fddce2`).

`docker-compose.yml` builds `.` with `env_file: .env`, publishes `3000:3000`.

**Verified failure (baseline):** `docker build .` aborts with `ERROR: failed to solve: process "/bin/sh -c apt-get update && apt-get install -y python3 make g++ …" did not complete successfully: exit code: 100`.

## 18. Current test setup

* `jest` (rootDir `src`, testRegex `.*\.spec\.ts$`) → **zero spec files exist** → `npm test` exits 1 with “No tests found”.
* `test/app.e2e-spec.ts` (supertest) expects `GET /` → 200 `Hello World!`, but `AppController` is not registered → **404, test fails**.

## 19. Current lint status

`npx eslint "{src,test}/**/*.ts"` → **113 problems (111 errors, 2 warnings)**: ~53 auto-fixable Prettier errors, the rest `@typescript-eslint/no-unsafe-*` on `any` values, plus `require-await` in `PosterService` and `no-floating-promises` in `main.ts`.

## 20. Current TypeScript strictness

`tsconfig.json`: `strict` **not** set → `noImplicitAny: false`, `strictBindCallApply: false`, `strictNullChecks: true`, `noFallthroughCasesInSwitch: false`. `tsconfig.build.json` only excludes `test`, `dist`, `**/*spec.ts`. Compilation succeeds with no diagnostics.

## 21. Dead code

| Item | Evidence |
| --- | --- |
| `BaleService.sendPhotoBuffer` + `BaleService.executeSendPhoto` | zero references in the whole repo (`grep -rn sendPhotoBuffer src/` → only the definition). Last caller removed in commit `a10f0c4`. |
| `form-data` dependency | imported only by the method above. |
| `src/price/price.interface.ts` `MarketData.cryptocurrency` | never read. |
| `src/app.controller.ts` / `src/app.service.ts` | present but unreachable (not registered). |
| Cairo/Pango/JPEG libraries + `python3 make g++` in Docker | leftovers of the removed `canvas` / Python chart pipeline. |

## 22. Unused assets

`assets/` (~1.3 MB): `Vazir.ttf`, `ANDLSO.TTF`, `atabakGoldLogo.png`, `chartBg.png` (3508×2480), `posterBg.png` (1080×1080). **No reference to `assets/` exists anywhere in `src/`, `test/`, scripts or `package.json`.** They were used by the deleted `canvas` poster service and the deleted Python chart script. They are branding material (logo, fonts, poster backgrounds) → audited as *not runtime-required*, but **retained in the repository** to avoid losing brand assets; they are excluded from the production image because the runtime stage only copies `dist/`, `node_modules/` and `package.json`.

## 23. Temporary files

* `temp/daily_chart_test.png` (166 KB) — output artifact of the deleted Python chart test. Not referenced by any code.
* `daily-prices.json` (repository root) — data file written by the deleted `PriceStorageService` (`src/price-storage/`, removed in `d493a35`). Not read or written anymore; also listed in `.dockerignore`. Stale runtime data committed to git.
* `.env` — absent (correctly git-ignored).

## 24. Known bugs

1. `docker build` fails (baseline reproduced) → image cannot be produced.
2. Even if built: runtime stage ships **Node 12** (Debian bullseye `apt` default) while NestJS 11 requires Node ≥ 20 and the emitted JS uses optional chaining / nullish coalescing → `SyntaxError` at startup.
3. `/health` and `/` do not exist; `AppController` unregistered; e2e test fails.
4. Delivery failures are swallowed → `✅ Market update sent successfully.` is logged even when nothing was delivered.
5. Cron overlap at 12:00 / 16:00 / 19:00 → duplicate publication in the same minute.
6. Rial/Toman ambiguity: «(تومان)» header vs. hard-coded «ریال» poster for the same API values.
7. `lastPrices` never resets → the first message of a new day is compared with the previous day's price, producing a false 🔺/🔻.
8. `package-lock.json` is missing (deleted in commit `06d84d2`… history) → builds are not reproducible; `npm ci` unavailable.
9. No startup validation: a missing `PRICE_API_URL` is only discovered when a cron fires.
10. No timeout on delivery calls (`Axios` default = infinite) — a hung request can stall the cron.
11. Branding: poster advertises `@atabak_gold` while the real channel is `@tala_atabak`; poster uses Markdown `*bold*` while it is published with `parse_mode: HTML` (asterisks are rendered literally).
12. `PosterService.generatePricePoster` is `async` without `await`.
13. Log text in `BotService` says `CHANNEL_ID is not configured` although the variable is `BALE_CHANNEL_ID`.

## 25. Files that need modification

`dockerfile` (→ `Dockerfile`), `docker-compose.yml`, `.dockerignore`, `.gitignore`, `package.json`, `tsconfig.json`, `eslint.config.mjs` (only if required), `README.md`, `src/main.ts`, `src/app.module.ts`, `src/app.controller.ts`, `src/app.service.ts`, `src/price/price.service.ts`, `src/price/price.interface.ts`, `src/bale/bale.service.ts`, `src/bot/bot.service.ts`, `src/poster/poster.service.ts`, `test/app.e2e-spec.ts`, `test/jest-e2e.json`.

New files required by Phase 0: `Dockerfile`, `.env.example`, `src/config/*` (env validation + typed config), `src/common/*` (money, branding, timezone, log safety), `src/bot/trend-tracker.ts`, `src/bot/price-message.builder.ts`, `src/bale/delivery-result.ts`, unit specs, `docs/*`.

## 26. Files that can be safely removed

| Path | Reason |
| --- | --- |
| `temp/daily_chart_test.png` (+ the `temp/` directory) | artifact of the deleted Python pipeline, unreferenced. |
| `daily-prices.json` | data of the deleted `PriceStorageService`, unreferenced. |
| `dockerfile` | replaced by a conventional, correct `Dockerfile`. |
| Dead methods in `src/bale/bale.service.ts` (`sendPhotoBuffer`, `executeSendPhoto`) + the `form-data` import/dependency | verified unreferenced. |

**Not removed (deliberately):** `assets/*` — brand material (logo/fonts/backgrounds). Not needed at runtime, so excluded from the production image, but kept in the repository pending a decision on the future poster/chart pipeline.

---

### Baseline command results (Step 2)

| Command | Baseline result |
| --- | --- |
| `npm install` | OK (691 packages), `package-lock.json` generated (was missing) |
| `npm run build` | OK |
| `npm run lint` | **FAIL** — 113 problems (111 errors, 2 warnings) |
| `npm test` | **FAIL** — no tests found (exit 1) |
| `npm run test:e2e` | **FAIL** — 1 failing (`GET /` → 404) |
| `docker build .` | **FAIL** — exit code 100 at `apt-get update` (mirror unreachable), before reaching the missing `requirements.txt` |

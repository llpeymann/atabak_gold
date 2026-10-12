import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';

import { AlertEngineService } from './alerts/alert-engine.service';
import { AlertNotificationService } from './alerts/alert-notification.service';
import { AlertService } from './alerts/alert.service';
import { AlertStore } from './alerts/alert.store';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BaleService } from './bale/bale.service';
import { BotService } from './bot/bot.service';
import { PriceMessageBuilder } from './bot/price-message.builder';
import { BotUxService } from './bot/ux/bot-ux.service';
import { MarketViewService } from './bot/ux/market-view.service';
import { UxEventLogService } from './bot/ux/ux-event-log.service';
import { AppConfigService } from './config/app-config.service';
import { MarketIntelligenceService } from './intelligence/market-intelligence.service';
import { validateEnvironment } from './config/env.validation';
import { AnomalyAlertService } from './market/anomaly-alert.service';
import { MarketEngineService } from './market/market-engine.service';
import { MarketStateService } from './market/market-state.service';
import { MarketStateStore } from './market/market-state.store';
import { PriceNormalizer } from './market/price-normalizer.service';
import { RawPayloadParser } from './market/raw-payload.parser';
import { SanityChecker } from './market/sanity-checker.service';
import { PosterService } from './poster/poster.service';
import { PriceService } from './price/price.service';
import { BotApiClient } from './platform/bot-api.client';
import { PlatformRegistry } from './platform/platform-registry.service';
import { UpdatePollerService } from './platform/update-poller.service';
import { UserService } from './users/user.service';
import { UserStore } from './users/user.store';

@Module({
  imports: [
    // `validate` runs during startup: a missing/invalid required variable aborts the boot
    // with a clear message instead of failing later inside a cron execution.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    HttpModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AppConfigService,
    BaleService,
    // Market reliability pipeline (Phase 1).
    RawPayloadParser,
    PriceNormalizer,
    SanityChecker,
    MarketStateStore,
    MarketStateService,
    AnomalyAlertService,
    MarketEngineService,
    // Provider + publishers.
    PriceService,
    PosterService,
    PriceMessageBuilder,
    BotService,
    // Phase 2 — user-facing bot UX.
    UserStore,
    UserService,
    BotApiClient,
    PlatformRegistry,
    // Phase 4 — market intelligence (read-only projection of the Phase 1 state).
    MarketIntelligenceService,
    MarketViewService,
    UxEventLogService,
    BotUxService,
    UpdatePollerService,
    // Phase 3 — price alerts (evaluation, persistence, delivery).
    AlertStore,
    AlertService,
    AlertNotificationService,
    AlertEngineService,
  ],
})
export class AppModule {}

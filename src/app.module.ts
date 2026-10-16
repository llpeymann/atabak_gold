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
import { BotDestinationService } from './bot/destination.service';
import { ChannelEngineService } from './channel/channel-engine.service';
import { ChannelPolicyService } from './channel/channel-policy.service';
import { CtaPolicyService } from './channel/cta-policy.service';
import { ChannelPublisher } from './channel/channel-publisher.service';
import { ContentAdminService } from './bot/content/content-admin.service';
import { ContentService } from './channel/content.service';
import { PublicationStore } from './channel/publication.store';
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
import { AlertCapacityService } from './alerts/alert-capacity.service';
import { ReferralService } from './referrals/referral.service';
import { UserService } from './users/user.service';
import { UserStore } from './users/user.store';
// Phase 8 — campaign tracking & attribution (one store, one management service, one ingestion path,
// one reporting service and the admin-only dashboard that lives inside this same bot).
import { CampaignAdminService } from './bot/campaign/campaign-admin.service';
import { CampaignConversionService } from './campaigns/campaign-conversion.service';
import { CampaignController } from './campaigns/campaign.controller';
import { CampaignMetricsService } from './campaigns/campaign-metrics.service';
import { CampaignService } from './campaigns/campaign.service';
import { CampaignStore } from './campaigns/campaign.store';
import { CampaignTrackingService } from './campaigns/campaign-tracking.service';
import { SalesAdminService } from './bot/sales/sales-admin.service';
import { SalesNotificationService } from './sales/sales-notification.service';
import { SalesService } from './sales/sales.service';
import { SalesStore } from './sales/sales.store';
import { SalesUxService } from './bot/sales/sales-ux.service';

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
  controllers: [AppController, CampaignController],
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
    // Phase 5 — Channel Engine: content, publication jobs, per-destination delivery, scheduling.
    // Registered here (the project keeps one flat module tree) so the engine and every older phase
    // share exactly one instance of the market state, the intelligence service and the transport.
    PublicationStore,
    // Phase 6 — public destinations (deep links / channel links) and the channel → bot CTA policy.
    BotDestinationService,
    CtaPolicyService,
    ChannelPolicyService,
    ChannelPublisher,
    ChannelEngineService,
    ContentService,
    ContentAdminService,
    // Phase 7 — Growth Engine: referral codes, attribution, the reward ledger and the effective
    // alert capacity derived from it. Registered in the same flat provider list so the alerts and
    // the referral rules share exactly one `UserStore` instance.
    AlertCapacityService,
    ReferralService,
    // Phase 8
    CampaignStore,
    CampaignService,
    CampaignTrackingService,
    CampaignConversionService,
    CampaignMetricsService,
    CampaignAdminService,
    // Phase 9 — sales engine (lead capture, follow-up, sales outcomes) reusing the Phase 8 links.
    SalesStore,
    SalesService,
    SalesNotificationService,
    SalesAdminService,
    SalesUxService,
  ],
})
export class AppModule {}

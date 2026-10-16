/**
 * Demo harness — application context.
 *
 * Boots the **real** `AppModule` inside a Nest testing container, with exactly three providers
 * replaced (see `demo-transport.ts`). Everything else — configuration validation, the market
 * pipeline, the alert engine, the bot router, the channel engine, the user/alert/publication stores
 * and the referral service — is the production implementation.
 *
 * The container is created with `NestFactory`-equivalent semantics but *without* an HTTP listener:
 * the demo's own server (see `demo.server.ts`) is the only thing that listens, and the application's
 * inbound polling is switched off in the demo environment.
 */

import './demo-boot';

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import type { INestApplicationContext } from '@nestjs/common';

import { AppModule } from '../app.module';
import { AppConfigService } from '../config/app-config.service';
import { validateEnvironment } from '../config/env.validation';
import { AppService } from '../app.service';
import { AlertEngineService } from '../alerts/alert-engine.service';
import { AlertCapacityService } from '../alerts/alert-capacity.service';
import { AlertNotificationService } from '../alerts/alert-notification.service';
import { AlertService } from '../alerts/alert.service';
import { AlertStore } from '../alerts/alert.store';
import { BotUxService } from '../bot/ux/bot-ux.service';
import { BotDestinationService } from '../bot/destination.service';
import { PriceMessageBuilder } from '../bot/price-message.builder';
import { ChannelEngineService } from '../channel/channel-engine.service';
import { ChannelPublisher } from '../channel/channel-publisher.service';
import { CtaPolicyService } from '../channel/cta-policy.service';
import { PublicationStore } from '../channel/publication.store';
import { MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { MarketEngineService } from '../market/market-engine.service';
import { MarketStateService } from '../market/market-state.service';
import { BaleService } from '../bale/bale.service';
import { BotApiClient } from '../platform/bot-api.client';
import { PriceService } from '../price/price.service';
import { ReferralService } from '../referrals/referral.service';
import { UserStore } from '../users/user.store';
import {
  DemoBaleService,
  DemoBotApiClient,
  demoCapture,
  DemoPriceService,
  type DemoCapture,
} from './demo-transport';

/** Everything a scenario may use. */
export interface DemoContext {
  app: INestApplicationContext;
  config: AppConfigService;
  capture: DemoCapture;
  /** Configuration values the app really resolved, with secrets removed. */
  configSummary: Record<string, string | number | boolean>;
  services: {
    appService: AppService;
    marketEngine: MarketEngineService;
    marketState: MarketStateService;
    intelligence: MarketIntelligenceService;
    messages: PriceMessageBuilder;
    destinations: BotDestinationService;
    cta: CtaPolicyService;
    alertEngine: AlertEngineService;
    alerts: AlertService;
    notifications: AlertNotificationService;
    alertStore: AlertStore;
    capacity: AlertCapacityService;
    referrals: ReferralService;
    users: UserStore;
    botUx: BotUxService;
    channelEngine: ChannelEngineService;
    publisher: ChannelPublisher;
    publications: PublicationStore;
  };
  dispose(): Promise<void>;
}

/** Configuration facts the demo may show: switches, thresholds and paths — never a token. */
function summariseConfig(
  config: AppConfigService,
): Record<string, string | number | boolean> {
  return {
    'PORT (unused by the demo server)': config.port,
    'BALE bot configured': config.bale.botToken.trim() !== '',
    'BALE channel': config.bale.channelId,
    'TELEGRAM configured': config.telegram !== null,
    'TELEGRAM channel': config.telegram?.channelId ?? '(not configured)',
    'PRICE_API_URL (not called in demo)': config.priceApi.url,
    'PRICE timeout (ms)': config.priceApi.timeoutMs,
    'PRICE attempts': config.priceApi.maxAttempts,
    'MAX_ALERTS_PER_USER (base capacity)': config.maxAlertsPerUser,
    'REFERRAL enabled': config.referralEnabled,
    'REFERRAL rewards enabled': config.referralRewardsEnabled,
    'REFERRAL rewards per threshold': config.referralRewardsPerThreshold,
    'REFERRAL bonus slots': config.referralRewardBonusSlots,
    'REFERRAL active window (days)': Math.round(
      config.referralActiveWindowMs / 86_400_000,
    ),
    'REFERRAL max bonus slots (ceiling)': config.referralMaxBonusSlots,
    'CHANNEL CTA enabled': config.channelCtaEnabled,
    'BOT polling enabled': config.botPollingEnabled,
    USER_DATA_FILE: config.userDataFile ?? '(in-memory)',
    ALERTS_DATA_FILE: config.alertsDataFile ?? '(in-memory)',
    MARKET_STATE_FILE: config.marketStateFile ?? '(in-memory)',
    CHANNEL_DATA_FILE: config.channelDataFile ?? '(in-memory)',
  };
}

/**
 * Build the demo context.
 *
 * The environment is validated by the *same* function the application uses at boot, so a demo can
 * never run against a configuration the real app would refuse to start with.
 */
export async function createDemoContext(): Promise<DemoContext> {
  const validated = validateEnvironment({ ...process.env });
  const config = new AppConfigService(new ConfigService(validated));

  const builder = Test.createTestingModule({ imports: [AppModule] });

  builder.overrideProvider(BotApiClient).useValue(new DemoBotApiClient(config));
  builder.overrideProvider(BaleService).useValue(new DemoBaleService(config));
  builder.overrideProvider(PriceService).useValue(new DemoPriceService(config));

  const app = await builder.compile();
  await app.init();

  const services = {
    appService: app.get(AppService),
    marketEngine: app.get(MarketEngineService),
    marketState: app.get(MarketStateService),
    intelligence: app.get(MarketIntelligenceService),
    messages: app.get(PriceMessageBuilder),
    destinations: app.get(BotDestinationService),
    cta: app.get(CtaPolicyService),
    alertEngine: app.get(AlertEngineService),
    alerts: app.get(AlertService),
    notifications: app.get(AlertNotificationService),
    alertStore: app.get(AlertStore),
    capacity: app.get(AlertCapacityService),
    referrals: app.get(ReferralService),
    users: app.get(UserStore),
    botUx: app.get(BotUxService),
    channelEngine: app.get(ChannelEngineService),
    publisher: app.get(ChannelPublisher),
    publications: app.get(PublicationStore),
  };

  // The stores are loaded by their owning services during module init; loading them again is a
  // no-op and makes the demo independent of init ordering.
  await services.users.ensureLoaded();
  await services.alertStore.ensureLoaded();
  await services.publications.ensureLoaded();

  return {
    app,
    config,
    capture: demoCapture,
    configSummary: summariseConfig(config),
    services,
    async dispose(): Promise<void> {
      await app.close();
    },
  };
}

import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BaleService } from './bale/bale.service';
import { BotService } from './bot/bot.service';
import { PriceMessageBuilder } from './bot/price-message.builder';
import { TrendTracker } from './bot/trend-tracker';
import { AppConfigService } from './config/app-config.service';
import { validateEnvironment } from './config/env.validation';
import { PosterService } from './poster/poster.service';
import { PriceService } from './price/price.service';

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
    PriceService,
    PosterService,
    PriceMessageBuilder,
    TrendTracker,
    BotService,
  ],
})
export class AppModule {}

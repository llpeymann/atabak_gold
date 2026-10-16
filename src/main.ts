import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { describeError } from './common/log-safety';
import { AppConfigService } from './config/app-config.service';
import { CampaignStore } from './campaigns/campaign.store';
import { UserStore } from './users/user.store';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Lets the container stop the process cleanly (SIGTERM) instead of killing it mid-flight.
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const port = config.port;

  // Load persisted users/favorites before the first interaction is served.
  await app.get(UserStore).ensureLoaded();

  // Phase 8 — campaign data (campaigns, attributions, events, conversions, imports) is loaded before
  // the first request, so a tracked link can never be resolved against an empty document.
  await app.get(CampaignStore).ensureLoaded();

  // Bound to 0.0.0.0 so the app is reachable from outside the container.
  await app.listen(port, '0.0.0.0');

  logger.log(`Application is running on: http://0.0.0.0:${port}`);
  logger.log(`Health endpoint: http://0.0.0.0:${port}/health`);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (e.g. environment validation) must be explicit and visible.
  new Logger('Bootstrap').error(
    `Application failed to start: ${describeError(error)}`,
  );
  process.exit(1);
});

import { Controller, Get } from '@nestjs/common';

import { AppService, type HealthStatus } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Liveness/readiness probe used by Docker and the hosting platform. */
  @Get('health')
  getHealth(): HealthStatus {
    return this.appService.getHealth();
  }
}

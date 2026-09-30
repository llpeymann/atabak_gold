import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Application health only: it reports that the Nest application is up and serving.
   * It deliberately does not depend on the external price API (that is monitored by the
   * publication pipeline itself), so a third-party outage cannot mark the app unhealthy.
   */
  getHealth(): HealthStatus {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

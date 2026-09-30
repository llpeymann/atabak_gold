import { AppService } from './app.service';

describe('AppService', () => {
  const service = new AppService();

  it('keeps the original hello response', () => {
    expect(service.getHello()).toBe('Hello World!');
  });

  it('reports application health independent of external services', () => {
    const health = service.getHealth();

    expect(health.status).toBe('ok');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(health.timestamp))).toBe(false);
  });
});

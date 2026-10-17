/**
 * Phase 11 — the persistence seam in isolation.
 *
 * The store wiring is covered end-to-end in `src/monitoring/monitoring.wiring.spec.ts`; this suite
 * pins the contract every store relies on: reporting never throws, never blocks, and never reports a
 * "recovered" that had no matching failure.
 */

import {
  PersistenceEvent,
  PersistenceMonitor,
} from './persistence-monitor.service';

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  // The queue may invoke a listener that awaits a real timer (the serialisation test).
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('PersistenceMonitor', () => {
  it('accepts events before anything is attached', () => {
    const monitor = new PersistenceMonitor();

    expect(() =>
      monitor.failure('market-state', 'write', new Error('EIO')),
    ).not.toThrow();

    expect(monitor.failingComponents).toEqual(['market-state']);
  });

  it('delivers a failure to the listener with a readable error', async () => {
    const monitor = new PersistenceMonitor();
    const events: PersistenceEvent[] = [];
    monitor.attach((event) => {
      events.push(event);
    });

    monitor.failure('sales-data', 'write', new Error('ENOSPC: no space left'));
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'failure',
      component: 'sales-data',
      operation: 'write',
    });
    expect(JSON.stringify(events[0])).toContain('ENOSPC');
  });

  it('reports a success only for a component that was failing', async () => {
    const monitor = new PersistenceMonitor();
    const events: PersistenceEvent[] = [];
    monitor.attach((event) => {
      events.push(event);
    });

    monitor.success('user-data');
    await flush();
    expect(events).toHaveLength(0);

    monitor.failure('user-data', 'write', new Error('EACCES'));
    monitor.success('user-data');
    monitor.success('user-data');
    await flush();

    expect(events.map((event) => event.kind)).toEqual(['failure', 'success']);
    expect(monitor.failingComponents).toEqual([]);
  });

  it('swallows a listener that throws, and keeps delivering later events', async () => {
    const monitor = new PersistenceMonitor();
    let delivered = 0;

    monitor.attach(() => {
      delivered += 1;
      throw new Error('listener exploded');
    });

    monitor.failure('channel-data', 'write', new Error('EIO'));
    await flush();
    monitor.failure('alert-data', 'write', new Error('EIO'));
    await flush();

    expect(delivered).toBe(2);
    expect(monitor.failingComponents).toEqual(['alert-data', 'channel-data']);
  });

  it('serialises events so two documents failing in one tick are both delivered', async () => {
    const monitor = new PersistenceMonitor();
    const order: string[] = [];

    monitor.attach(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`${event.kind}:${event.component}`);
    });

    monitor.failure('market-state', 'write', new Error('EIO'));
    monitor.failure('sales-data', 'write', new Error('EIO'));
    await flush();

    expect(order).toEqual(['failure:market-state', 'failure:sales-data']);
  });
});

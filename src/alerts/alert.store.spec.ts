import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppConfigService } from '../../src/testing/test-doubles';
import { AlertStore } from './alert.store';
import { Alert, AlertDelivery } from './alert.types';

/**
 * Persistence and critical-section behaviour of the alert store (Phase 3 §37/§58/§61/§65).
 *
 * The store is the only writer of `ALERTS_DATA_FILE`, so it must survive restarts, tolerate a
 * corrupt/foreign file without losing user data, and serialize concurrent sections.
 */

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alr_store_1',
    userId: 'usr_1',
    platform: 'bale',
    symbol: 'IR_GOLD_18K',
    type: 'PRICE_ABOVE',
    status: 'ACTIVE',
    targetPrice: 17_500_000,
    targetPercent: null,
    direction: null,
    baselinePrice: null,
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T09:00:00.000Z',
    triggeredAt: null,
    disabledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function delivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    id: 'dlv_1',
    alertId: 'alr_store_1',
    userId: 'usr_1',
    platform: 'bale',
    chatId: 'chat-1',
    reason: 'PRICE_ABOVE_REACHED',
    status: 'SENT',
    triggerPrice: 17_600_000,
    triggerPercent: null,
    triggeredAt: '2026-09-30T10:00:00.000Z',
    attemptCount: 1,
    lastAttemptAt: '2026-09-30T10:00:00.000Z',
    sentAt: '2026-09-30T10:00:01.000Z',
    lastError: null,
    skippedReason: null,
    ...overrides,
  };
}

describe('AlertStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'alert-store-'));
    filePath = join(directory, 'alerts.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const createStore = (overrides = {}): AlertStore =>
    new AlertStore(
      createAppConfigService({ ALERTS_DATA_FILE: filePath, ...overrides }),
    );

  describe('in-memory mode', () => {
    it('is disabled when no file is configured and still stores alerts', async () => {
      const store = new AlertStore(
        createAppConfigService({ ALERTS_DATA_FILE: '' }),
      );

      expect(store.enabled).toBe(false);
      expect(store.path).toBeNull();

      await store.transact((tx) => tx.saveAlert(alert()));
      expect(store.alertCount).toBe(1);
    });
  });

  describe('persistence', () => {
    it('writes a versioned document with alerts and deliveries', async () => {
      const store = createStore();
      await store.transact((tx) => {
        tx.saveAlert(alert());
        tx.saveDelivery(delivery());
      });

      const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as {
        version: number;
        savedAt: string;
        alerts: Alert[];
        deliveries: AlertDelivery[];
      };

      expect(persisted.version).toBe(1);
      expect(Number.isNaN(Date.parse(persisted.savedAt))).toBe(false);
      expect(persisted.alerts).toHaveLength(1);
      expect(persisted.deliveries).toHaveLength(1);
      expect(persisted.alerts[0]?.targetPrice).toBe(17_500_000);
    });

    it('restores alerts, deliveries and indexes after a restart', async () => {
      const first = createStore();
      await first.transact((tx) => {
        tx.saveAlert(alert());
        tx.saveAlert(alert({ id: 'alr_store_2', status: 'DISABLED' }));
        tx.saveAlert(alert({ id: 'alr_store_3', symbol: 'USD' }));
        tx.saveDelivery(delivery());
      });

      const restarted = createStore();
      await restarted.ensureLoaded();

      expect(restarted.alertCount).toBe(3);
      expect(restarted.listAlertsByUser('usr_1')).toHaveLength(3);
      // Only the ACTIVE alert is indexed for evaluation.
      expect(
        restarted.listActiveBySymbol('IR_GOLD_18K').map((item) => item.id),
      ).toEqual(['alr_store_1']);
      expect([...restarted.activeSymbols].sort()).toEqual([
        'IR_GOLD_18K',
        'USD',
      ]);
      expect(restarted.findDeliveryByAlert('alr_store_1')?.status).toBe('SENT');
    });

    it('keeps the previous state while the new one is being written (atomic rename)', async () => {
      const store = createStore();
      await store.transact((tx) => tx.saveAlert(alert()));

      // No temporary file may be left behind after a successful write.
      const leftovers = await readFile(filePath, 'utf-8');
      expect(leftovers).toContain('alr_store_1');
      await expect(readFile(`${filePath}.tmp`, 'utf-8')).rejects.toThrow();
    });

    it('starts empty when the file does not exist', async () => {
      const store = createStore();

      await store.load();

      expect(store.alertCount).toBe(0);
    });

    it('does not throw and keeps data safe when the file is corrupt', async () => {
      await writeFile(filePath, '{ this is not json', 'utf-8');
      const store = createStore();

      await store.load();

      expect(store.alertCount).toBe(0);

      // Writing after a corrupt load must produce a valid document again.
      await store.transact((tx) => tx.saveAlert(alert()));
      const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as {
        alerts: Alert[];
      };
      expect(persisted.alerts.map((item) => item.id)).toEqual(['alr_store_1']);
    });

    it('ignores a foreign document shape without deleting it', async () => {
      await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf-8');
      const store = createStore();

      await store.load();

      expect(store.alertCount).toBe(0);
      expect(await readFile(filePath, 'utf-8')).toContain('hello');
    });

    it('loads a document written by an older version and keeps unknown fields', async () => {
      // Forward/backward compatibility: the loader must reject a broken row, not the whole file.
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          savedAt: '2026-01-01T00:00:00.000Z',
          alerts: [alert(), { id: 'broken-row' }, null],
          deliveries: [delivery(), { nothing: true }],
        }),
        'utf-8',
      );

      const store = createStore();
      await store.load();

      expect(store.alertCount).toBe(1);
      expect(store.listDeliveries()).toHaveLength(1);
    });
  });

  describe('critical section', () => {
    it('applies concurrent transactions in order, one after the other', async () => {
      const store = createStore();
      const order: string[] = [];

      await Promise.all([
        store.transact((tx) => {
          order.push('first');
          tx.saveAlert(alert({ id: 'alr_a' }));
        }),
        store.transact((tx) => {
          order.push('second');
          tx.saveAlert(alert({ id: 'alr_b' }));
        }),
        store.transact((tx) => {
          order.push('third');
          tx.saveAlert(alert({ id: 'alr_c' }));
        }),
      ]);

      expect(order).toEqual(['first', 'second', 'third']);
      expect(store.alertCount).toBe(3);

      const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as {
        alerts: Alert[];
      };
      expect(persisted.alerts).toHaveLength(3);
    });

    it('does not write when the operation changed nothing', async () => {
      const store = createStore();
      await store.transact((tx) => tx.saveAlert(alert()));

      const before = await readFile(filePath, 'utf-8');
      await store.transact((tx) => {
        tx.findAlert('alr_store_1');
      });
      const after = await readFile(filePath, 'utf-8');

      expect(after).toBe(before);
    });

    it('survives a rejected operation and keeps accepting transactions', async () => {
      const store = createStore();

      await expect(
        store.transact(() => {
          throw new Error('domain failure');
        }),
      ).rejects.toThrow('domain failure');

      await store.transact((tx) => tx.saveAlert(alert()));
      expect(store.alertCount).toBe(1);
    });

    it('hands out copies so callers cannot mutate the store by reference', async () => {
      const store = createStore();
      await store.transact((tx) => tx.saveAlert(alert()));

      const copy = store.findAlert('alr_store_1');
      expect(copy).not.toBeNull();
      if (copy) {
        copy.targetPrice = 1;
      }

      expect(store.findAlert('alr_store_1')?.targetPrice).toBe(17_500_000);
    });

    it('re-indexes a symbol when its last active alert is disabled', async () => {
      const store = createStore();
      await store.transact((tx) => tx.saveAlert(alert()));
      expect(store.activeSymbols).toEqual(['IR_GOLD_18K']);

      await store.transact((tx) =>
        tx.saveAlert({ ...alert(), status: 'DISABLED' }),
      );

      expect(store.listActiveBySymbol('IR_GOLD_18K')).toEqual([]);
      expect(store.activeSymbols).toEqual([]);
    });
  });
});

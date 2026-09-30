import { UpdatePollerService } from './update-poller.service';
import {
  createAppConfigService,
  createPlatformHarness,
  createUxHarness,
  UxHarness,
} from '../testing/test-doubles';
import { InboundUpdate } from './platform.types';

const inboundMessage = (updateId: number, text = '/start'): InboundUpdate => ({
  kind: 'message',
  updateId,
  platform: 'bale',
  chatId: 'chat-1',
  platformUserId: 'user-1',
  messageId: 100 + updateId,
  text,
});

const createPoller = (harness: UxHarness) =>
  new UpdatePollerService(
    harness.config,
    harness.platform.registry,
    harness.botUx,
  );

describe('UpdatePollerService', () => {
  it('hands queued updates to the UX layer and advances the offset', async () => {
    const harness = createUxHarness();
    const poller = createPoller(harness);
    harness.platform.queueUpdates([inboundMessage(1), inboundMessage(2)]);

    const handled = await poller.pollOnce('bale');

    expect(handled).toBe(2);
    // Both messages were answered (two sends).
    expect(harness.rendered()).toHaveLength(2);
  });

  it('never processes the same update twice', async () => {
    const harness = createUxHarness();
    const poller = createPoller(harness);
    harness.platform.queueUpdates([inboundMessage(1)]);

    await poller.pollOnce('bale');
    const second = await poller.pollOnce('bale');

    expect(second).toBe(0);
    expect(harness.rendered()).toHaveLength(1);
  });

  it('does nothing for a platform without an adapter', async () => {
    const harness = createUxHarness();
    const poller = createPoller(harness);

    await expect(poller.pollOnce('telegram')).resolves.toBe(0);
  });

  it('keeps running when the UX layer throws for one update', async () => {
    const harness = createUxHarness();
    const poller = createPoller(harness);
    let calls = 0;
    const handleUpdate = jest
      .spyOn(harness.botUx, 'handleUpdate')
      .mockImplementation(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve();
      });
    harness.platform.queueUpdates([inboundMessage(1), inboundMessage(2)]);

    const handled = await poller.pollOnce('bale');

    expect(handled).toBe(2);
    expect(handleUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not start a loop when polling is disabled', () => {
    const platform = createPlatformHarness({ BOT_POLLING_ENABLED: 'false' });
    const ux = createUxHarness();
    const poller = new UpdatePollerService(
      createAppConfigService({ BOT_POLLING_ENABLED: 'false' }),
      platform.registry,
      ux.botUx,
    );

    poller.onModuleInit();

    expect(platform.client.getUpdates).not.toHaveBeenCalled();
  });

  it('starts one loop per configured platform and stops cleanly', async () => {
    const harness = createUxHarness({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      TELEGRAM_CHANNEL_ID: 'tg-channel',
    });
    const poller = new UpdatePollerService(
      // The polling switch lives in the environment, not in the harness defaults.
      createAppConfigService({
        BOT_POLLING_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: 'tg-token',
        TELEGRAM_CHANNEL_ID: 'tg-channel',
      }),
      harness.platform.registry,
      harness.botUx,
    );

    poller.onModuleInit();
    expect(harness.platform.client.getUpdates).toHaveBeenCalledTimes(2);
    await poller.onModuleDestroy();

    const polled: string[] = harness.platform.client.getUpdates.mock.calls.map(
      (call: unknown[]) => String(call[0]),
    );
    expect(polled).toContain('bale');
    expect(polled).toContain('telegram');
  });
});

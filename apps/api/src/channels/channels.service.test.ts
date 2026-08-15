import { describe, expect, it, vi } from 'vitest';
import { ChannelsService } from './channels.service.js';
describe('ChannelsService subscriptions', () => {
  it('rejects self-subscription before writing', async () => {
    const prisma = {
      channel: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'user-1' }) },
      subscription: { upsert: vi.fn() },
    };
    const service = new ChannelsService(prisma as never, {} as never);
    await expect(
      service.subscribe('channel-1', 'user-1'),
    ).rejects.toMatchObject({ code: 'SELF_SUBSCRIPTION' });
    expect(prisma.subscription.upsert).not.toHaveBeenCalled();
  });
});

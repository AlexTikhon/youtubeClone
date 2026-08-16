import { describe, expect, it, vi } from 'vitest';

import { SearchService } from './search.service.js';

const rows = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'First result',
    durationSeconds: 60,
    publishedAt: new Date('2026-08-15T10:00:00.000Z'),
    viewsCount: 3,
    channelId: '22222222-2222-4222-8222-222222222222',
    channelName: 'Channel',
    channelHandle: 'channel',
    channelAvatarUrl: null,
    rank: 100.25,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Second result',
    durationSeconds: 60,
    publishedAt: new Date('2026-08-14T10:00:00.000Z'),
    viewsCount: 2,
    channelId: '22222222-2222-4222-8222-222222222222',
    channelName: 'Channel',
    channelHandle: 'channel',
    channelAvatarUrl: null,
    rank: 99.5,
  },
];

describe('SearchService cursor stability', () => {
  it('freezes ranking time in the cursor and reuses it on later pages', async () => {
    const queryRaw = vi.fn().mockResolvedValue(rows);
    const service = new SearchService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    const first = await service.search('architecture', undefined, 1);
    const cursor = first.page.nextCursor;
    expect(cursor).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(cursor!, 'base64url').toString('utf8'),
    ) as { asOf: string };
    expect(new Date(decoded.asOf).toISOString()).toBe(decoded.asOf);

    await service.search('architecture', cursor!, 1);
    const secondSql = queryRaw.mock.calls[1]?.[0] as { values: unknown[] };
    expect(
      secondSql.values.some(
        (value) =>
          value instanceof Date && value.toISOString() === decoded.asOf,
      ),
    ).toBe(true);
  });
});

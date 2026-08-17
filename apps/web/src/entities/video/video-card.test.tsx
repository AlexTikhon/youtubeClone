import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VideoCard } from './video-card';

const video = {
  id: 'video-id',
  title: 'A resilient React architecture',
  durationSeconds: 65,
  thumbnailUrl: '/thumbnail',
  viewsCount: 1200,
  publishedAt: '2026-01-01T00:00:00.000Z',
  channel: {
    id: 'channel-id',
    name: 'Frontend Channel',
    handle: 'frontend',
    avatarUrl: null,
  },
};

describe('VideoCard', () => {
  it('has stable lazy media and distinct video/channel links', () => {
    render(<VideoCard video={video} />);
    expect(
      screen.getByRole('link', {
        name: 'A resilient React architecture, 1:05',
      }),
    ).toHaveAttribute('href', '/watch/video-id');
    expect(
      screen.getByRole('link', { name: 'Frontend Channel' }),
    ).toHaveAttribute('href', '/channel/frontend');
    const image = screen.getByRole('presentation');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('width', '640');
    expect(image).toHaveAttribute('height', '360');
  });
});

export const queryKeys = {
  auth: {
    currentUser: ['auth', 'me'] as const,
  },
  video: {
    all: ['video'] as const,
    detail: (videoId: string) => ['video', videoId] as const,
    related: (videoId: string) => ['video', videoId, 'related'] as const,
    comments: (videoId: string) => ['video', videoId, 'comments'] as const,
  },
  ownerVideo: (videoId: string | undefined) =>
    ['owner-video', videoId ?? 'pending'] as const,
  feed: {
    all: ['feed'] as const,
    home: ['feed', 'home'] as const,
    subscriptions: ['feed', 'subscriptions'] as const,
  },
  search: {
    all: ['search'] as const,
    results: (query: string) => ['search', query] as const,
  },
  playlist: {
    all: ['playlists'] as const,
    lists: ['playlists', 'mine'] as const,
    mine: (videoId?: string) =>
      ['playlists', 'mine', videoId ?? 'all'] as const,
    detail: (playlistId: string) => ['playlists', playlistId] as const,
  },
  channel: {
    all: ['channel'] as const,
    detail: (handle: string) => ['channel', handle] as const,
    videos: (handle: string) => ['channel', handle, 'videos'] as const,
    mine: ['channel', 'mine'] as const,
  },
  history: {
    all: ['history'] as const,
  },
  studio: {
    videos: ['studio', 'videos'] as const,
  },
  health: {
    api: ['health', 'api'] as const,
  },
};

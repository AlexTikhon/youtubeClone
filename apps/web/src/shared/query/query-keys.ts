export const queryKeys = {
  auth: ['auth', 'me'] as const,
  video: (videoId: string) => ['video', videoId] as const,
  ownerVideo: (videoId: string | undefined) =>
    ['owner-video', videoId ?? 'pending'] as const,
  related: (videoId: string) => ['video', videoId, 'related'] as const,
  comments: (videoId: string) => ['video', videoId, 'comments'] as const,
  search: (query: string) => ['search', query] as const,
  playlists: ['playlists'] as const,
  playlistMine: (videoId?: string) =>
    ['playlists', 'mine', videoId ?? 'all'] as const,
  playlist: (playlistId: string) => ['playlists', playlistId] as const,
  channel: (handle: string) => ['channel', handle] as const,
  channelMine: ['channel', 'mine'] as const,
  history: ['history'] as const,
  studioVideos: ['studio', 'videos'] as const,
  feeds: ['feed'] as const,
  subscriptionsFeed: ['feed', 'subscriptions'] as const,
};

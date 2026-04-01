const BASE_URL = import.meta.env.VITE_API_URL || '';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText);
  }
  return res.json();
}

export const api = {
  getPlaylists: () => request<import('./types').Playlist[]>('/api/playlists'),
  getPlaylist: (id: number) => request<import('./types').Playlist>(`/api/playlists/${id}`),
  getPlaylistSongs: (id: number) => request<import('./types').Song[]>(`/api/playlists/${id}/songs`),
  getSongs: () => request<import('./types').Song[]>('/api/songs'),
  getSong: (id: number) => request<import('./types').Song>(`/api/songs/${id}`),
  getPlayerState: () => request<import('./types').PlayerState>('/api/player'),
  togglePlay: () => request<{ status: string; progress: number }>('/api/player/toggle', {
    method: 'POST',
  }),
  nextSong: () =>
    request<{ current_song: import('./types').PlayerSong; index: number }>('/api/player/next', {
      method: 'POST',
    }),
  prevSong: () =>
    request<{ current_song: import('./types').PlayerSong; index: number }>('/api/player/prev', {
      method: 'POST',
    }),
  health: () => request<Record<string, string>>('/health'),
};

export { ApiError };

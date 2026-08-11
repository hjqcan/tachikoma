import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api';
import type { Playlist, Song, PlayerState } from './types';

function mockFetch(response: unknown, ok = true, status = 200) {
  return vi.spyOn(window, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(response), {
      status: ok ? status : Math.max(status, 400),
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('api module', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getPlaylists', () => {
    it('fetches playlists from /api/playlists', async () => {
      const mockData: Playlist[] = [
        {
          id: 1,
          name: '我的歌单',
          cover_url: 'https://example.com/cover.jpg',
          track_count: 10,
          song_ids: [1, 2],
          play_count: 50000,
          comment_count: 100,
          tags: ['pop'],
          creator: { id: 1, name: 'Test' },
          created_at: '2024-01-01',
        },
      ];
      fetchSpy = mockFetch(mockData);

      const result = await api.getPlaylists();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('我的歌单');
      expect(fetchSpy).toHaveBeenCalledWith('/api/playlists', undefined);
    });
  });

  describe('getPlaylistSongs', () => {
    it('fetches songs for a playlist', async () => {
      const mockSongs: Song[] = [
        {
          id: 101,
          title: '晴天',
          artist_id: 1,
          artist_name: '周杰伦',
          album_name: '叶惠美',
          album_cover: '',
          duration: 253,
          play_count: 15000000,
          comment_count: 25000,
          like_count: 500000,
        },
      ];
      fetchSpy = mockFetch(mockSongs);

      const result = await api.getPlaylistSongs(100);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('晴天');
      expect(fetchSpy).toHaveBeenCalledWith('/api/playlists/100/songs', undefined);
    });
  });

  describe('getPlayerState', () => {
    it('fetches current player state', async () => {
      const playerState: PlayerState = {
        current_song_id: 2001,
        current_song: {
          id: 2001,
          title: '晴天',
          artist_name: '周杰伦',
          album_name: '叶惠美',
          album_cover: '',
          duration: 253,
        },
        is_playing: true,
        progress: 45,
        volume: 80,
        play_mode: 'loop',
        playlist: [2001, 2002],
        current_index: 0,
        is_liked: true,
      };
      fetchSpy = mockFetch(playerState);

      const result = await api.getPlayerState();
      expect(result.is_playing).toBe(true);
      expect(result.current_song.title).toBe('晴天');
    });
  });

  describe('togglePlay', () => {
    it('sends POST request to toggle playback', async () => {
      fetchSpy = mockFetch({ status: 'paused', progress: 120 });

      const result = await api.togglePlay();
      expect(result.status).toBe('paused');
      expect(fetchSpy).toHaveBeenCalledWith('/api/player/toggle', { method: 'POST' });
    });
  });

  describe('nextSong', () => {
    it('sends POST request to skip to next song', async () => {
      fetchSpy = mockFetch({
        current_song: {
          id: 2002,
          title: '七里香',
          artist_name: '周杰伦',
          album_name: '七里香',
          album_cover: '',
          duration: 237,
        },
        index: 1,
      });

      const result = await api.nextSong();
      expect(result.current_song.title).toBe('七里香');
    });
  });

  describe('prevSong', () => {
    it('sends POST request to go to previous song', async () => {
      fetchSpy = mockFetch({
        current_song: {
          id: 2001,
          title: '晴天',
          artist_name: '周杰伦',
          album_name: '叶惠美',
          album_cover: '',
          duration: 253,
        },
        index: 0,
      });

      const result = await api.prevSong();
      expect(result.index).toBe(0);
    });
  });

  describe('error handling', () => {
    it('throws ApiError on 4xx response', async () => {
      fetchSpy = mockFetch({ detail: 'Playlist not found' }, false, 404);

      const error = await api.getPlaylist(999).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 404, message: 'Playlist not found' });
    });

    it('throws ApiError with generic message on 5xx response', async () => {
      fetchSpy = mockFetch({}, false, 500);

      await expect(api.getPlaylists()).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe('health check', () => {
    it('fetches server health endpoint', async () => {
      fetchSpy = mockFetch({ status: 'ok', version: '1.0.0' });

      const result = await api.health();
      expect(result.status).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledWith('/health', undefined);
    });
  });

  describe('concurrent API calls', () => {
    it('can fetch playlists and songs in parallel', async () => {
      fetchSpy = mockFetch([
        {
          id: 1,
          name: '歌单',
          cover_url: '',
          track_count: 5,
          song_ids: [1],
          play_count: 100,
          comment_count: 0,
          tags: [],
          creator: { id: 1, name: 'A' },
          created_at: '2024-01-01',
        },
      ]);

      const [playlists] = await Promise.all([api.getPlaylists()]);
      expect(playlists).toHaveLength(1);
    });
  });
});

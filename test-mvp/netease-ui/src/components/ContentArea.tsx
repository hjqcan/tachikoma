import { useState, memo } from 'react';
import { api } from '../api';
import type { Playlist, Song } from '../types';
import { PlaylistCards } from './PlaylistCards';
import { SongListTable } from './SongListTable';

type ViewMode = 'discover' | 'my-music' | 'playlist-detail' | 'all-songs' | 'search';

type ContentAreaProps = {
  activeView: string;
  searchQuery: string;
  playlists: Playlist[];
  songs: Song[];
  currentSongId: number | null;
  onNavigate: (view: ViewMode, data?: { playlistId?: number }) => void;
  onPlaySong: (song: Song) => void;
};

const formatCount = (n: number) => {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(0) + '万';
  return n.toString();
};

function DiscoverView({
  playlists,
  songs,
  onPlaylistClick,
  onNavigate,
}: {
  playlists: Playlist[];
  songs: Song[];
  onPlaylistClick: (id: number) => void;
  onNavigate: (view: ViewMode) => void;
}) {
  return (
    <div className="space-y-8">
      {/* Featured section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold text-[#333333]">推荐歌单</h3>
          <button
            onClick={() => onNavigate('all-songs')}
            className="text-sm text-[#666666] hover:text-[#C20C0C] transition-colors"
          >
            更多 ›
          </button>
        </div>
        <PlaylistCards
          playlists={playlists}
          onItemClick={onPlaylistClick}
          isLoading={false}
          error={null}
        />
      </div>
      {/* New Songs section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold text-[#333333]">最新单曲</h3>
        </div>
        <SongListTable
          songs={songs.slice(0, 8)}
          playingSongId={null}
          isLoading={false}
          error={null}
        />
      </div>
    </div>
  );
}

export const ContentArea = memo(function ContentArea({
  activeView,
  searchQuery,
  playlists,
  songs,
  currentSongId,
  onNavigate,
  onPlaySong,
}: ContentAreaProps) {
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([]);
  const [playlistSongsLoading, setPlaylistSongsLoading] = useState(false);
  const [playlistSongsError, setPlaylistSongsError] = useState<string | null>(null);

  // Search filtering
  const filteredPlaylists = searchQuery
    ? playlists.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase())),
      )
    : playlists;

  const filteredSongs = searchQuery
    ? songs.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.artist_name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : songs;

  // Playlist detail view handler
  const handlePlaylistClick = async (id: number) => {
    const pl = playlists.find((p) => p.id === id) ?? null;
    setSelectedPlaylist(pl);
    setPlaylistSongsLoading(true);
    setPlaylistSongsError(null);
    try {
      const fetchedSongs = await api.getPlaylistSongs(id);
      setPlaylistSongs(fetchedSongs);
    } catch (e) {
      setPlaylistSongsError((e as Error).message);
    } finally {
      setPlaylistSongsLoading(false);
    }
    onNavigate('playlist-detail', { playlistId: id });
  };

  // View rendering
  if (activeView === 'playlist-detail' && selectedPlaylist) {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-6">
          <div className="w-32 h-32 rounded bg-[#F5F5F5] flex items-center justify-center text-5xl text-[#CCCCCC] shrink-0">
            ♪
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-[#333333]">{selectedPlaylist.name}</h2>
            <p className="text-sm text-[#666666] mt-2">创建者: {selectedPlaylist.creator.name}</p>
            <div className="flex gap-3 mt-2">
              {selectedPlaylist.tags.map((t) => (
                <span key={t} className="px-2 py-0.5 bg-[#F5F5F5] text-xs text-[#666666] rounded">
                  {t}
                </span>
              ))}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-[#999999]">
              <span>播放: {formatCount(selectedPlaylist.play_count)}</span>
              <span>评论: {formatCount(selectedPlaylist.comment_count)}</span>
              <span>歌曲: {selectedPlaylist.track_count} 首</span>
            </div>
          </div>
        </div>
        <SongListTable
          songs={playlistSongs}
          playingSongId={currentSongId}
          onPlaySong={(id) => {
            const s = playlistSongs.find((s) => s.id === id);
            if (s) onPlaySong(s);
          }}
          isLoading={playlistSongsLoading}
          error={playlistSongsError}
        />
      </div>
    );
  }

  if (activeView === 'all-songs') {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold text-[#333333]">全部歌曲</h2>
        <SongListTable
          songs={filteredSongs}
          playingSongId={currentSongId}
          onPlaySong={(id) => {
            const s = songs.find((s) => s.id === id);
            if (s) onPlaySong(s);
          }}
          isLoading={false}
          error={null}
        />
      </div>
    );
  }

  // Default: discover/my-music view
  return (
    <DiscoverView
      playlists={filteredPlaylists}
      songs={songs}
      onPlaylistClick={handlePlaylistClick}
      onNavigate={onNavigate}
    />
  );
});

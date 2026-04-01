import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Playlist, PlayerSong, Song } from './types';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { PlayerBar } from './components/PlayerBar';
import { ContentArea } from './components/ContentArea';

export default function App() {
  const [activeView, setActiveView] = useState('discover');
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [playerState, setPlayerState] = useState<{
    song: PlayerSong | null;
    isPlaying: boolean;
    progress: number;
    volume: number;
    playMode: string;
    playlist: Song[];
  }>({
    song: null,
    isPlaying: false,
    progress: 0,
    volume: 80,
    playMode: 'loop',
    playlist: [],
  });

  // Initial data fetch
  useEffect(() => {
    let active = true;
    Promise.all([api.getPlaylists(), api.getSongs(), api.getPlayerState()])
      .then(([pls, sngs, ps]) => {
        if (active) {
          setPlaylists(pls);
          setSongs(sngs);
          setPlayerState((prev) => ({
            ...prev,
            song: ps.current_song ?? prev.song ?? null,
            isPlaying: ps.is_playing,
            progress: ps.progress,
            volume: ps.volume,
            playMode: ps.play_mode,
          }));
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e instanceof Error ? e.message : 'Unknown error');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Navigation
  const handleNavigate = useCallback((view: string) => {
    setActiveView(view);
  }, []);

  // Player controls
  const handleTogglePlay = useCallback(async () => {
    try {
      const res = await api.togglePlay();
      setPlayerState((prev) => ({
        ...prev,
        isPlaying: res.status === 'playing',
        progress: res.progress,
      }));
    } catch {
      setPlayerState((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
    }
  }, []);

  const handleNext = useCallback(async () => {
    try {
      const res = await api.nextSong();
      setPlayerState((prev) => ({
        ...prev,
        song: res.current_song,
        progress: 0,
      }));
    } catch {
      setPlayerState((prev) => ({ ...prev, progress: 0 }));
    }
  }, []);

  const handlePrev = useCallback(async () => {
    try {
      const res = await api.prevSong();
      setPlayerState((prev) => ({
        ...prev,
        song: res.current_song,
        progress: 0,
      }));
    } catch {
      setPlayerState((prev) => ({ ...prev, progress: 0 }));
    }
  }, []);

  const handlePlaySong = useCallback((song: Song) => {
    setPlayerState((prev) => ({
      ...prev,
      song: {
        id: song.id,
        title: song.title,
        artist_name: song.artist_name,
        album_name: song.album_name,
        album_cover: song.album_cover,
        duration: song.duration,
      },
      isPlaying: true,
      progress: 0,
    }));
  }, []);

  return (
    <div className="h-full flex flex-col bg-[#F5F5F5] text-[#333333] overflow-hidden">
      {/* Top: Header */}
      <Header
        activeView={activeView}
        onBack={() => setActiveView('discover')}
        onForward={() => {}}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Middle: Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar playlists={playlists} activeView={activeView} onNavigate={handleNavigate} />
        <main className="flex-1 overflow-auto p-6">
          {loading && (
            <div className="flex items-center justify-center h-48 text-[#999999]">
              加载中...
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-48 text-[#C20C0C]">
              <p className="text-lg mb-2">连接失败</p>
              <p className="text-sm text-[#666666] mb-4">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-[#C20C0C] text-white rounded hover:bg-[#D43C33] transition-colors text-sm"
              >
                重试
              </button>
            </div>
          )}
          {!loading && !error && (
            <ContentArea
              activeView={activeView}
              searchQuery={searchQuery}
              playlists={playlists}
              songs={songs}
              currentSongId={playerState.song?.id ?? null}
              onNavigate={handleNavigate}
              onPlaySong={handlePlaySong}
            />
          )}
        </main>
      </div>

      {/* Bottom: Player Bar */}
      <PlayerBar
        currentSong={
          playerState.song ?? {
            id: 0,
            title: '未选择',
            artist_name: '',
            album_name: '',
            album_cover: '',
            duration: 0,
          }
        }
        isPlaying={playerState.isPlaying}
        progress={playerState.progress}
        volume={playerState.volume}
        playMode={playerState.playMode}
        onTogglePlay={handleTogglePlay}
        onNext={handleNext}
        onPrev={handlePrev}
        onProgressChange={() => {}}
        onVolumeChange={() => {}}
        onNextMode={() => {}}
      />
    </div>
  );
}

import type { Song } from '../types';

function formatDuration(sec: number): string {
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

type SongListTableProps = {
  songs: Song[];
  playingSongId: number | null;
  onPlaySong?: (id: number) => void;
  isLoading: boolean;
  error: string | null;
};

export function SongListTable({
  songs,
  playingSongId,
  onPlaySong,
  isLoading,
  error,
}: SongListTableProps) {
  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-[#999999]">加载中...</div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-48 text-[#C20C0C]">{error}</div>;
  }
  if (songs.length === 0) {
    return <div className="text-center text-[#999999] py-8">暂无歌曲</div>;
  }

  return (
    <div className="w-full">
      <div className="grid grid-cols-[40px_3fr_2fr_2fr_80px_80px] gap-2 px-4 py-2 bg-[#F5F5F5] text-[#999999] text-xs sticky top-0 z-10">
        <span>#</span>
        <span>歌曲</span>
        <span>歌手</span>
        <span>专辑</span>
        <span>播放次数</span>
        <span>时长</span>
      </div>
      {songs.map((song, i) => (
        <div
          key={song.id}
          onClick={() => onPlaySong?.(song.id)}
          className={`grid grid-cols-[40px_3fr_2fr_2fr_80px_80px] gap-2 px-4 py-2 text-sm transition-colors cursor-pointer group ${
            playingSongId === song.id
              ? 'bg-[#FCF0F0] text-[#C20C0C]'
              : 'text-[#333333] hover:bg-[#F5F5F5]'
          }`}
        >
          <span className="text-[#999999] text-xs leading-6">{i + 1}</span>
          <span className="truncate font-medium">{song.title}</span>
          <span className="truncate text-[#666666]">{song.artist_name}</span>
          <span className="truncate text-[#666666]">{song.album_name}</span>
          <span className="truncate text-[#666666] text-xs leading-6">{song.play_count}</span>
          <span className="text-[#999999] text-xs leading-6">{formatDuration(song.duration)}</span>
        </div>
      ))}
    </div>
  );
}

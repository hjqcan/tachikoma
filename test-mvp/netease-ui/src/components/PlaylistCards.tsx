import type { Playlist } from '../types';

const PLAY_COUNT_SUFFIXES = [
  { threshold: 100000000, suffix: '亿' },
  { threshold: 10000, suffix: '万' },
] as const;

function formatCount(n: number): string {
  for (const { threshold, suffix } of PLAY_COUNT_SUFFIXES) {
    if (n >= threshold) return `${(n / threshold).toFixed(1)}${suffix}`;
  }
  return n.toString();
}

type PlaylistCardsProps = {
  playlists: Playlist[];
  onItemClick: (id: number) => void;
  isLoading: boolean;
  error: string | null;
};

export function PlaylistCards({ playlists, onItemClick, isLoading, error }: PlaylistCardsProps) {
  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-[#999999]">加载中...</div>;
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-[#C20C0C]">
        {error}
        <button
          className="ml-4 px-3 py-1 bg-[#C20C0C] text-white text-sm rounded hover:bg-[#D43C33] transition-colors"
          onClick={() => window.location.reload()}
        >
          重试
        </button>
      </div>
    );
  }

  if (playlists.length === 0) {
    return <div className="text-center text-[#999999] py-8">暂无歌单</div>;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {playlists.map((pl) => (
        <button
          key={pl.id}
          onClick={() => onItemClick(pl.id)}
          className="text-left bg-white rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-all duration-200 group"
        >
          <div className="relative aspect-square bg-[#F5F5F5] overflow-hidden">
            <div className="w-full h-full flex items-center justify-center text-4xl text-[#CCCCCC] group-hover:scale-105 transition-transform duration-300">
              ♪
            </div>
            <div className="absolute top-2 right-2 bg-black/40 text-white text-xs px-1.5 py-0.5 rounded-full flex items-center gap-1">
              ▶ {formatCount(pl.play_count)}
            </div>
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <span className="w-10 h-10 rounded-full bg-[#C20C0C] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-lg">
                ▶
              </span>
            </div>
          </div>
          <div className="p-3">
            <p className="text-sm text-[#333333] font-medium line-clamp-2 leading-tight">{pl.name}</p>
            <p className="text-xs text-[#999999] mt-1 truncate">by {pl.creator.name}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

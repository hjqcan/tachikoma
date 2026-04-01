type HeaderProps = {
  activeView: string;
  onBack: () => void;
  onForward: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
};

export function Header({
  activeView,
  onBack,
  onForward,
  searchQuery,
  onSearchChange,
}: HeaderProps) {
  return (
    <header className="h-[72px] bg-white border-b border-[#E4E4E4] flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full bg-[#F5F5F5] hover:bg-[#E4E4E4] flex items-center justify-center transition-colors text-[#666666]"
          aria-label="Go back"
        >
          ←
        </button>
        <button
          onClick={onForward}
          className="w-8 h-8 rounded-full bg-[#F5F5F5] hover:bg-[#E4E4E4] flex items-center justify-center transition-colors text-[#666666]"
          aria-label="Go forward"
        >
          →
        </button>
        <h2 className="ml-3 text-lg font-semibold text-[#333333] tracking-wide">
          {viewTitles[activeView] || '网易云音乐'}
        </h2>
      </div>

      <div className="relative">
        <input
          type="text"
          placeholder="搜索音乐、歌手、歌词"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-[250px] h-[34px] px-4 pr-10 rounded-[17px] bg-[#F5F5F5] border border-[#E4E4E4] text-sm text-[#333333] placeholder-[#999999] focus:outline-none focus:border-[#C20C0C] focus:bg-white transition-colors"
        />
        <button
          aria-label="Search"
          className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-[#999999] hover:text-[#C20C0C] transition-colors"
        >
          🔍
        </button>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[#F5F5F5] flex items-center justify-center text-[#999999]">
            👤
          </div>
          <span className="text-sm text-[#666666]">网易云账号</span>
        </div>
      </div>
    </header>
  );
}

const viewTitles: Record<string, string> = {
  discover: '发现音乐',
  'my-music': '我的音乐',
  'playlist-detail': '歌单详情',
  'all-songs': '全部歌曲',
};

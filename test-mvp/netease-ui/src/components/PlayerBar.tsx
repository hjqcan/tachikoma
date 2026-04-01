import type { PlayerSong } from '../types';

const PLAY_MODES = [
  { key: 'shuffle', label: '随机', icon: '🔀' },
  { key: 'loop', label: '循环', icon: '🔁' },
  { key: 'repeat_one', label: '单曲循环', icon: '🔂' },
] as const;

type PlayerBarProps = {
  currentSong: PlayerSong;
  isPlaying: boolean;
  progress: number;
  volume: number;
  playMode: string;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onProgressChange: (time: number) => void;
  onVolumeChange: (v: number) => void;
  onNextMode: () => void;
};

export function PlayerBar({
  currentSong,
  isPlaying,
  progress,
  volume,
  playMode,
  onTogglePlay,
  onNext,
  onPrev,
  onProgressChange,
  onVolumeChange,
  onNextMode,
}: PlayerBarProps) {
  const playModeInfo = PLAY_MODES.find((m) => m.key === playMode) ?? PLAY_MODES[1];

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-[72px] bg-[#2A2A2A] flex items-center px-4 gap-3 shrink-0 border-t border-[#444444]">
      {/* Left - Song Info */}
      <div className="w-[20%] flex items-center gap-3 min-w-0">
        <div className="w-12 h-12 rounded bg-[#3A3A3A] overflow-hidden shrink-0 flex items-center justify-center text-[#999]">
          ♪
        </div>
        <div className="min-w-0">
          <p className="text-sm text-white truncate">{currentSong?.title || '- 未播放 -'}</p>
          <p className="text-xs text-[#999999] truncate">{currentSong?.artist_name || ''}</p>
        </div>
      </div>

      {/* Center - Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <button
            onClick={onNextMode}
            title={`播放模式: ${playModeInfo.label}`}
            className="w-8 h-8 flex items-center justify-center text-[#CCCCCC] hover:text-white transition-colors text-sm"
          >
            {playModeInfo.icon}
          </button>
          <button
            onClick={onPrev}
            aria-label="上一曲"
            className="w-8 h-8 flex items-center justify-center text-[#CCCCCC] hover:text-white transition-colors text-lg"
          >
            ⏮
          </button>
          <button
            onClick={onTogglePlay}
            aria-label={isPlaying ? '暂停' : '播放'}
            className="w-10 h-10 rounded-full bg-[#C20C0C] hover:bg-[#D43C33] flex items-center justify-center text-white transition-colors text-lg"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            onClick={onNext}
            aria-label="下一曲"
            className="w-8 h-8 flex items-center justify-center text-[#CCCCCC] hover:text-white transition-colors text-lg"
          >
            ⏭
          </button>
          <div className="flex items-center gap-2">
            <button
              aria-label="音量"
              className="w-8 h-8 flex items-center justify-center text-[#CCCCCC] hover:text-white transition-colors text-sm"
            >
              {volume > 0 ? '🔊' : '🔇'}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="w-20 accent-[#C20C0C]"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 w-[400px]">
          <span className="text-xs text-[#999999] w-10 text-right">{formatTime(progress)}</span>
          <input
            type="range"
            min="0"
            max={currentSong?.duration || 0}
            value={progress}
            onChange={(e) => onProgressChange(Number(e.target.value))}
            className="flex-1 accent-[#C20C0C] h-1"
          />
          <span className="text-xs text-[#999999] w-10">
            {formatTime(currentSong?.duration || 0)}
          </span>
        </div>
      </div>

      {/* Right - Extras */}
      <div className="w-[20%] flex items-center justify-end gap-3">
        <button className="text-[#999999] hover:text-white text-sm">歌词</button>
        <button className="text-[#999999] hover:text-white text-sm">播放列表</button>
      </div>
    </div>
  );
}

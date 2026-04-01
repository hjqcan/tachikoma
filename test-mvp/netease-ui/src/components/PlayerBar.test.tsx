import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlayerBar } from './PlayerBar';
import type { PlayerSong } from '../types';

const mockSong: PlayerSong = {
  id: 2001,
  title: '晴天',
  artist_name: '周杰伦',
  album_name: '叶惠美',
  album_cover: 'https://example.com/cover.jpg',
  duration: 253,
};

describe('PlayerBar', () => {
  const defaultProps = {
    currentSong: mockSong,
    isPlaying: false,
    progress: 0,
    volume: 80,
    playMode: 'loop',
    onTogglePlay: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onProgressChange: vi.fn(),
    onVolumeChange: vi.fn(),
    onNextMode: vi.fn(),
  };

  it('renders song title and artist', () => {
    render(<PlayerBar {...defaultProps} />);

    expect(screen.getByText('晴天')).toBeInTheDocument();
    expect(screen.getByText('周杰伦')).toBeInTheDocument();
  });

  it('shows play button when not playing', () => {
    render(<PlayerBar {...defaultProps} isPlaying={false} />);
    const playBtn = screen.getByRole('button', { name: '播放' });
    expect(playBtn).toBeInTheDocument();
  });

  it('shows pause button when playing', () => {
    render(<PlayerBar {...defaultProps} isPlaying />);
    const pauseBtn = screen.getByRole('button', { name: '暂停' });
    expect(pauseBtn).toBeInTheDocument();
  });

  it('calls onTogglePlay when play/pause button is clicked', () => {
    const onToggle = vi.fn();
    render(<PlayerBar {...defaultProps} onTogglePlay={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('calls onPrev when previous button is clicked', () => {
    const onPrev = vi.fn();
    render(<PlayerBar {...defaultProps} onPrev={onPrev} />);
    fireEvent.click(screen.getByRole('button', { name: '上一曲' }));
    expect(onPrev).toHaveBeenCalled();
  });

  it('calls onNext when next button is clicked', () => {
    const onNext = vi.fn();
    render(<PlayerBar {...defaultProps} onNext={onNext} />);
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }));
    expect(onNext).toHaveBeenCalled();
  });

  it('displays progress time correctly', () => {
    render(<PlayerBar {...defaultProps} progress={125} currentSong={{ ...mockSong, duration: 253 }} />);
    // 125 seconds = 2:05
    expect(screen.getByText('2:05')).toBeInTheDocument();
    expect(screen.getByText('4:13')).toBeInTheDocument(); // Total duration
  });

  it('calls onProgressChange when progress slider changes', () => {
    const onProgress = vi.fn();
    const { container } = render(
      <PlayerBar {...defaultProps} progress={125} onProgressChange={onProgress} />
    );
    const sliders = container.querySelectorAll('input[type="range"]');
    const progressSlider = sliders[1]; // Second slider is progress
    fireEvent.change(progressSlider, { target: { value: 60 } });
    expect(onProgress).toHaveBeenCalledWith(60);
  });

  it('calls onVolumeChange when volume slider changes', () => {
    const onVol = vi.fn();
    const { container } = render(
      <PlayerBar {...defaultProps} volume={50} onVolumeChange={onVol} />
    );
    const sliders = container.querySelectorAll('input[type="range"]');
    const volSlider = sliders[0]; // First slider is volume
    fireEvent.change(volSlider, { target: { value: 75 } });
    expect(onVol).toHaveBeenCalledWith(75);
  });

  it('shows play mode toggle button', () => {
    render(<PlayerBar {...defaultProps} playMode="loop" />);
    // The play mode button should show the shuffle/loop/repeat_one icon
    const modeBtn = screen.getByTitle('播放模式: 循环');
    expect(modeBtn).toBeInTheDocument();
  });

  it('calls onNextMode when play mode button is clicked', () => {
    const onNextMode = vi.fn();
    render(<PlayerBar {...defaultProps} onNextMode={onNextMode} />);
    const modeBtn = screen.getByTitle('播放模式: 循环');
    fireEvent.click(modeBtn);
    expect(onNextMode).toHaveBeenCalled();
  });

  it('shows lyrics and playlist buttons', () => {
    render(<PlayerBar {...defaultProps} />);
    expect(screen.getByText('歌词')).toBeInTheDocument();
    expect(screen.getByText('播放列表')).toBeInTheDocument();
  });

  it('shows placeholder when no song playing', () => {
    const emptySong = {
      id: 0,
      title: '',
      artist_name: '',
      album_name: '',
      album_cover: '',
      duration: 0,
    };
    render(<PlayerBar {...defaultProps} currentSong={emptySong} />);
    expect(screen.getByText('- 未播放 -')).toBeInTheDocument();
  });

  it('has correct visual styling classes', () => {
    const { container } = render(<PlayerBar {...defaultProps} />);
    const playerBar = container.querySelector('[class*="h-[72px]"]');
    expect(playerBar).toHaveClass('bg-[#2A2A2A]');
  });
});

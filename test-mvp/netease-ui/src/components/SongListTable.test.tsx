import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SongListTable } from './SongListTable';
import type { Song } from '../types';

const mockSongs: Song[] = [
  {
    id: 2001,
    title: '晴天',
    artist_id: 5001,
    artist_name: '周杰伦',
    album_name: '叶惠美',
    album_cover: 'https://example.com/cover1.jpg',
    duration: 253,
    play_count: 15000000,
    comment_count: 25000,
    like_count: 500000,
  },
  {
    id: 2002,
    title: '七里香',
    artist_id: 5001,
    artist_name: '周杰伦',
    album_name: '七里香',
    album_cover: 'https://example.com/cover2.jpg',
    duration: 237,
    play_count: 12000000,
    comment_count: 18000,
    like_count: 420000,
  },
  {
    id: 2003,
    title: '稻香',
    artist_id: 5001,
    artist_name: '周杰伦',
    album_name: '魔杰座',
    album_cover: 'https://example.com/cover3.jpg',
    duration: 210,
    play_count: 18000000,
    comment_count: 32000,
    like_count: 600000,
  },
];

describe('SongListTable', () => {
  it('renders song list with correct headers', () => {
    render(
      <SongListTable
        songs={mockSongs}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    expect(screen.getByText('歌曲')).toBeInTheDocument();
    expect(screen.getByText('歌手')).toBeInTheDocument();
    expect(screen.getByText('专辑')).toBeInTheDocument();
    expect(screen.getByText('播放次数')).toBeInTheDocument();
    expect(screen.getByText('时长')).toBeInTheDocument();
  });

  it('renders song titles correctly', () => {
    render(
      <SongListTable
        songs={mockSongs}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    expect(screen.getByText('晴天')).toBeInTheDocument();
    expect(screen.getByText('叶惠美')).toBeInTheDocument();
    // Multiple songs by same artist, use getAllByText
    const artists = screen.getAllByText('周杰伦');
    expect(artists).toHaveLength(3);
  });

  it('formats duration correctly', () => {
    render(
      <SongListTable
        songs={mockSongs}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    // 253s → 4:13, 237s → 3:57, 210s → 3:30
    expect(screen.getByText('4:13')).toBeInTheDocument();
    expect(screen.getByText('3:57')).toBeInTheDocument();
    expect(screen.getByText('3:30')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(
      <SongListTable songs={[]} playingSongId={null} onPlaySong={() => {}} isLoading error={null} />
    );

    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(
      <SongListTable
        songs={[]}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error="加载失败"
      />
    );

    expect(screen.getByText('加载失败')).toBeInTheDocument();
  });

  it('shows empty state', () => {
    render(
      <SongListTable
        songs={[]}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    expect(screen.getByText('暂无歌曲')).toBeInTheDocument();
  });

  it('highlights currently playing song', () => {
    const { container } = render(
      <SongListTable
        songs={mockSongs}
        playingSongId={2002}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    // The playing song row should have the playing state classes
    const rows = container.querySelectorAll('[class*="grid"]');
    // Find the row containing "七里香"
    const qixiangRow = Array.from(rows).find(
      (row) => row.textContent?.includes('七里香') && !row.textContent?.includes('歌曲')
    );
    expect(qixiangRow?.className).toContain('bg-[#FCF0F0]');
    expect(qixiangRow?.className).toContain('text-[#C20C0C]');
  });

  it('calls onPlaySong when a song row is clicked', () => {
    const onPlay = vi.fn();
    render(
      <SongListTable
        songs={mockSongs}
        playingSongId={null}
        onPlaySong={onPlay}
        isLoading={false}
        error={null}
      />
    );

    fireEvent.click(screen.getByText('晴天'));
    expect(onPlay).toHaveBeenCalledWith(2001);
  });

  it('shows row numbers in correct order', () => {
    render(
      <SongListTable
        songs={mockSongs}
        playingSongId={null}
        onPlaySong={() => {}}
        isLoading={false}
        error={null}
      />
    );

    // Row numbers are rendered before each song
    const allNumbers = screen.getAllByText(/\d+/);
    const rowNumbers = allNumbers.filter((el) =>
      ['1', '2', '3'].includes(el.textContent?.trim() || '')
    );
    expect(rowNumbers[0].textContent?.trim()).toBe('1');
    expect(rowNumbers[1].textContent?.trim()).toBe('2');
    expect(rowNumbers[2].textContent?.trim()).toBe('3');
  });
});

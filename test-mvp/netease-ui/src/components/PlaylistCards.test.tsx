import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlaylistCards } from './PlaylistCards';
import type { Playlist } from '../types';

const mockPlaylists: Playlist[] = [
  {
    id: 10001,
    name: '周杰伦经典合集',
    cover_url: 'https://example.com/pl1.jpg',
    track_count: 4,
    song_ids: [2001, 2002],
    play_count: 15000000,
    comment_count: 25000,
    tags: ['华语', '流行'],
    creator: { id: 5001, name: '音乐控' },
    created_at: '2024-01-15',
  },
  {
    id: 10002,
    name: 'Taylor Swift精选',
    cover_url: 'https://example.com/pl2.jpg',
    track_count: 2,
    song_ids: [2005, 2006],
    play_count: 18000000,
    comment_count: 32000,
    tags: ['欧美', '流行'],
    creator: { id: 5002, name: '欧美音乐控' },
    created_at: '2024-02-20',
  },
];

describe('PlaylistCards', () => {
  it('should render playlists from data', () => {
    render(
      <PlaylistCards
        playlists={mockPlaylists}
        onItemClick={() => {}}
        isLoading={false}
        error={null}
      />
    );

    expect(screen.getByText('周杰伦经典合集')).toBeInTheDocument();
    expect(screen.getByText('Taylor Swift精选')).toBeInTheDocument();
  });

  it('should show loading state', () => {
    render(<PlaylistCards playlists={[]} onItemClick={() => {}} isLoading error={null} />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('should show error state with retry button', () => {
    render(
      <PlaylistCards
        playlists={[]}
        onItemClick={() => {}}
        isLoading={false}
        error="Network error"
      />
    );
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  it('should show empty state', () => {
    render(<PlaylistCards playlists={[]} onItemClick={() => {}} isLoading={false} error={null} />);
    expect(screen.getByText('暂无歌单')).toBeInTheDocument();
  });

  it('should call onItemClick when playlist is clicked', () => {
    const onItem = vi.fn();
    render(
      <PlaylistCards
        playlists={mockPlaylists}
        onItemClick={onItem}
        isLoading={false}
        error={null}
      />
    );
    fireEvent.click(screen.getByText('周杰伦经典合集'));
    expect(onItem).toHaveBeenCalledWith(10001);
  });

  it('should format play count correctly', () => {
    render(
      <PlaylistCards
        playlists={mockPlaylists}
        onItemClick={() => {}}
        isLoading={false}
        error={null}
      />
    );
    // 15000000 → "1500.0万"
    expect(screen.getByText(/1500/)).toBeInTheDocument();
  });
});

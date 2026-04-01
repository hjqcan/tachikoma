import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';
import type { Playlist } from '../types';

const mockPlaylists: Playlist[] = [
  {
    id: 1,
    name: '我的歌单',
    cover_url: 'https://example.com/cover.jpg',
    track_count: 10,
    song_ids: [1, 2],
    play_count: 50000,
    comment_count: 100,
    tags: ['pop'],
    creator: { id: 1, name: 'Test Creator' },
    created_at: '2024-01-01',
  },
  {
    id: 2,
    name: '我的收藏',
    cover_url: 'https://example.com/cover2.jpg',
    track_count: 5,
    song_ids: [3],
    play_count: 2000,
    comment_count: 10,
    tags: ['rock'],
    creator: { id: 2, name: 'Another Creator' },
    created_at: '2024-02-01',
  },
];

describe('Sidebar', () => {
  const defaultProps = {
    playlists: mockPlaylists,
    activeView: 'discover',
    onNavigate: vi.fn(),
  };

  it('renders online music navigation items', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByText('发现音乐')).toBeInTheDocument();
    expect(screen.getByText('播客')).toBeInTheDocument();
    expect(screen.getByText('朋友')).toBeInTheDocument();
    expect(screen.getByText('商城')).toBeInTheDocument();
    expect(screen.getByText('音乐人')).toBeInTheDocument();
  });

  it('renders my music section', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByText('本地与下载')).toBeInTheDocument();
    expect(screen.getByText('最近播放')).toBeInTheDocument();
    expect(screen.getByText('我喜欢的音乐')).toBeInTheDocument();
  });

  it('highlights the active navigation item', () => {
    const { rerender } = render(<Sidebar {...defaultProps} activeView="discover" />);

    const discoverBtn = screen.getByText('发现音乐').closest('button');
    expect(discoverBtn).toHaveClass('text-[#C20C0C]');

    rerender(<Sidebar {...defaultProps} activeView="my-music" />);
    const myMusicBtn = screen.getByText('我喜欢的音乐').closest('button');
    expect(myMusicBtn).toHaveClass('text-[#C20C0C]');
  });

  it('calls onNavigate when a nav item is clicked', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();

    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    await user.click(screen.getByText('发现音乐'));
    expect(onNavigate).toHaveBeenCalledWith('discover');
  });

  it('toggles collapsed state when collapse button is clicked', async () => {
    const user = userEvent.setup();

    const { container } = render(<Sidebar {...defaultProps} />);

    // Initially expanded
    const aside = container.querySelector('aside');
    expect(aside).toHaveClass('w-[200px]');
    expect(screen.getByText('发现音乐')).toBeInTheDocument();

    // The collapse button has the text "收起"
    await user.click(screen.getByText('收起'));

    // Should be collapsed now
    expect(aside).toHaveClass('w-14');
    // Labels should be hidden (only icons remain)
    expect(screen.queryByText('发现音乐')).not.toBeInTheDocument();
  });

  it('renders playlist section in expanded state', () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByText('创建的歌单')).toBeInTheDocument();
    expect(screen.getByText('我的歌单')).toBeInTheDocument();
    expect(screen.getByText('我的收藏')).toBeInTheDocument();
  });

  it('hides playlist section in collapsed state', async () => {
    const user = userEvent.setup();
    render(<Sidebar {...defaultProps} />);

    await user.click(screen.getByText('收起'));

    expect(screen.queryByText('创建的歌单')).not.toBeInTheDocument();
    expect(screen.queryByText('我的歌单')).not.toBeInTheDocument();
  });
});

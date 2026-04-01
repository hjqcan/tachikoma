import { useState } from 'react';
import type { Playlist } from '../types';

interface SidebarNavItem {
  label: string;
  icon: string;
  key: string;
}

export type SidebarProps = {
  playlists: Playlist[];
  activeView: string;
  onNavigate: (view: string) => void;
};

const onlineMusicNav: SidebarNavItem[] = [
  { label: '发现音乐', icon: 'music', key: 'discover' },
  { label: '播客', icon: 'mic', key: 'podcast' },
  { label: '朋友', icon: 'users', key: 'friends' },
  { label: '商城', icon: 'bag', key: 'mall' },
  { label: '音乐人', icon: 'star', key: 'musician' },
];

const myMusicNav: SidebarNavItem[] = [
  { label: '本地与下载', icon: 'folder', key: 'local' },
  { label: '最近播放', icon: 'clock', key: 'recent' },
  { label: '我喜欢的音乐', icon: 'heart', key: 'my-music' },
];

const ICON_MAP: Record<string, string> = {
  music: '♪',
  mic: '◉',
  users: '♩',
  bag: '⊞',
  star: '✦',
  folder: '⌁',
  clock: '⏱',
  heart: '♥',
  collapse: '◀',
  expand: '▶',
};

function NavIcon({ name }: { name: string }) {
  return (
    <span className="text-base leading-none opacity-80" aria-hidden="true">
      {ICON_MAP[name] || '·'}
    </span>
  );
}

function NavSection({
  title,
  items,
  activeView,
  onNavigate,
  collapsed,
}: {
  title: string;
  items: SidebarNavItem[];
  activeView: string;
  onNavigate: (view: string) => void;
  collapsed: boolean;
}) {
  return (
    <div className="mb-2">
      {!collapsed && (
        <h3 className="px-4 py-2 text-xs text-[#999999] font-medium tracking-wide">{title}</h3>
      )}
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onNavigate(item.key)}
          title={collapsed ? item.label : undefined}
          className={`w-full text-left px-4 py-2.5 text-sm transition-colors duration-150 flex items-center gap-3 ${
            activeView === item.key
              ? 'text-[#C20C0C] bg-[#FCF0F0] border-l-[3px] border-[#C20C0C] font-medium'
              : 'text-[#333333] hover:bg-[#E4E4E4] border-l-[3px] border-transparent'
          }`}
        >
          <NavIcon name={item.icon} />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </button>
      ))}
    </div>
  );
}

function PlaylistSection({
  playlists,
  collapsed,
}: {
  playlists: Playlist[];
  collapsed: boolean;
}) {
  if (collapsed) return null;
  return (
    <div className="mt-2 px-4">
      <h3 className="text-xs text-[#999999] font-medium mb-2">创建的歌单</h3>
      {playlists.slice(0, 3).map((pl) => (
        <div
          key={pl.id}
          className="py-1.5 text-xs text-[#666666] truncate cursor-pointer hover:text-[#C20C0C] transition-colors"
          title={pl.name}
        >
          {pl.name}
        </div>
      ))}
    </div>
  );
}

export function Sidebar({ playlists, activeView, onNavigate }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const widthClass = collapsed ? 'w-14' : 'w-[200px]';

  return (
    <aside
      className={`h-full flex flex-col bg-[#EDEDED] ${widthClass} transition-all duration-200 shrink-0 overflow-y-auto custom-scrollbar`}
    >
      <div className="pt-2 pb-2">
        <NavSection
          title="在线音乐"
          items={onlineMusicNav}
          activeView={activeView}
          onNavigate={onNavigate}
          collapsed={collapsed}
        />
      </div>
      <div className="border-t border-[#E4E4E4] pt-2 pb-2">
        <NavSection
          title="我的音乐"
          items={myMusicNav}
          activeView={activeView}
          onNavigate={onNavigate}
          collapsed={collapsed}
        />
        <PlaylistSection playlists={playlists} collapsed={collapsed} />
      </div>
      <div className="mt-auto border-t border-[#E4E4E4]">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full text-left px-4 py-2.5 text-sm text-[#999999] hover:bg-[#E4E4E4] transition-colors"
          aria-label={collapsed ? '展开始栏' : '收起栏'}
        >
          <NavIcon name={collapsed ? 'expand' : 'collapse'} />
          {!collapsed && <span className="ml-2">收起</span>}
        </button>
      </div>
    </aside>
  );
}

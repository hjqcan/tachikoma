import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Activity, Terminal, Layout, Settings } from 'lucide-react';
import clsx from 'clsx';

export function MainLayout() {
  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <h1 className="text-xl font-bold flex items-center gap-2 text-indigo-600">
            <Activity className="h-6 w-6" />
            AgentOps
          </h1>
          <p className="text-xs text-gray-500 mt-1">Tachikoma Observability</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          <NavItem to="/" icon={<Layout size={20} />} label="Dashboard" end />
          <NavItem to="/traces" icon={<Terminal size={20} />} label="Traces" />
          <NavItem to="/metrics" icon={<Activity size={20} />} label="Metrics" />
          <NavItem to="/settings" icon={<Settings size={20} />} label="Settings" />
        </nav>

        <div className="p-4 border-t border-gray-100 text-xs text-gray-400">
          v0.1.0
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({ icon, label, to, end }: { icon: React.ReactNode, label: string, to: string, end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => clsx(
        "flex items-center gap-3 px-3 py-2 rounded-md transition-colors",
        isActive ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-100"
      )}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

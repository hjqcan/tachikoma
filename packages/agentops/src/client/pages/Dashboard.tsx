import React, { useEffect, useState } from 'react';
import { LatencyChart, RequestVolumeChart } from '../components/Charts';
import { RegressionList } from '../components/Regressions';
import { Activity, Terminal, Layout, Settings, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import clsx from 'clsx';

interface DashboardStats {
  activeAgents: number;
  totalRequests: number;
  avgLatency: number;
  trends: {
    activeAgents: string;
    totalRequests: string;
    avgLatency: string;
  };
}

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch stats
    fetch('http://localhost:3002/api/stats')
      .then(res => res.json())
      .then(data => {
        setStats(data);
      })
      .catch(err => {
        console.error("Failed to fetch stats:", err);
      });

    // Fetch charts data
    fetch('http://localhost:3002/api/charts')
      .then(res => res.json())
      .then(data => {
        setChartData(data);
        setLoading(false); // Set loading false after both (or at least this one) are done
      })
      .catch(err => {
        console.error("Failed to fetch charts:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="p-8">Loading dashboard...</div>;
  }

  return (
    <div className="p-8 space-y-8">
      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <StatCard
          title="Active Agents"
          value={stats?.activeAgents.toString() || "0"}
          trend={stats?.trends.activeAgents || "+0"}
        />
        <StatCard
          title="Total Requests"
          value={stats?.totalRequests.toLocaleString() || "0"}
          trend={stats?.trends.totalRequests || "+0%"}
        />
        <StatCard
          title="Avg Latency"
          value={`${stats?.avgLatency || 0}ms`}
          trend={stats?.trends.avgLatency || "0%"}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
           <LatencyChart data={chartData} />
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
           <RequestVolumeChart data={chartData} />
        </div>
      </div>

      {/* Regressions & Activity Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RegressionList />

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h3 className="text-base font-semibold mb-4">Recent Activity</h3>
          <div className="space-y-4">
            <ActivityItem
              type="info"
              title="Agent 'Planner' started task #123"
              time="2 mins ago"
            />
            <ActivityItem
              type="warning"
              title="High latency detected in 'Search' tool"
              time="15 mins ago"
            />
            <ActivityItem
              type="success"
              title="Task #122 completed successfully"
              time="1 hour ago"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, trend }: { title: string, value: string, trend: string }) {
  const isPositive = trend.startsWith('+');
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <div className="text-sm text-gray-500 font-medium">{title}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold">{value}</span>
        <span className={clsx("text-sm font-medium", isPositive ? "text-green-600" : "text-red-600")}>
          {trend}
        </span>
      </div>
    </div>
  );
}

function ActivityItem({ type, title, time }: { type: 'info' | 'warning' | 'success' | 'error', title: string, time: string }) {
  const colors = {
    info: "bg-blue-100 text-blue-700",
    warning: "bg-yellow-100 text-yellow-700",
    success: "bg-green-100 text-green-700",
    error: "bg-red-100 text-red-700"
  };

  return (
    <div className="flex items-start gap-3">
      <div className={clsx("w-2 h-2 rounded-full mt-2 shrink-0",
        type === 'info' && "bg-blue-500",
        type === 'warning' && "bg-yellow-500",
        type === 'success' && "bg-green-500",
        type === 'error' && "bg-red-500"
      )} />
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-gray-500">{time}</div>
      </div>
    </div>
  );
}

import React from 'react';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import clsx from 'clsx';

interface EvalCase {
  id: string;
  objective: string;
  expected?: {
    success?: boolean;
    contains?: string[];
  };
}

interface RegressionSuite {
  id: string;
  name?: string;
  cases: EvalCase[];
}

export function RegressionList() {
  const [suite, setSuite] = React.useState<RegressionSuite | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch('http://localhost:3002/api/regressions')
      .then(res => res.json())
      .then(data => {
        setSuite(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch regressions:", err);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="p-4 text-gray-500">Loading regressions...</div>;
  if (!suite || !suite.cases.length) return <div className="p-4 text-gray-500">No regression tests found.</div>;

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold">Quality Flywheel: Regressions</h3>
        <span className="bg-indigo-50 text-indigo-700 px-2 py-1 rounded text-xs font-medium">
          {suite.cases.length} Cases
        </span>
      </div>

      <div className="space-y-3">
        {suite.cases.map(item => (
          <div key={item.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-md border border-gray-100 hover:border-gray-300 transition-colors">
            <div className="mt-0.5">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">
                {item.objective}
              </div>
              <div className="text-xs text-gray-500 mt-1 font-mono">
                ID: {item.id}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

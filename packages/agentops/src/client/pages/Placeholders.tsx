import React from 'react';

export function Traces() {
  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold mb-4">Traces</h2>
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center text-gray-500">
        No traces recorded yet.
      </div>
    </div>
  );
}

export function Metrics() {
  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold mb-4">Metrics</h2>
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 text-center text-gray-500">
        No metrics available.
      </div>
    </div>
  );
}

export function Settings() {
  return (
    <div className="p-8">
      <h2 className="text-2xl font-semibold mb-4">Settings</h2>
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
        <p className="text-gray-600">Dashboard configuration options will appear here.</p>
      </div>
    </div>
  );
}

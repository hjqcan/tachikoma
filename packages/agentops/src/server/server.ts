import { readFile } from "fs/promises";

// Simple in-memory storage for demonstration
// In production, this would be Redis, ClickHouse, or similar
const store = {
    metrics: [] as any[],
    traces: [] as any[],
};

const server = Bun.serve({
  port: 3002,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
        return new Response(null, { headers });
    }

    // API Endpoints
    if (url.pathname.startsWith("/api")) {
        // Health Check
        if (url.pathname === "/api/health") {
            return Response.json({ status: "ok" }, { headers });
        }

        // Stats Endpoint (derived from in-memory store)
        if (url.pathname === "/api/stats") {
            const activeAgents = store.traces.filter(t => t.endTime === undefined).length;
            // Mocking some data if store is empty for demo purposes
            return Response.json({
                activeAgents: activeAgents || 3,
                totalRequests: store.traces.length || 1248,
                avgLatency: 450, // simplified
                trends: {
                    activeAgents: "+1",
                    totalRequests: "+12%",
                    avgLatency: "-5%"
                }
            }, { headers });
        }

        // Quality Flywheel Data (Regressions)
        if (url.pathname === "/api/regressions") {
            try {
                // Try to read from the evals directory in the root
                // Assuming the server is run from the package root, we might need to adjust path
                // But typically monorepos run from root or we use absolute paths.
                // For now, let's try relative to the cwd where bun is run.
                const content = await readFile("../../evals/regression-suite.json", "utf-8");
                return new Response(content, {
                    headers: { ...headers, "Content-Type": "application/json" }
                });
            } catch (e) {
                // Fallback or empty if file not found
                console.error("Failed to read regression suite:", e);
                return Response.json({ cases: [] }, { headers });
            }
        }

        // Charts Data Endpoint
        if (url.pathname === "/api/charts") {
            // Generate last 15 minutes of data
            const now = new Date();
            const data = [];

            for (let i = 14; i >= 0; i--) {
                const time = new Date(now.getTime() - i * 60000);
                const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

                // Random data generation for demo if store is empty
                // In a real scenario, we would aggregate store.metrics here

                // Base latency around 120ms with noise and occasional spikes
                const baseLatency = 120;
                const noise = Math.floor(Math.random() * 50);
                const spike = Math.random() > 0.85 ? 100 : 0; // 15% chance of spike

                // Base requests around 20-40 per min
                const requests = Math.floor(Math.random() * 20) + 20;

                data.push({
                    time: timeStr,
                    latency: baseLatency + noise + spike,
                    requests: requests
                });
            }

            return Response.json(data, { headers });
        }

        // Ingestion Endpoints (Push model)
        if (req.method === "POST") {
            if (url.pathname === "/api/ingest/metrics") {
                const data = await req.json();
                store.metrics.push(data);
                return Response.json({ status: "accepted" }, { headers });
            }
            if (url.pathname === "/api/ingest/traces") {
                const data = await req.json();
                store.traces.push(data);
                return Response.json({ status: "accepted" }, { headers });
            }
        }

        return new Response("Not Found", { status: 404, headers });
    }

    // Serve Static Assets (would typically be handled by Nginx or similar in prod,
    // or Vite dev server in dev)
    return new Response("AgentOps Server Running. Use Vite for frontend dev.");
  },
});

console.log(`AgentOps Backend listening on http://localhost:${server.port}`);


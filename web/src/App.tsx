import { useEffect, useRef, useState } from "react";

type HealthResponse = {
  status: string;
  db: string;
  dbError?: string;
  timestamp: string;
};

type SpikeEvent = {
  id: number;
  source: string;
  message: string;
  createdAt: string;
};

// SPIKE-ONLY page. Proves API + DB + SSE integration
// (tasks/00-environment-spike.md). Not the real UI — no navigation,
// dashboards, or styling beyond what's needed to read the results.
export function App() {
  const [health, setHealth] = useState<HealthResponse | "loading" | "error">("loading");
  const [sseStatus, setSseStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [events, setEvents] = useState<SpikeEvent[]>([]);
  const [heartbeatCount, setHeartbeatCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => setHealth("error"));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.onopen = () => setSseStatus("open");
    es.onerror = () => setSseStatus("error");

    es.addEventListener("heartbeat", () => {
      setHeartbeatCount((n) => n + 1);
    });

    es.addEventListener("spike-event", (evt) => {
      const parsed = JSON.parse((evt as MessageEvent).data) as SpikeEvent;
      setEvents((prev) => [parsed, ...prev].slice(0, 50));
    });

    return () => {
      es.close();
      setSseStatus("closed");
    };
  }, []);

  return (
    <main style={{ fontFamily: "monospace", padding: "1rem", maxWidth: 720 }}>
      <h1>durable-runner — environment spike</h1>

      <section>
        <h2>API / DB status</h2>
        <pre>{JSON.stringify(health, null, 2)}</pre>
      </section>

      <section>
        <h2>SSE status</h2>
        <p>connection: {sseStatus}</p>
        <p>heartbeats received: {heartbeatCount}</p>
      </section>

      <section>
        <h2>spike_events (most recent 50, includes worker-experiment rows if it's running)</h2>
        {events.length === 0 ? (
          <p>none yet</p>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                [{e.createdAt}] {e.source}: {e.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

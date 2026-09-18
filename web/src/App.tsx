import { useEffect, useRef, useState } from "react";

type HealthResponse = {
  status: string;
  db: string;
  dbError?: string;
  timestamp: string;
};

type StepEvent = {
  id: number;
  stepId: string;
  workerId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
};

// SPIKE-ONLY page. Proves API + DB + SSE integration
// (tasks/00-environment-spike.md). Not the real UI — no navigation,
// dashboards, or styling beyond what's needed to read the results. Updated
// in Milestone 9 only so it keeps working against the durable event stream
// that replaced the spike endpoint; the real timeline UI is a later
// milestone.
export function App() {
  const [health, setHealth] = useState<HealthResponse | "loading" | "error">("loading");
  const [sseStatus, setSseStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [events, setEvents] = useState<StepEvent[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => setHealth("error"));
  }, []);

  useEffect(() => {
    // Reconnects are handled by the browser, which resends the durable id of
    // the last event it received as Last-Event-ID.
    const es = new EventSource("/api/events/stream");
    eventSourceRef.current = es;

    es.onopen = () => setSseStatus("open");
    es.onerror = () => setSseStatus("error");

    es.addEventListener("step-event", (evt) => {
      const parsed = JSON.parse((evt as MessageEvent).data) as StepEvent;
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
      </section>

      <section>
        <h2>step_events (most recent 50 received on this connection)</h2>
        {events.length === 0 ? (
          <p>none yet</p>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                [{e.createdAt}] #{e.id} {e.eventType} step={e.stepId.slice(0, 8)}
                {e.workerId ? ` worker=${e.workerId}` : ""} {JSON.stringify(e.data)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import "./app.css";

type HealthResponse = {
  status: string;
  db: string;
};

type StepEvent = {
  id: number;
  stepId: string;
  workerId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
};

const GITHUB_URL = "https://github.com/adamzatar/durable-runner";
const DEFAULT_VISIBLE_EVENTS = 10;

const FAILURE_SEQUENCE: { text: React.ReactNode; rejected?: boolean }[] = [
  { text: <>Worker A claims the task at <span className="v">version 1</span>.</> },
  { text: "A freezes while the task is running." },
  { text: "Its lease expires." },
  { text: <>Worker B claims the same task at <span className="v">version 2</span>.</> },
  { text: "B finishes and saves the result." },
  { text: <>A resumes and tries to complete using <span className="v">version 1</span>.</> },
  {
    text: (
      <>
        PostgreSQL rejects the write because <span className="v">version 1</span> no longer
        owns the task.
      </>
    ),
    rejected: true,
  },
];

const STACK = ["TypeScript", "Node.js", "PostgreSQL", "Fastify", "React", "Vite", "Drizzle", "Vitest"];

// createdAt arrives as a PostgreSQL timestamp string; take the clock time
// and milliseconds straight from it instead of re-parsing timezones.
function formatTime(createdAt: string): string {
  const match = createdAt.match(/(\d{2}:\d{2}:\d{2})\.(\d{3})/);
  return match ? `${match[1]}.${match[2]}` : createdAt;
}

function EventRow({ event }: { event: StepEvent }) {
  const attempt = typeof event.data.attemptCount === "number" ? event.data.attemptCount : null;
  const lease = typeof event.data.leaseVersion === "number" ? event.data.leaseVersion : null;
  const hasData = Object.keys(event.data).length > 0;

  return (
    <li className="event">
      <div className="event-line">
        <span className="event-time">{formatTime(event.createdAt)}</span>
        <span className="event-type">{event.eventType}</span>
        <span className="event-meta">step {event.stepId.slice(0, 8)}</span>
        {event.workerId && <span className="event-meta">{event.workerId}</span>}
        {attempt !== null && <span className="event-meta">attempt {attempt}</span>}
        {lease !== null && <span className="event-meta">lease v{lease}</span>}
      </div>
      {hasData && (
        <details className="event-data">
          <summary>data</summary>
          <pre>{JSON.stringify(event.data)}</pre>
        </details>
      )}
    </li>
  );
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | "loading" | "error">("loading");
  const [sseStatus, setSseStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [events, setEvents] = useState<StepEvent[]>([]);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/health/ready")
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

  const visibleEvents = showAllEvents ? events : events.slice(0, DEFAULT_VISIBLE_EVENTS);

  return (
    <main className="page">
      <header className="hero">
        <h1>Durable Runner</h1>
        <p className="lede">
          Durable Runner is a TypeScript task runner with workers that coordinate through
          PostgreSQL.
        </p>
        <p className="supporting">
          I wanted to handle a failure case where a worker claims a task, freezes long enough
          for another worker to take over, and then comes back and tries to finish the old
          task. Each claim gets a version number, so PostgreSQL can reject a late write from a
          worker that no longer owns the task.
        </p>
        <p>
          <a className="github-button" href={GITHUB_URL}>
            View on GitHub
          </a>
        </p>
      </header>

      <section aria-labelledby="sequence-heading">
        <h2 id="sequence-heading">What happens when a worker comes back late</h2>
        <p className="section-intro">
          <code>npm run demo:fencing</code> runs this sequence with separate worker processes.
        </p>
        <ol className="steps">
          {FAILURE_SEQUENCE.map((step, i) => (
            <li key={i} className={step.rejected ? "rejected" : undefined}>
              {step.text}
            </li>
          ))}
        </ol>
        <p className="section-note">
          Nothing cancels A's process when it loses the task. It can still wake up and run
          code. The version check in the database stops its old completion from replacing B's
          result.
        </p>
      </section>

      <section aria-labelledby="ownership-heading">
        <h2 id="ownership-heading">How ownership works</h2>
        <p>
          When a worker claims a task, the row stores its worker ID, lease expiration, and
          version number. The worker renews the lease while it runs.
        </p>
        <p>
          If the lease expires, the coordinator can make the task available again. The next
          claim increments the version.
        </p>
        <p>
          A completion, failure report, or lease renewal only succeeds if the worker and
          version still match the current task row.
        </p>
      </section>

      <section aria-labelledby="retry-heading">
        <h2 id="retry-heading">Retrying a task safely</h2>
        <p>A task body can run more than once.</p>
        <p>
          One case is a worker that performs a side effect and freezes before it records task
          completion. When another worker retries the task, it uses the same logical key. If
          the effect was already stored, the retry gets the existing result instead of
          creating another one.
        </p>
        <p>
          The current demo does this through a PostgreSQL effect table. Effects outside that
          table would need their own idempotency mechanism.
        </p>
      </section>

      <section aria-labelledby="tested-heading">
        <h2 id="tested-heading">What I tested</h2>
        <p className="section-intro">
          I ran these benchmarks locally on an Apple M2 with PostgreSQL, the coordinator, and
          all workers on the same machine. The repo contains the benchmark setup and detailed
          methodology.
        </p>
        <div className="metrics-primary">
          <div className="metric">
            <span className="metric-value">0 / 4,750</span>
            <span className="metric-label">stale worker writes accepted</span>
          </div>
          <div className="metric">
            <span className="metric-value">0 duplicate ownership grants</span>
            <span className="metric-label">across 200,266 successful claims</span>
          </div>
        </div>
        <div className="metric metric-secondary">
          <span className="metric-value">0 duplicate logical effects</span>
          <span className="metric-label">
            across 45,000 executions through the PostgreSQL effect table
          </span>
        </div>
        <p className="throughput">
          <span className="throughput-value">3,277 tasks/s</span> median throughput with 8
          local workers
        </p>
        <p className="section-note">
          Because everything ran on one machine, the throughput result is not a
          distributed-deployment benchmark.
        </p>
      </section>

      <section aria-labelledby="runs-heading">
        <h2 id="runs-heading">How it runs</h2>
        <p>
          PostgreSQL stores task state and coordinates claims. Workers are separate Node.js
          processes, and eligible tasks are claimed with <code>FOR UPDATE SKIP LOCKED</code>.
        </p>
        <p>
          A coordinator checks for expired leases and due retries. Task state changes and
          their corresponding events are written together in PostgreSQL. Fastify exposes the
          event history, and the page receives new events over Server-Sent Events.
        </p>
      </section>

      <section aria-labelledby="live-heading">
        <h2 id="live-heading">Live event stream</h2>
        <p className="section-intro">
          Task events are stored in PostgreSQL with the state change and streamed to this
          page over Server-Sent Events.
        </p>

        <dl className="status-list">
          <div className="status-row">
            <dt>API</dt>
            <dd>
              {health === "loading" && <span className="status-pill pending">checking</span>}
              {health === "error" && <span className="status-pill bad">unreachable</span>}
              {health !== "loading" && health !== "error" && (
                <span className={`status-pill ${health.status === "ok" ? "ok" : "bad"}`}>
                  {health.status === "ok" ? "healthy" : health.status}
                </span>
              )}
            </dd>
          </div>
          <div className="status-row">
            <dt>Database</dt>
            <dd>
              {health === "loading" && <span className="status-pill pending">checking</span>}
              {health === "error" && <span className="status-pill bad">unknown</span>}
              {health !== "loading" && health !== "error" && (
                <span className={`status-pill ${health.db === "ok" ? "ok" : "bad"}`}>
                  {health.db === "ok" ? "connected" : "error"}
                </span>
              )}
            </dd>
          </div>
          <div className="status-row">
            <dt>Event stream</dt>
            <dd>
              <span
                className={`status-pill ${
                  sseStatus === "open" ? "ok" : sseStatus === "connecting" ? "pending" : "bad"
                }`}
              >
                {sseStatus === "open"
                  ? "connected"
                  : sseStatus === "connecting"
                    ? "connecting"
                    : sseStatus === "closed"
                      ? "closed"
                      : "reconnecting"}
              </span>
            </dd>
          </div>
        </dl>

        {events.length === 0 ? (
          <p className="feed-empty">
            No events received on this connection yet. Tasks come from the demos and
            benchmark, not over HTTP, so the list is empty unless something is running
            against this database.
          </p>
        ) : (
          <>
            <ul className="feed">
              {visibleEvents.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
            {events.length > DEFAULT_VISIBLE_EVENTS && (
              <button
                type="button"
                className="show-more"
                onClick={() => setShowAllEvents((v) => !v)}
              >
                {showAllEvents ? "Show fewer" : `Show all ${events.length}`}
              </button>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="stack-heading">
        <h2 id="stack-heading">Stack</h2>
        <ul className="stack">
          {STACK.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <footer className="footer">
        <a href={GITHUB_URL}>github.com/adamzatar/durable-runner</a>
      </footer>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";

type Req = {
  id: number;
  title: string;
  year: number | null;
  media_type: string;
  status: string;
  feedback: string | null;
  item_count: number;
  done_count: number;
  failed_count: number;
  active_count: number;
  created_at: string;
};
type Item = {
  id: number;
  season: number | null;
  episode: number | null;
  title: string | null;
  status: string;
  attempts: number;
  file_path: string | null;
  failure: string | null;
  air_date: string | null;
};
type Plan = {
  id: number;
  request_id: number;
  payload: string;
  status: string;
  title?: string;
  year?: number | null;
  created_at: string;
};
type Torrent = {
  hash: string;
  title: string;
  status: string;
  progress: number;
  failure: string | null;
};
type Ev = {
  id: number;
  ts: string;
  level: string;
  message: string;
  request_id: number | null;
};
type Selection = {
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  itemIds: number[];
};

const j = (r: Response) => r.json();
const api = {
  requests: () => fetch("/api/requests").then(j) as Promise<Req[]>,
  request: (id: number) => fetch(`/api/requests/${id}`).then(j),
  pending: () => fetch("/api/plans/pending").then(j) as Promise<Plan[]>,
  events: () => fetch("/api/events?limit=200").then(j) as Promise<Ev[]>,
  settings: () => fetch("/api/settings").then(j) as Promise<Record<string, string>>,
  approve: (id: number) => fetch(`/api/plans/${id}/approve`, { method: "POST" }),
  reject: (id: number, feedback: string) =>
    fetch(`/api/plans/${id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    }),
  dismiss: (id: number) => fetch(`/api/requests/${id}`, { method: "DELETE" }),
  saveSettings: (s: Record<string, string>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }),
  tick: () => fetch("/api/tick", { method: "POST" }),
};

const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + "GB";
const se = (i: Item) =>
  i.season == null || i.season < 0
    ? "Movie"
    : `S${String(i.season).padStart(2, "0")}E${String(i.episode).padStart(2, "0")}`;

function Badge({ s }: { s: string }) {
  return <span className={`badge badge-${s}`}>{s}</span>;
}

function PlanCard({ plan, onDone }: { plan: Plan; onDone: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const payload = useMemo(
    () => JSON.parse(plan.payload) as { selections: Selection[]; reasoning: string },
    [plan.payload],
  );
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    onDone();
  };
  return (
    <div className="card">
      <div className="card-head">
        <strong>
          {plan.title} {plan.year ? `(${plan.year})` : ""}
        </strong>
        <span className="muted">plan #{plan.id}</span>
      </div>
      <ul className="selections">
        {payload.selections.map((s, i) => (
          <li key={i}>
            <code>{s.title}</code>
            <span className="muted">
              {" "}
              — {gb(s.size)} · {s.seeders} seeders · {s.indexer} · covers {s.itemIds.length} item(s)
            </span>
          </li>
        ))}
      </ul>
      <p className="reasoning">{payload.reasoning}</p>
      <div className="actions">
        <button disabled={busy} onClick={() => act(() => api.approve(plan.id))}>
          Approve
        </button>
        <input
          placeholder="rejection feedback (e.g. 'get the remux instead')"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <button
          className="danger"
          disabled={busy}
          onClick={() => act(() => api.reject(plan.id, feedback))}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function RequestRow_({ r, onDone }: { r: Req; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ items: Item[]; torrents: Torrent[]; events: Ev[] } | null>(
    null,
  );
  useEffect(() => {
    if (open) api.request(r.id).then(setDetail);
  }, [open, r.id]);
  const pct = r.item_count ? Math.round((100 * r.done_count) / r.item_count) : 0;
  return (
    <div className="card">
      <div className="card-head clickable" onClick={() => setOpen(!open)}>
        <div>
          <strong>
            {r.title} {r.year ? `(${r.year})` : ""}
          </strong>{" "}
          <span className="muted">{r.media_type}</span> <Badge s={r.status} />
        </div>
        <div className="progress-wrap">
          <span className="muted">
            {r.done_count}/{r.item_count}
            {r.failed_count > 0 ? ` · ${r.failed_count} failed` : ""}
            {r.active_count > 0 ? ` · ${r.active_count} active` : ""}
          </span>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      {open && detail && (
        <div className="detail">
          {detail.torrents.length > 0 && (
            <div className="section">
              <h4>Torrents</h4>
              {detail.torrents.map((t) => (
                <div key={t.hash} className="row">
                  <Badge s={t.status} />
                  <code className="grow">{t.title}</code>
                  <span className="muted">
                    {t.status === "downloading" ? `${Math.round(t.progress * 100)}%` : ""}
                    {t.failure ? ` ${t.failure}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="section">
            <h4>Items</h4>
            <div className="items-grid">
              {detail.items.map((i) => (
                <div key={i.id} className={`item item-${i.status}`} title={i.failure ?? i.file_path ?? ""}>
                  {se(i)}
                </div>
              ))}
            </div>
          </div>
          {detail.events.length > 0 && (
            <div className="section">
              <h4>History</h4>
              {detail.events.slice(0, 15).map((e) => (
                <div key={e.id} className={`row ev-${e.level}`}>
                  <span className="muted ts">{e.ts}</span>
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
          )}
          <div className="actions">
            <button
              className="danger"
              onClick={async () => {
                await api.dismiss(r.id);
                onDone();
              }}
            >
              Dismiss request
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Settings() {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.settings().then(setS);
  }, []);
  if (!s) return null;
  return (
    <div className="card">
      {Object.entries(s).map(([k, v]) => (
        <label key={k} className="setting">
          <span>{k}</span>
          {k === "quality_policy" ? (
            <textarea rows={6} value={v} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
          ) : (
            <input value={v} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
          )}
        </label>
      ))}
      <div className="actions">
        <button
          onClick={async () => {
            await api.saveSettings(s);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<"requests" | "approvals" | "activity" | "settings">("requests");
  const [requests, setRequests] = useState<Req[]>([]);
  const [pending, setPending] = useState<Plan[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [showDone, setShowDone] = useState(false);

  const refresh = () => {
    api.requests().then(setRequests);
    api.pending().then(setPending);
    api.events().then(setEvents);
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const visible = requests.filter((r) => showDone || r.status === "active" || r.status === "failed");

  return (
    <div className="app">
      <header>
        <h1>⛏️ Quarry</h1>
        <nav>
          {(["requests", "approvals", "activity", "settings"] as const).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t}
              {t === "approvals" && pending.length > 0 && <span className="pill">{pending.length}</span>}
            </button>
          ))}
        </nav>
        <button className="ghost" onClick={() => api.tick()}>
          run now
        </button>
      </header>

      {tab === "requests" && (
        <main>
          <label className="toggle">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            show completed
          </label>
          {visible.map((r) => (
            <RequestRow_ key={r.id} r={r} onDone={refresh} />
          ))}
          {visible.length === 0 && <p className="muted empty">Nothing in flight. Request something in Jellyseerr.</p>}
        </main>
      )}
      {tab === "approvals" && (
        <main>
          {pending.map((p) => (
            <PlanCard key={p.id} plan={p} onDone={refresh} />
          ))}
          {pending.length === 0 && <p className="muted empty">No plans waiting for approval.</p>}
        </main>
      )}
      {tab === "activity" && (
        <main>
          <div className="card">
            {events.map((e) => (
              <div key={e.id} className={`row ev-${e.level}`}>
                <span className="muted ts">{e.ts}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        </main>
      )}
      {tab === "settings" && (
        <main>
          <Settings />
        </main>
      )}
    </div>
  );
}

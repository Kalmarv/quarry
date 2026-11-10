import { useCallback, useEffect, useState } from "react";
import { api, type Req } from "./api";
import { RequestList, RequestPane, defaultSelection } from "./Requests";
import { Activity } from "./Activity";
import { Settings } from "./Settings";

/** #r/123 selects a request; #activity and #settings take over the right pane. */
type View = { kind: "request"; id: number | null } | { kind: "activity" } | { kind: "settings" };

const viewFromHash = (): View => {
  const h = location.hash.slice(1);
  if (h === "activity" || h === "settings") return { kind: h };
  const m = /^r\/(\d+)$/.exec(h);
  return { kind: "request", id: m ? Number(m[1]) : null };
};

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [requests, setRequests] = useState<Req[] | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    api.requests().then(setRequests);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const selectedId =
    view.kind === "request" ? (view.id ?? (requests ? defaultSelection(requests) : null)) : null;
  const selected = requests?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="side">
        <header className="side-top">
          <h1 className="wordmark">
            <a href="#">Quarry</a>
          </h1>
          <button
            className="btn"
            disabled={syncing}
            title="Poll Seerr, qBittorrent and Jellyfin now instead of waiting for the next 2-minute check"
            onClick={async () => {
              setSyncing(true);
              await api.sync();
              setTimeout(() => {
                refresh();
                setSyncing(false);
              }, 1500);
            }}
          >
            {syncing ? "Checking…" : "Check now"}
          </button>
        </header>
        <nav className="side-nav">
          <a href="#activity" aria-current={view.kind === "activity" ? "page" : undefined}>
            Activity
          </a>
          <a href="#settings" aria-current={view.kind === "settings" ? "page" : undefined}>
            Settings
          </a>
        </nav>
        {requests && <RequestList requests={requests} selectedId={selectedId} />}
      </aside>

      <main className="pane">
        {view.kind === "activity" && <Activity />}
        {view.kind === "settings" && <Settings />}
        {view.kind === "request" && selected && <RequestPane key={selected.id} r={selected} onChange={refresh} />}
        {view.kind === "request" && requests && !selected && (
          <p className="empty">No requests yet. Approve one in Seerr and it shows up here within two minutes.</p>
        )}
      </main>
    </div>
  );
}

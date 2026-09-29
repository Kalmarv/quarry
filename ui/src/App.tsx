import { useCallback, useEffect, useState } from "react";
import { api, type Req } from "./api";
import { Requests } from "./Requests";
import { Activity } from "./Activity";
import { Settings } from "./Settings";

const TABS = [
  { key: "requests", label: "Requests" },
  { key: "activity", label: "Activity" },
  { key: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  return TABS.some((t) => t.key === h) ? (h as Tab) : "requests";
};

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
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
    const onHash = () => setTab(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const needsYou = requests?.filter((r) => r.phase === "review" || r.phase === "failed").length ?? 0;

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">Quarry</h1>
        <nav>
          {TABS.map((t) => (
            <a key={t.key} href={`#${t.key}`} className="tab" aria-current={tab === t.key ? "page" : undefined}>
              {t.label}
              {t.key === "requests" && needsYou > 0 && (
                <span className="tab-alert" aria-label={`${needsYou} need you`}>
                  {needsYou}
                </span>
              )}
            </a>
          ))}
        </nav>
        <button
          className="btn btn-quiet sync"
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

      {tab === "requests" && requests && <Requests requests={requests} onChange={refresh} />}
      {tab === "activity" && <Activity />}
      {tab === "settings" && <Settings />}
    </div>
  );
}

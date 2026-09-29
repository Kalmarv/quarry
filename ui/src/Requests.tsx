import { useEffect, useMemo, useState } from "react";
import { api, parsePlan, type Item, type Phase, type Plan, type Req, type RequestDetail } from "./api";
import { ago, clock, dayLabel, episodeCode, plural, shortDate, size, untilDate, untilTs } from "./format";

type SectionDef = {
  key: string;
  title: string;
  phases: Phase[];
  sort: (a: Req, b: Req) => number;
  limit?: number; // rows shown before "Show all"
};

const byId = (a: Req, b: Req) => b.id - a.id;
/** Ascending, with nulls placed first or last. */
const asc = (x: string | null, y: string | null, nulls: "first" | "last") => {
  if (x === y) return 0;
  if (x === null) return nulls === "first" ? -1 : 1;
  if (y === null) return nulls === "first" ? 1 : -1;
  return x < y ? -1 : 1;
};

// Ordered by who has to act next: you, then quarry, then the calendar.
const SECTIONS: SectionDef[] = [
  { key: "attention", title: "Needs you", phases: ["review", "failed"], sort: byId },
  {
    key: "downloading",
    title: "Downloading",
    phases: ["downloading"],
    sort: (a, b) => (b.download_progress ?? 0) - (a.download_progress ?? 0),
  },
  {
    key: "searching",
    title: "Still looking",
    phases: ["searching"],
    sort: (a, b) => asc(a.next_select_at, b.next_select_at, "first") || byId(a, b), // searching now first
  },
  {
    key: "upcoming",
    title: "Coming out",
    phases: ["upcoming"],
    // Undated films sort last: they're the furthest away in practice.
    sort: (a, b) => asc(a.next_air_date, b.next_air_date, "last") || byId(a, b),
    limit: 6,
  },
];

const RECENT_DONE = 8;
const LONG_SHOT_DAYS = 7;

/** Backed off past a week: repeatedly not found, rarely worth a glance. */
const isLongShot = (r: Req) =>
  r.phase === "searching" &&
  r.next_select_at !== null &&
  new Date(r.next_select_at.replace(" ", "T") + "Z").getTime() - Date.now() > LONG_SHOT_DAYS * 86_400_000;

export function Requests({ requests, onChange }: { requests: Req[]; onChange: () => void }) {
  const longShots = requests.filter(isLongShot).sort((a, b) => b.select_misses - a.select_misses || byId(a, b));
  const done = requests
    .filter((r) => r.phase === "done" && r.status !== "dismissed")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const needsYou = requests.some((r) => r.phase === "review" || r.phase === "failed");

  return (
    <main className="requests">
      {!needsYou && <p className="all-clear">Nothing needs you right now.</p>}
      {SECTIONS.map((s) => {
        const rows = requests.filter((r) => s.phases.includes(r.phase) && !isLongShot(r)).sort(s.sort);
        if (rows.length === 0) return null;
        return <Section key={s.key} phaseKey={s.key} title={s.title} rows={rows} limit={s.limit} onChange={onChange} />;
      })}
      {longShots.length > 0 && (
        <Section phaseKey="longshots" title="Long shots" rows={longShots} limit={0} onChange={onChange}>
          Not found after repeated searches, so checked less and less often.
        </Section>
      )}
      {done.length > 0 && (
        <Section phaseKey="done" title="Done" rows={done} limit={RECENT_DONE} onChange={onChange} />
      )}
    </main>
  );
}

function Section(props: {
  phaseKey: string;
  title: string;
  rows: Req[];
  limit?: number;
  onChange: () => void;
  children?: React.ReactNode; // a note shown under the heading
}) {
  const { rows, limit } = props;
  const [all, setAll] = useState(false);
  const shown = all || limit === undefined ? rows : rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  return (
    <section className={`section phase-${props.phaseKey}`}>
      <h2>
        {props.title} <span className="count">{rows.length}</span>
      </h2>
      {props.children && <p className="section-note">{props.children}</p>}
      <div className="rows">
        {shown.map((r) => (
          <RequestRow key={r.id} r={r} onChange={props.onChange} />
        ))}
        {(hidden > 0 || (all && limit !== undefined && rows.length > limit)) && (
          <button className="link more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "Show fewer" : shown.length === 0 ? `Show ${plural(rows.length, "title")}` : `Show ${hidden} more`}
          </button>
        )}
      </div>
    </section>
  );
}

function requester(r: Req): string {
  if (r.source === "letterboxd") return "Letterboxd pick";
  if (r.requested_by) return `for ${r.requested_by}`;
  return r.source === "manual" ? "added manually" : "";
}

function describe(r: Req): string {
  const kind = r.media_type === "movie" ? "Film" : "Series";
  const parts = [kind];
  if (r.media_type === "tv" && r.item_count > 0) parts.push(`${r.done_count} of ${plural(r.item_count, "episode")}`);
  const who = requester(r);
  if (who) parts.push(who);
  return parts.join(", ");
}

/** The right-hand status: one plain phrase, plus a quieter detail line. */
function Status({ r }: { r: Req }) {
  let main: React.ReactNode;
  let sub: string | null = null;
  switch (r.phase) {
    case "review":
      main = "Plan ready";
      sub = "approve or reject below";
      break;
    case "failed":
      main = "Gave up";
      sub = `${r.failed_count} of ${plural(r.item_count, "item")} failed every attempt; retry or dismiss`;
      break;
    case "downloading": {
      const pct = Math.floor((r.download_progress ?? 0) * 100);
      main = (
        <span className="progress">
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>
          {pct}%
        </span>
      );
      sub = r.media_type === "tv" ? plural(r.active_count, "episode") : null;
      break;
    }
    case "searching": {
      const missing = r.media_type === "tv" ? `${r.wanted_count} missing` : null;
      if (!r.next_select_at) {
        main = missing ?? "Searching";
        sub = "searching now";
      } else {
        main = r.select_misses > 0 ? (missing ?? "Not found yet") : (missing ?? "Waiting to search");
        sub =
          r.select_misses > 0
            ? `${plural(r.select_misses, "search", "searches")} so far, next ${untilTs(r.next_select_at)}`
            : `next search ${untilTs(r.next_select_at)}`;
      }
      break;
    }
    case "upcoming":
      if (!r.next_air_date) {
        main = "No date yet";
        sub = r.media_type === "movie" ? "waiting for a home release" : "next season not scheduled";
      } else {
        main = r.media_type === "movie" ? shortDate(r.next_air_date) : `Next ep ${shortDate(r.next_air_date)}`;
        sub = untilDate(r.next_air_date);
      }
      break;
    case "done":
      main = r.status === "dismissed" ? "Dismissed" : "In library";
      sub = ago(r.updated_at);
      break;
  }
  return (
    <div className="status">
      <div className="status-main">{main}</div>
      {sub && <div className="status-sub">{sub}</div>}
    </div>
  );
}

function RequestRow({ r, onChange }: { r: Req; onChange: () => void }) {
  // Plans awaiting a decision open by default: that's why the row is at the top.
  const [open, setOpen] = useState(r.phase === "review");
  return (
    <div className={`row ${open ? "open" : ""}`}>
      <button className="row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <div className="ident">
          <div className="title">
            {r.title}
            {r.year && <span className="year">{r.year}</span>}
          </div>
          <div className="meta">{describe(r)}</div>
        </div>
        <Status r={r} />
      </button>
      {open && <Detail r={r} onChange={onChange} />}
    </div>
  );
}

function Detail({ r, onChange }: { r: Req; onChange: () => void }) {
  const [d, setD] = useState<RequestDetail | null>(null);
  const [historyAll, setHistoryAll] = useState(false);

  useEffect(() => {
    const load = () => api.request(r.id).then(setD);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [r.id]);

  if (!d) return <div className="detail loading">Loading…</div>;

  const plan = d.plans[0];
  const liveTorrents = d.torrents.filter((t) => t.status !== "imported");
  const importedCount = d.torrents.length - liveTorrents.length;
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    onChange();
  };

  return (
    <div className="detail">
      {plan?.status === "pending" && <PlanReview plan={plan} onChange={onChange} />}

      {r.media_type === "tv" && d.items.length > 0 && <Episodes items={d.items} />}

      {plan && plan.status !== "pending" && <LatestPick plan={plan} />}

      {liveTorrents.length > 0 && (
        <div className="block">
          <h3>Torrents</h3>
          <ul className="torrents">
            {liveTorrents.map((t) => (
              <li key={t.hash} className={`torrent t-${t.status}`}>
                <span className="release">{t.title}</span>
                <span className="torrent-state">
                  {t.status === "failed"
                    ? t.failure
                    : t.status === "completed"
                      ? "importing"
                      : `${Math.floor(t.progress * 100)}%${t.size ? ` of ${size(t.size)}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
          {importedCount > 0 && <p className="quiet">{plural(importedCount, "earlier torrent")} already imported.</p>}
        </div>
      )}

      {d.events.length > 0 && (
        <div className="block">
          <h3>History</h3>
          <ol className="history">
            {(historyAll ? d.events : d.events.slice(0, 6)).map((e) => (
              <li key={e.id} className={`ev ev-${e.level}`}>
                <time dateTime={e.ts} title={e.ts + " UTC"}>
                  {dayLabel(e.ts)} {clock(e.ts)}
                </time>
                <span>{e.message}</span>
              </li>
            ))}
          </ol>
          {d.events.length > 6 && (
            <button className="link" onClick={() => setHistoryAll(!historyAll)}>
              {historyAll ? "Show less" : `Show all ${d.events.length} entries`}
            </button>
          )}
        </div>
      )}

      {(r.status === "active" || r.status === "failed") && (
        <div className="detail-actions">
          <span className="quiet">
            Requested {shortDate(new Date(r.created_at.replace(" ", "T") + "Z"))}
            {r.last_select_at ? `, last searched ${ago(r.last_select_at)}` : ""}
          </span>
          {r.failed_count > 0 && (
            <button className="btn btn-primary" onClick={() => act(() => api.retry(r.id))}>
              Try again
            </button>
          )}
          {r.phase === "searching" && r.next_select_at && (
            <button className="btn" onClick={() => act(() => api.searchNow(r.id))}>
              Search now
            </button>
          )}
          <button
            className="btn btn-quiet"
            onClick={() => {
              if (confirm(`Stop acquiring ${r.title}?`)) act(() => api.dismiss(r.id));
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

const EP_STATUS: Record<Item["status"], string> = {
  done: "in library",
  downloading: "downloading",
  importing: "importing",
  grabbing: "downloading",
  selecting: "searching",
  wanted: "missing",
  unaired: "not aired",
  failed: "gave up",
};

function Episodes({ items }: { items: Item[] }) {
  const seasons = useMemo(() => {
    const m = new Map<number, Item[]>();
    for (const i of items) m.set(i.season, [...(m.get(i.season) ?? []), i]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [items]);
  return (
    <div className="block">
      <h3>Episodes</h3>
      <div className="seasons">
        {seasons.map(([season, eps]) => {
          const have = eps.filter((e) => e.status === "done").length;
          return (
            <div key={season} className="season">
              <span className="season-name">{season === 0 ? "Specials" : `Season ${season}`}</span>
              <span className="eps">
                {eps.map((e) => (
                  <span
                    key={e.id}
                    className={`ep ep-${e.status}`}
                    title={[
                      episodeCode(e.season, e.episode),
                      e.title,
                      EP_STATUS[e.status],
                      e.status === "unaired" ? (e.air_date ? `airs ${shortDate(e.air_date)}` : "no air date") : null,
                      e.failure,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {e.episode}
                  </span>
                ))}
              </span>
              <span className="season-count">
                {have === eps.length ? "complete" : `${have} of ${eps.length}`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="legend" aria-hidden>
        {(["done", "downloading", "wanted", "unaired", "failed"] as const).map((s) =>
          items.some((i) => i.status === s || (s === "downloading" && i.status === "importing")) ? (
            <span key={s}>
              <span className={`ep ep-${s} swatch`} /> {EP_STATUS[s]}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function Selections({ plan }: { plan: Plan }) {
  const p = parsePlan(plan);
  return (
    <>
      <ul className="picks">
        {p.selections.map((s, i) => (
          <li key={i}>
            <span className="release">{s.title}</span>
            <span className="pick-facts">
              {size(s.size)}, {plural(s.seeders, "seeder")}, {s.indexer}
              {s.itemIds.length > 1 ? `, covers ${s.itemIds.length} episodes` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p className="reasoning">{p.reasoning}</p>
    </>
  );
}

function LatestPick({ plan }: { plan: Plan }) {
  return (
    <details className="block pick">
      <summary>
        <h3>Latest pick</h3>
        <span className="quiet">
          {plan.status}, {ago(plan.created_at)}
        </span>
      </summary>
      <Selections plan={plan} />
      {plan.feedback && <p className="quiet">Your feedback: {plan.feedback}</p>}
    </details>
  );
}

function PlanReview({ plan, onChange }: { plan: Plan; onChange: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    onChange();
  };
  return (
    <div className="block review">
      <h3>Proposed download</h3>
      <Selections plan={plan} />
      <div className="review-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.approve(plan.id))}>
          Approve
        </button>
        <input
          aria-label="What to do differently"
          placeholder="Or say what to do differently, e.g. “get the remux”"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <button className="btn" disabled={busy} onClick={() => act(() => api.reject(plan.id, feedback))}>
          Reject
        </button>
      </div>
    </div>
  );
}

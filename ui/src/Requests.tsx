import { useEffect, useMemo, useState } from "react";
import { api, parsePlan, tmdbImage, type Item, type Phase, type Plan, type Req, type RequestDetail } from "./api";
import { ago, clock, dayLabel, episodeCode, plural, shortDate, size, untilDate, untilTs } from "./format";

type GroupDef = {
  key: string;
  title: string;
  phases: Phase[];
  sort: (a: Req, b: Req) => number;
  limit?: number; // rows shown before "Show all"
  note?: string;
};

const byId = (a: Req, b: Req) => b.id - a.id;
/** Ascending, with nulls placed first or last. */
const asc = (x: string | null, y: string | null, nulls: "first" | "last") => {
  if (x === y) return 0;
  if (x === null) return nulls === "first" ? -1 : 1;
  if (y === null) return nulls === "first" ? 1 : -1;
  return x < y ? -1 : 1;
};

const LONG_SHOT_DAYS = 7;

/** Backed off past a week: repeatedly not found, rarely worth a glance. */
const isLongShot = (r: Req) =>
  r.phase === "searching" &&
  r.next_select_at !== null &&
  new Date(r.next_select_at.replace(" ", "T") + "Z").getTime() - Date.now() > LONG_SHOT_DAYS * 86_400_000;

// Ordered by who has to act next: you, then quarry, then the calendar.
const GROUPS: GroupDef[] = [
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
    limit: 8,
  },
  {
    key: "longshots",
    title: "Long shots",
    phases: ["searching"],
    sort: (a, b) => b.select_misses - a.select_misses || byId(a, b),
    limit: 0,
    note: "Not found after repeated searches, so checked less and less often.",
  },
  {
    key: "done",
    title: "In library",
    phases: ["done"],
    sort: (a, b) => (a.updated_at < b.updated_at ? 1 : -1),
    limit: 12,
  },
];

function groupRows(g: GroupDef, requests: Req[]): Req[] {
  return requests
    .filter((r) => {
      if (!g.phases.includes(r.phase)) return false;
      if (g.key === "longshots") return isLongShot(r);
      if (g.key === "searching") return !isLongShot(r);
      if (g.key === "done") return r.status !== "dismissed";
      return true;
    })
    .sort(g.sort);
}

/** What to show when nothing is selected: the most pressing request. */
export function defaultSelection(requests: Req[]): number | null {
  for (const g of GROUPS) {
    const rows = groupRows(g, requests);
    if (rows.length) return rows[0]!.id;
  }
  return null;
}

export function RequestList({ requests, selectedId }: { requests: Req[]; selectedId: number | null }) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q ? requests.filter((r) => r.title.toLowerCase().includes(q)) : requests;
  return (
    <>
      <div className="filter">
        <input
          type="search"
          placeholder="Filter titles"
          aria-label="Filter titles"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="list">
        {GROUPS.map((g) => {
          const rows = groupRows(g, shown);
          if (rows.length === 0) return null;
          // A filter shows every match; otherwise long groups start folded.
          return <Group key={g.key} g={g} rows={rows} selectedId={selectedId} folded={!q} />;
        })}
        {shown.length === 0 && <p className="empty">{q ? "No titles match." : "No requests yet."}</p>}
      </div>
    </>
  );
}

function Group({ g, rows, selectedId, folded }: { g: GroupDef; rows: Req[]; selectedId: number | null; folded: boolean }) {
  const [all, setAll] = useState(false);
  const limit = folded && !all ? g.limit : undefined;
  const visible = limit === undefined ? rows : rows.slice(0, limit);
  const hidden = rows.length - visible.length;
  return (
    <section className={`group g-${g.key}`}>
      <h2>
        <span>{g.title}</span>
        <span className="count">{rows.length}</span>
      </h2>
      {g.note && visible.length > 0 && <p className="group-note">{g.note}</p>}
      {visible.map((r) => (
        <Row key={r.id} r={r} selected={r.id === selectedId} />
      ))}
      {folded && g.limit !== undefined && rows.length > g.limit && (
        <button className="link more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : visible.length === 0 ? `Show ${plural(rows.length, "title")}` : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
}

function Poster({ r, width }: { r: Req; width: "w92" | "w342" }) {
  const src = tmdbImage(r.poster_path, width);
  if (!src) return <span className="poster poster-none" aria-hidden />;
  // Downloading: the poster develops from grey to colour as it fills.
  if (r.phase === "downloading") {
    const undone = 100 - Math.floor((r.download_progress ?? 0) * 100);
    return (
      <span className="poster developing">
        <img className="grey" src={src} alt="" />
        <img className="colour" src={src} alt="" style={{ clipPath: `inset(${undone}% 0 0 0)` }} />
      </span>
    );
  }
  return (
    <span className="poster">
      <img src={src} alt="" loading="lazy" />
    </span>
  );
}

function Row({ r, selected }: { r: Req; selected: boolean }) {
  const s = statusOf(r);
  return (
    <a className={`row ph-${r.phase}`} href={`#r/${r.id}`} aria-current={selected ? "true" : undefined}>
      <Poster r={r} width="w92" />
      <span className="row-text">
        <span className="dot" aria-hidden />
        <span className="row-title">{r.title}</span>
        <span className="row-sub">{s.short}</span>
        {r.phase === "downloading" && (
          <span className="bar" aria-hidden>
            <span style={{ width: `${Math.floor((r.download_progress ?? 0) * 100)}%` }} />
          </span>
        )}
      </span>
    </a>
  );
}

function requester(r: Req): string {
  if (r.source === "letterboxd") return "Letterboxd pick";
  if (r.requested_by) return `for ${r.requested_by}`;
  return r.source === "manual" ? "added manually" : "";
}

/** One plain phrase for where a request stands, a short form for the list, and a detail line. */
function statusOf(r: Req): { main: string; short: string; sub: string | null } {
  switch (r.phase) {
    case "review":
      return { main: "Plan waiting for approval", short: "approve?", sub: null };
    case "failed":
      return {
        main: "Gave up",
        short: "gave up",
        sub: `${r.failed_count} of ${plural(r.item_count, "item")} failed every attempt`,
      };
    case "downloading": {
      const pct = `${Math.floor((r.download_progress ?? 0) * 100)}%`;
      return {
        main: `Downloading, ${pct}`,
        short: pct,
        sub: r.media_type === "tv" ? plural(r.active_count, "episode") : null,
      };
    }
    case "searching": {
      const missing = r.media_type === "tv" ? `${r.wanted_count} missing` : null;
      if (!r.next_select_at) return { main: "Searching now", short: "searching now", sub: missing };
      const next = untilTs(r.next_select_at);
      return {
        main: r.select_misses > 0 ? "Not found yet" : "Waiting to search",
        short: `next ${next}`,
        sub: [missing, r.select_misses > 0 ? `${plural(r.select_misses, "search", "searches")} so far` : null, `next search ${next}`]
          .filter(Boolean)
          .join(", "),
      };
    }
    case "upcoming":
      if (!r.next_air_date)
        return {
          main: "No date yet",
          short: "no date",
          sub: r.media_type === "movie" ? "waiting for a home release" : "next season not scheduled",
        };
      return {
        main: r.media_type === "movie" ? `Out ${shortDate(r.next_air_date)}` : `Next episode ${shortDate(r.next_air_date)}`,
        short: shortDate(r.next_air_date),
        sub: untilDate(r.next_air_date),
      };
    case "done":
      return r.status === "dismissed"
        ? { main: "Dismissed", short: "dismissed", sub: null }
        : { main: "In library", short: ago(r.updated_at), sub: `added ${ago(r.updated_at)}` };
  }
}

export function RequestPane({ r, onChange }: { r: Req; onChange: () => void }) {
  const [d, setD] = useState<RequestDetail | null>(null);
  const [historyAll, setHistoryAll] = useState(false);

  useEffect(() => {
    const load = () => api.request(r.id).then(setD);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [r.id]);

  const s = statusOf(r);
  const backdrop = tmdbImage(r.backdrop_path, "w1280");
  const plan = d?.plans[0];
  const liveTorrents = d?.torrents.filter((t) => t.status !== "imported") ?? [];
  const importedCount = (d?.torrents.length ?? 0) - liveTorrents.length;
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    onChange();
  };

  return (
    <article className="detail">
      <div className="hero" style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined} />
      <header className="head">
        <Poster r={r} width="w342" />
        <div>
          <h2>{r.title}</h2>
          <p className="head-meta">
            {[r.media_type === "movie" ? "Film" : "Series", r.year, requester(r)].filter(Boolean).join(", ")}
          </p>
          <p className={`state ph-${r.phase}`}>
            <span className="dot" aria-hidden />
            {s.main}
            {s.sub && <span className="state-sub">{s.sub}</span>}
          </p>
        </div>
      </header>

      {!d && <p className="empty">Loading…</p>}

      {d && r.phase === "failed" && (
        <section className="card card-bad">
          <h3>Why it gave up</h3>
          <ul className="failures">
            {d.items
              .filter((i) => i.failure)
              .map((i) => (
                <li key={i.id}>
                  {i.season >= 0 && <span className="ep-code">{episodeCode(i.season, i.episode)}</span>} {i.failure}
                </li>
              ))}
          </ul>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => act(() => api.retry(r.id))}>
              Search again
            </button>
            <DismissButton r={r} act={act} />
          </div>
        </section>
      )}

      {plan?.status === "pending" && <PlanReview plan={plan} items={d!.items} onChange={onChange} />}

      {d && r.media_type === "tv" && d.items.length > 0 && <Episodes items={d.items} />}

      {plan && plan.status !== "pending" && <LatestPick plan={plan} items={d!.items} />}

      {liveTorrents.length > 0 && (
        <section className="card">
          <h3>Torrents</h3>
          <table className="rels">
            <tbody>
              {liveTorrents.map((t) => (
                <tr key={t.hash} className={`t-${t.status}`}>
                  <td className="release">{t.title}</td>
                  <td className="num">
                    {t.status === "failed"
                      ? t.failure
                      : t.status === "completed"
                        ? "importing"
                        : `${Math.floor(t.progress * 100)}%${t.size ? ` of ${size(t.size)}` : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {importedCount > 0 && <p className="quiet">{plural(importedCount, "earlier torrent")} already imported.</p>}
        </section>
      )}

      {d && !plan && d.items.length <= 1 && r.overview && (
        <section className="card">
          <p className="prose">{r.overview}</p>
        </section>
      )}

      {d && d.events.length > 0 && (
        <section className="card">
          <h3>History</h3>
          <ol className="history">
            {(historyAll ? d.events : d.events.slice(0, 8)).map((e) => (
              <li key={e.id} className={`ev ev-${e.level}`}>
                <time dateTime={e.ts} title={e.ts + " UTC"}>
                  {dayLabel(e.ts)} {clock(e.ts)}
                </time>
                <span>{e.message}</span>
              </li>
            ))}
          </ol>
          {d.events.length > 8 && (
            <button className="link" onClick={() => setHistoryAll(!historyAll)}>
              {historyAll ? "Show less" : `Show all ${d.events.length} entries`}
            </button>
          )}
        </section>
      )}

      {(r.status === "active" || r.status === "failed") && r.phase !== "failed" && (
        <div className="actions footer-actions">
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
          <DismissButton r={r} act={act} />
        </div>
      )}
    </article>
  );
}

function DismissButton({ r, act }: { r: Req; act: (fn: () => Promise<unknown>) => void }) {
  return (
    <button
      className="btn btn-quiet"
      onClick={() => {
        if (confirm(`Stop acquiring ${r.title}?`)) act(() => api.dismiss(r.id));
      }}
    >
      Dismiss
    </button>
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
    <section className="card">
      <h3>Episodes</h3>
      <div className="matrix">
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
                      .join(", ")}
                  />
                ))}
              </span>
              <span className="season-count">{have === eps.length ? "complete" : `${have}/${eps.length}`}</span>
            </div>
          );
        })}
      </div>
      <div className="legend" aria-hidden>
        {(["done", "downloading", "wanted", "unaired", "failed"] as const).map((s) =>
          items.some((i) => i.status === s || (s === "downloading" && (i.status === "importing" || i.status === "grabbing"))) ? (
            <span key={s}>
              <span className={`ep ep-${s}`} /> {EP_STATUS[s]}
            </span>
          ) : null,
        )}
      </div>
    </section>
  );
}

/** Which of the request's items a release covers, in words. */
function covers(itemIds: number[], items: Item[]): string {
  const its = items.filter((i) => itemIds.includes(i.id));
  if (its.length === 0) return "";
  if (its[0]!.season < 0) return "the film";
  const seasons = [...new Set(its.map((i) => i.season))];
  if (seasons.length === 1 && its.length === items.filter((i) => i.season === seasons[0]).length)
    return `all of season ${seasons[0]}`;
  if (its.length === 1) return episodeCode(its[0]!.season, its[0]!.episode);
  return plural(its.length, "episode");
}

function Selections({ plan, items }: { plan: Plan; items: Item[] }) {
  const p = parsePlan(plan);
  return (
    <>
      <p className="prose">{p.reasoning}</p>
      <table className="rels">
        <thead>
          <tr>
            <th>Release</th>
            <th>Covers</th>
            <th className="num">Size</th>
            <th className="num">Seeders</th>
          </tr>
        </thead>
        <tbody>
          {p.selections.map((s, i) => (
            <tr key={i}>
              <td className="release" title={s.indexer}>
                {s.title}
              </td>
              <td>{covers(s.itemIds, items)}</td>
              <td className="num">{size(s.size)}</td>
              <td className="num">{s.seeders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function LatestPick({ plan, items }: { plan: Plan; items: Item[] }) {
  return (
    <details className="card pick">
      <summary>
        <h3>What the model picked</h3>
        <span className="quiet">
          {plan.status}, {ago(plan.created_at)}
        </span>
      </summary>
      <Selections plan={plan} items={items} />
      {plan.feedback && <p className="quiet">Your note: {plan.feedback}</p>}
    </details>
  );
}

function PlanReview({ plan, items, onChange }: { plan: Plan; items: Item[]; onChange: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    onChange();
  };
  return (
    <section className="card card-ask">
      <h3>Plan waiting for you</h3>
      <Selections plan={plan} items={items} />
      <div className="actions">
        {rejecting ? (
          <>
            <textarea
              autoFocus
              aria-label="What to do differently"
              placeholder="What should it do differently? For example: 1080p is fine for this one."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.reject(plan.id, feedback))}>
              Reject and search again
            </button>
            <button className="btn btn-quiet" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.approve(plan.id))}>
              Approve plan
            </button>
            <button className="btn" onClick={() => setRejecting(true)}>
              Reject with a note
            </button>
          </>
        )}
      </div>
    </section>
  );
}

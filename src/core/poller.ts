import { db, logEvent, type RequestRow } from "../db";
import * as seerr from "../clients/seerr";
import { snapshot } from "../clients/jellyfin";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Upsert one episode/movie item. Returns true if newly created. */
function upsertItem(opts: {
  requestId: number;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season: number | null;
  episode: number | null;
  title: string | null;
  airDate: string | null;
  inLibrary: boolean;
}): boolean {
  const aired = !opts.airDate || opts.airDate <= today();
  const status = opts.inLibrary ? "done" : aired ? "wanted" : "unaired";
  const res = db()
    .prepare(
      `INSERT INTO items (request_id, media_type, tmdb_id, season, episode, title, air_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tmdb_id, season, episode) DO NOTHING`,
    )
    .run(
      opts.requestId,
      opts.mediaType,
      opts.tmdbId,
      opts.season,
      opts.episode,
      opts.title,
      opts.airDate,
      status,
    );
  return res.changes > 0;
}

async function createItemsForTv(req: RequestRow, seasons: number[]) {
  const snap = await snapshot();
  let created = 0;
  for (const season of seasons) {
    const episodes = await seerr.getSeasonEpisodes(req.tmdb_id, season);
    for (const ep of episodes) {
      const inLibrary = snap.episodes.has(`${req.tmdb_id}:${season}:${ep.episodeNumber}`);
      if (
        upsertItem({
          requestId: req.id,
          mediaType: "tv",
          tmdbId: req.tmdb_id,
          season,
          episode: ep.episodeNumber,
          title: ep.name,
          airDate: ep.airDate,
          inLibrary,
        })
      )
        created++;
    }
  }
  return created;
}

/** Pull approved Seerr requests and materialize requests + items. */
export async function pollSeerr() {
  const approved = await seerr.listApprovedRequests();
  const d = db();
  const known = new Set(
    (d.prepare("SELECT seerr_request_id FROM requests").all() as { seerr_request_id: number }[]).map(
      (r) => r.seerr_request_id,
    ),
  );

  for (const sr of approved) {
    if (known.has(sr.id)) continue;
    const tmdbId = sr.media.tmdbId;
    const mediaType = sr.media.mediaType;

    let title: string;
    let year: number | null;
    let availableDate: string | null = null;
    let seasons: number[] = [];
    if (mediaType === "movie") {
      const m = await seerr.getMovie(tmdbId);
      title = m.title;
      availableDate = m.availableDate;
      year = m.releaseDate ? Number(m.releaseDate.slice(0, 4)) : null;
    } else {
      const t = await seerr.getTv(tmdbId);
      title = t.name;
      year = t.firstAirDate ? Number(t.firstAirDate.slice(0, 4)) : null;
      seasons = sr.seasons.length
        ? sr.seasons.map((s) => s.seasonNumber)
        : t.seasons.map((s) => s.seasonNumber).filter((n) => n > 0);
    }

    const res = d
      .prepare(
        `INSERT INTO requests (seerr_request_id, media_type, tmdb_id, title, year, requested_seasons)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(seerr_request_id) DO NOTHING`,
      )
      .run(sr.id, mediaType, tmdbId, title, year, JSON.stringify(seasons));
    if (res.changes === 0) continue;
    const req = d
      .prepare("SELECT * FROM requests WHERE seerr_request_id = ?")
      .get(sr.id) as RequestRow;

    let created = 0;
    if (mediaType === "movie") {
      const snap = await snapshot();
      if (
        upsertItem({
          requestId: req.id,
          mediaType,
          tmdbId,
          season: null,
          episode: null,
          title,
          airDate: availableDate, // theatrical-only movies wait for digital/physical
          inLibrary: snap.movies.has(tmdbId),
        })
      )
        created++;
    } else {
      created = await createItemsForTv(req, seasons);
    }
    logEvent({
      message: `New request: ${title}${year ? ` (${year})` : ""} — ${created} item(s) to acquire`,
      requestId: req.id,
      data: { seerrRequestId: sr.id, seasons },
    });
  }
}

/** Flip unaired items whose air date has passed; refresh episode lists of airing shows daily. */
export async function refreshAiring() {
  const d = db();
  const flipped = d
    .prepare(
      "UPDATE items SET status = 'wanted', updated_at = datetime('now') WHERE status = 'unaired' AND air_date IS NOT NULL AND air_date <= ? RETURNING id",
    )
    .all(today()) as { id: number }[];
  for (const f of flipped) {
    logEvent({ message: "Episode aired — now wanted", itemId: f.id });
  }

  // Movies waiting on a home release: re-check availability daily. TMDB often
  // adds the digital date late, so this both moves air_date earlier when a
  // digital date appears and corrects items that became wanted prematurely.
  const movieReqs = d
    .prepare(
      `SELECT * FROM requests WHERE status = 'active' AND media_type = 'movie'
       AND updated_at < datetime('now', '-1 day')
       AND EXISTS (
         SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status IN ('unaired', 'wanted')
         AND NOT EXISTS (SELECT 1 FROM torrent_items ti WHERE ti.item_id = i.id)
       )`,
    )
    .all() as RequestRow[];
  for (const req of movieReqs) {
    const m = await seerr.getMovie(req.tmdb_id);
    const aired = !m.availableDate || m.availableDate <= today();
    d.prepare(
      `UPDATE items SET air_date = ?, status = ?, updated_at = datetime('now')
       WHERE request_id = ? AND status IN ('unaired', 'wanted')
       AND NOT EXISTS (SELECT 1 FROM torrent_items ti WHERE ti.item_id = items.id)
       AND status != ?`,
    ).run(m.availableDate, aired ? "wanted" : "unaired", req.id, aired ? "wanted" : "unaired");
    d.prepare("UPDATE requests SET updated_at = datetime('now') WHERE id = ?").run(req.id);
  }

  // Airing shows get new episode rows as TMDB announces them.
  const stale = d
    .prepare(
      `SELECT * FROM requests WHERE status = 'active' AND media_type = 'tv'
       AND updated_at < datetime('now', '-1 day')
       AND EXISTS (SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status = 'unaired')`,
    )
    .all() as RequestRow[];
  for (const req of stale) {
    const seasons = JSON.parse(req.requested_seasons) as number[];
    const created = await createItemsForTv(req, seasons);
    d.prepare("UPDATE requests SET updated_at = datetime('now') WHERE id = ?").run(req.id);
    if (created > 0)
      logEvent({ message: `Refreshed episode list: ${created} new episode(s)`, requestId: req.id });
  }
}

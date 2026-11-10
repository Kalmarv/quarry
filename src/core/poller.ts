import { existsSync } from "node:fs";
import { db, logEvent, touchItem, type ItemRow, type RequestRow } from "../db";
import * as seerr from "../clients/seerr";
import { snapshot } from "../clients/jellyfin";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A missing date means different things per type: a movie with no home
 * release date is typically an older film that's long been out, but an
 * episode with no air date has been announced and not scheduled.
 */
function isAired(mediaType: "movie" | "tv", airDate: string | null): boolean {
  return airDate ? airDate <= today() : mediaType === "movie";
}

/**
 * Upsert one episode/movie item. Returns true if newly created. Existing items
 * that haven't been acquired (unaired/wanted) track TMDB's latest title and
 * air date, including moving back to unaired if the date slips; anything
 * further along is left alone.
 */
export function upsertItem(opts: {
  requestId: number;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season: number | null;
  episode: number | null;
  title: string | null;
  airDate: string | null;
  inLibrary: boolean;
}): boolean {
  const d = db();
  const aired = isAired(opts.mediaType, opts.airDate);
  // -1 sentinels for movies: SQLite unique indexes treat NULL != NULL, so
  // NULL season/episode would let movie items duplicate.
  const season = opts.season ?? -1;
  const episode = opts.episode ?? -1;

  const existing = d
    .prepare("SELECT id, status FROM items WHERE tmdb_id = ? AND season = ? AND episode = ?")
    .get(opts.tmdbId, season, episode) as Pick<ItemRow, "id" | "status"> | null;
  if (existing) {
    // Library presence never demotes: re-requests deliberately re-want items
    // Jellyfin still lists (see adoptExistingItems).
    if (existing.status === "unaired" || existing.status === "wanted")
      d.prepare(
        `UPDATE items SET title = $title, air_date = $air, status = $status, updated_at = datetime('now')
         WHERE id = $id AND (title IS NOT $title OR air_date IS NOT $air OR status != $status)`,
      ).run({
        $id: existing.id,
        $title: opts.title,
        $air: opts.airDate,
        $status: aired ? "wanted" : "unaired",
      });
    return false;
  }

  d.prepare(
    `INSERT INTO items (request_id, media_type, tmdb_id, season, episode, title, air_date, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.requestId,
    opts.mediaType,
    opts.tmdbId,
    season,
    episode,
    opts.title,
    opts.airDate,
    opts.inLibrary ? "done" : aired ? "wanted" : "unaired",
  );
  return true;
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

/**
 * A re-request of media quarry already tracks: move the existing items onto
 * the new request and re-verify 'done' ones — the file may have been deleted
 * since (that is usually why someone re-requests). Items quarry imported are
 * checked directly on disk; items that were only ever seen in Jellyfin are
 * checked against a fresh snapshot.
 */
async function adoptExistingItems(req: RequestRow, seasons: number[]): Promise<number> {
  const d = db();
  const rows =
    req.media_type === "movie"
      ? (d
          .prepare(
            "SELECT * FROM items WHERE tmdb_id = ? AND (season IS NULL OR season = -1) AND request_id != ?",
          )
          .all(req.tmdb_id, req.id) as ItemRow[])
      : seasons.length
        ? (d
            .prepare(
              `SELECT * FROM items WHERE tmdb_id = ? AND season IN (${seasons.map(() => "?").join(",")}) AND request_id != ?`,
            )
            .all(req.tmdb_id, ...seasons, req.id) as ItemRow[])
        : [];
  let recovered = 0;
  for (const it of rows) {
    d.prepare("UPDATE items SET request_id = ?, updated_at = datetime('now') WHERE id = ?").run(
      req.id,
      it.id,
    );
    if (it.status === "done") {
      // Disk is authoritative when quarry imported the file itself. When it
      // didn't (pre-v2 content, file_path null), Jellyfin's index lags real
      // deletions — so trust the re-request itself: Seerr only allows
      // re-requesting media its own sync considers missing, and if the file
      // does still exist the import is idempotent and will no-op.
      const present = it.file_path ? existsSync(it.file_path) : false;
      if (!present) {
        touchItem(it.id, { status: "wanted", file_path: null, failure: null, attempts: 0 });
        recovered++;
        logEvent({
          message: "Previously fulfilled but not verifiable on disk — re-acquiring",
          requestId: req.id,
          itemId: it.id,
        });
      }
    } else if (it.status === "failed") {
      touchItem(it.id, { status: "wanted", attempts: 0, failure: null });
      recovered++;
    }
  }
  return recovered;
}

let requestersBackfilled = false;

/**
 * Fill requested_by on Seerr requests from before it was tracked. Once per
 * process: requests deleted from Seerr stay unknown, and re-paging every
 * tick for them would be waste.
 */
async function backfillRequesters() {
  if (requestersBackfilled) return;
  const d = db();
  const missing = d
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE source = 'seerr' AND requested_by IS NULL")
    .get() as { n: number };
  if (missing.n > 0) {
    const upd = d.prepare(
      "UPDATE requests SET requested_by = ? WHERE source = 'seerr' AND source_key = ? AND requested_by IS NULL",
    );
    for (const sr of await seerr.listRequests("all"))
      if (sr.requestedBy?.displayName) upd.run(sr.requestedBy.displayName, String(sr.id));
  }
  requestersBackfilled = true;
}

/** Pull approved Seerr requests and materialize requests + items. */
export async function pollSeerr() {
  await backfillRequesters();
  const approved = await seerr.listRequests("approved");
  const d = db();
  const known = new Set(
    (
      d.prepare("SELECT source_key FROM requests WHERE source = 'seerr'").all() as {
        source_key: string;
      }[]
    ).map((r) => r.source_key),
  );

  for (const sr of approved) {
    if (known.has(String(sr.id))) continue;
    const requestedBy = sr.requestedBy?.displayName ?? null;
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
        `INSERT INTO requests (source, source_key, media_type, tmdb_id, title, year, requested_seasons, requested_by)
         VALUES ('seerr', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_key) DO NOTHING`,
      )
      .run(String(sr.id), mediaType, tmdbId, title, year, JSON.stringify(seasons), requestedBy);
    if (res.changes === 0) continue;
    const req = d
      .prepare("SELECT * FROM requests WHERE source = 'seerr' AND source_key = ?")
      .get(String(sr.id)) as RequestRow;

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
    const adopted = await adoptExistingItems(req, seasons);
    logEvent({
      message: `New request: ${title}${year ? ` (${year})` : ""} — ${created + adopted} item(s) to acquire`,
      requestId: req.id,
      data: { seerrRequestId: sr.id, seasons },
    });
  }
}

const ARTWORK_PER_TICK = 40;

/** Look up poster, backdrop and synopsis for requests that don't have them, a few per tick. */
export async function fillArtwork() {
  const d = db();
  const rows = d
    .prepare("SELECT id, media_type, tmdb_id FROM requests WHERE poster_path IS NULL ORDER BY id DESC LIMIT ?")
    .all(ARTWORK_PER_TICK) as Pick<RequestRow, "id" | "media_type" | "tmdb_id">[];
  const upd = d.prepare("UPDATE requests SET poster_path = ?, backdrop_path = ?, overview = ? WHERE id = ?");
  for (const r of rows) {
    const m = r.media_type === "movie" ? await seerr.getMovie(r.tmdb_id) : await seerr.getTv(r.tmdb_id);
    upd.run(m.posterPath ?? "", m.backdropPath, m.overview, r.id);
  }
}

/** Flip unaired items whose air date has passed; refresh episode lists of airing shows daily. */
export async function refreshAiring() {
  const d = db();

  // Movies waiting on a home release: re-check availability daily, before the
  // flip below, so a stale date can't make an item wanted. TMDB often adds the
  // digital date late — the theatrical+90d fallback is then replaced by the
  // real date, in either direction (Nolan's The Odyssey: fallback 2026-10-13,
  // actual digital 2026-11-17).
  const movieReqs = d
    .prepare(
      `SELECT * FROM requests WHERE status = 'active' AND media_type = 'movie'
       AND updated_at < datetime('now', '-1 day')
       AND EXISTS (
         SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status IN ('unaired', 'wanted')
       )`,
    )
    .all() as RequestRow[];
  for (const req of movieReqs) {
    const m = await seerr.getMovie(req.tmdb_id);
    upsertItem({
      requestId: req.id,
      mediaType: "movie",
      tmdbId: req.tmdb_id,
      season: null,
      episode: null,
      title: req.title,
      airDate: m.availableDate,
      inLibrary: false,
    });
    d.prepare("UPDATE requests SET updated_at = datetime('now') WHERE id = ?").run(req.id);
  }

  const flipped = d
    .prepare(
      "UPDATE items SET status = 'wanted', updated_at = datetime('now') WHERE status = 'unaired' AND air_date IS NOT NULL AND air_date <= ? RETURNING id",
    )
    .all(today()) as { id: number }[];
  for (const f of flipped) {
    logEvent({ message: "Episode aired — now wanted", itemId: f.id });
  }

  // Airing shows get new episode rows and air-date corrections as TMDB
  // announces them. Undated wanted episodes predate the unaired-if-undated
  // rule; refreshing them is what moves them back to unaired.
  const stale = d
    .prepare(
      `SELECT * FROM requests WHERE status = 'active' AND media_type = 'tv'
       AND updated_at < datetime('now', '-1 day')
       AND EXISTS (
         SELECT 1 FROM items i WHERE i.request_id = requests.id
         AND (i.status = 'unaired' OR (i.status = 'wanted' AND i.air_date IS NULL))
       )`,
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

import { db, getSetting, setSetting, logEvent, type RequestRow } from "../db";
import * as lb from "../clients/letterboxd";
import * as seerr from "../clients/seerr";
import { snapshot } from "../clients/jellyfin";
import { upsertItem } from "./poller";

const POLL_EVERY_HOURS = 20;

/** Slug -> TMDB ids, via lb_films cache or a film-page fetch. Null = unresolvable today. */
async function resolveFilm(slug: string): Promise<{ tmdb_id: number; tmdb_type: string } | null> {
  const d = db();
  const cached = d.prepare("SELECT tmdb_id, tmdb_type FROM lb_films WHERE slug = ?").get(slug) as
    | { tmdb_id: number; tmdb_type: string }
    | null;
  if (cached) return cached;
  try {
    await Bun.sleep(1000); // pace film-page fetches
    const ids = await lb.filmTmdb(slug);
    d.prepare("INSERT OR REPLACE INTO lb_films (slug, tmdb_id, tmdb_type) VALUES (?, ?, ?)").run(
      slug,
      ids.tmdbId,
      ids.tmdbType,
    );
    return { tmdb_id: ids.tmdbId, tmdb_type: ids.tmdbType };
  } catch (e) {
    // Not cached: transient page trouble should retry on the next poll.
    logEvent({
      level: "warn",
      message: `Letterboxd: could not resolve '${slug}' to TMDB: ${e instanceof Error ? e.message : e}`,
    });
    return null;
  }
}

/**
 * Auto-request films trending on Letterboxd this month whose average rating
 * clears letterboxd_min_rating. Films still theatrical-only enter as 'unaired'
 * via availableDate, exactly like Seerr movie requests — no cam grabs.
 */
export async function pollLetterboxd() {
  if (getSetting("letterboxd_enabled") !== "true") return;
  const last = getSetting("letterboxd_last_poll");
  const cutoff = new Date(Date.now() - POLL_EVERY_HOURS * 3600_000).toISOString();
  if (last && last > cutoff) return;
  // Stamp before fetching: a mid-poll failure waits for tomorrow instead of
  // hammering letterboxd every 2-minute tick.
  setSetting("letterboxd_last_poll", new Date().toISOString());

  const minRating = Number(getSetting("letterboxd_min_rating")) || 3.9;
  const pages = Math.max(1, Number(getSetting("letterboxd_pages")) || 3);

  const films: lb.TrendingFilm[] = [];
  for (let p = 1; p <= pages; p++) films.push(...(await lb.popularThisMonth(p)));
  if (films.length === 0) {
    logEvent({
      level: "error",
      message: "Letterboxd: popular grid parsed to 0 films — markup may have changed",
    });
    return;
  }

  const candidates = films.filter((f) => f.rating !== null && f.rating >= minRating);
  const d = db();
  let created = 0;

  for (const f of candidates) {
    if (
      d
        .prepare("SELECT 1 FROM requests WHERE source = 'letterboxd' AND source_key = ?")
        .get(f.slug)
    )
      continue;

    const film = await resolveFilm(f.slug);
    if (!film || film.tmdb_type !== "movie") continue;
    const tmdbId = film.tmdb_id;

    // Already tracked through any source (incl. dismissed — a dismissal is a
    // "no thanks", don't re-add), or already sitting in Jellyfin: skip.
    if (d.prepare("SELECT 1 FROM requests WHERE media_type = 'movie' AND tmdb_id = ?").get(tmdbId))
      continue;
    if (d.prepare("SELECT 1 FROM items WHERE media_type = 'movie' AND tmdb_id = ?").get(tmdbId))
      continue;
    if ((await snapshot()).movies.has(tmdbId)) continue;

    const m = await seerr.getMovie(tmdbId);
    const year = m.releaseDate ? Number(m.releaseDate.slice(0, 4)) : null;
    const res = d
      .prepare(
        `INSERT INTO requests (source, source_key, media_type, tmdb_id, title, year)
         VALUES ('letterboxd', ?, 'movie', ?, ?, ?)
         ON CONFLICT(source, source_key) DO NOTHING`,
      )
      .run(f.slug, tmdbId, m.title, year);
    if (res.changes === 0) continue;
    const req = d
      .prepare("SELECT * FROM requests WHERE source = 'letterboxd' AND source_key = ?")
      .get(f.slug) as RequestRow;

    upsertItem({
      requestId: req.id,
      mediaType: "movie",
      tmdbId,
      season: null,
      episode: null,
      title: m.title,
      airDate: m.availableDate, // theatrical-only films wait for a home release
      inLibrary: false,
    });
    created++;
    logEvent({
      message: `Letterboxd trending: ${m.title}${year ? ` (${year})` : ""} rated ${f.rating} — queued`,
      requestId: req.id,
      data: { slug: f.slug, rating: f.rating },
    });
  }

  logEvent({
    message: `Letterboxd poll: ${films.length} trending films, ${candidates.length} rated >= ${minRating}, ${created} new request(s)`,
  });
}

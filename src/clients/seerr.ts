import { config } from "../config";

async function get<T>(path: string): Promise<T> {
  const { SEERR_URL, SEERR_API_KEY } = config();
  const res = await fetch(`${SEERR_URL}/api/v1${path}`, {
    headers: { "X-Api-Key": SEERR_API_KEY },
  });
  if (!res.ok) throw new Error(`seerr GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export type SeerrRequest = {
  id: number;
  status: number; // 1 pending, 2 approved, 3 declined
  media: { tmdbId: number; mediaType: "movie" | "tv" };
  seasons: { seasonNumber: number }[];
  requestedBy: { displayName: string } | null;
};

/**
 * Requests, paginated. 'approved' is what quarry acts on; note Seerr drops
 * requests from it once their media is available, so history needs 'all'.
 */
export async function listRequests(filter: "approved" | "all"): Promise<SeerrRequest[]> {
  const out: SeerrRequest[] = [];
  let skip = 0;
  for (;;) {
    const page = await get<{ pageInfo: { pages: number; page: number }; results: SeerrRequest[] }>(
      `/request?take=100&skip=${skip}&filter=${filter}`,
    );
    out.push(...page.results);
    if (page.pageInfo.page >= page.pageInfo.pages || page.results.length === 0) break;
    skip += 100;
  }
  return out;
}

export type MovieDetails = {
  title: string;
  originalTitle: string | null;
  releaseDate: string | null;
  runtime: number | null; // minutes
  directors: string[];
  cast: string[]; // top-billed
  /** Earliest digital (4) / physical (5) release date in any region. */
  digitalDate: string | null;
  physicalDate: string | null;
  /**
   * When the movie can be acquired at real quality: the earlier of
   * digitalDate/physicalDate. When TMDB has neither, theatrical + 90 days as
   * a fallback. Null = no dates at all (an older film, long since out).
   */
  availableDate: string | null;
};

type ReleaseDates = {
  results?: { release_dates: { type: number; release_date: string }[] }[];
};

function earliestRelease(releases: ReleaseDates | undefined, type: number): string | null {
  let earliest: string | null = null;
  for (const region of releases?.results ?? []) {
    for (const rd of region.release_dates ?? []) {
      if (rd.type !== type) continue;
      const d = rd.release_date.slice(0, 10);
      if (!earliest || d < earliest) earliest = d;
    }
  }
  return earliest;
}

export async function getMovie(tmdbId: number): Promise<MovieDetails> {
  const m = await get<{
    title: string;
    originalTitle?: string;
    releaseDate?: string;
    runtime?: number;
    releases?: ReleaseDates;
    credits?: { cast?: { name: string }[]; crew?: { name: string; job: string }[] };
  }>(`/movie/${tmdbId}`);
  const releaseDate = m.releaseDate ?? null;
  const digitalDate = earliestRelease(m.releases, 4);
  const physicalDate = earliestRelease(m.releases, 5);

  let availableDate = [digitalDate, physicalDate].filter((d) => d !== null).sort()[0] ?? null;
  if (!availableDate && releaseDate) {
    const t = new Date(releaseDate);
    t.setDate(t.getDate() + 90);
    availableDate = t.toISOString().slice(0, 10);
  }
  return {
    title: m.title,
    originalTitle: m.originalTitle && m.originalTitle !== m.title ? m.originalTitle : null,
    releaseDate,
    runtime: m.runtime || null,
    directors: (m.credits?.crew ?? []).filter((c) => c.job === "Director").map((c) => c.name),
    cast: (m.credits?.cast ?? []).slice(0, 3).map((c) => c.name),
    digitalDate,
    physicalDate,
    availableDate,
  };
}

export type TvDetails = {
  name: string;
  originalName: string | null;
  firstAirDate: string | null;
  createdBy: string[];
  networks: string[];
  seasons: { seasonNumber: number; episodeCount: number }[];
};

export async function getTv(tmdbId: number): Promise<TvDetails> {
  const t = await get<{
    name: string;
    originalName?: string;
    firstAirDate?: string;
    createdBy?: { name: string }[];
    networks?: { name: string }[];
    seasons: { seasonNumber: number; episodeCount: number }[];
  }>(`/tv/${tmdbId}`);
  return {
    name: t.name,
    originalName: t.originalName && t.originalName !== t.name ? t.originalName : null,
    firstAirDate: t.firstAirDate ?? null,
    createdBy: (t.createdBy ?? []).map((c) => c.name),
    networks: (t.networks ?? []).map((n) => n.name),
    seasons: t.seasons ?? [],
  };
}

export type Episode = { episodeNumber: number; name: string | null; airDate: string | null };

export async function getSeasonEpisodes(tmdbId: number, season: number): Promise<Episode[]> {
  const s = await get<{ episodes: { episodeNumber: number; name?: string; airDate?: string }[] }>(
    `/tv/${tmdbId}/season/${season}`,
  );
  return (s.episodes ?? []).map((e) => ({
    episodeNumber: e.episodeNumber,
    name: e.name ?? null,
    airDate: e.airDate ?? null,
  }));
}

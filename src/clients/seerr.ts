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
};

/** All approved requests, paginated. */
export async function listApprovedRequests(): Promise<SeerrRequest[]> {
  const out: SeerrRequest[] = [];
  let skip = 0;
  for (;;) {
    const page = await get<{ pageInfo: { pages: number; page: number }; results: SeerrRequest[] }>(
      `/request?take=100&skip=${skip}&filter=approved`,
    );
    out.push(...page.results);
    if (page.pageInfo.page >= page.pageInfo.pages || page.results.length === 0) break;
    skip += 100;
  }
  return out;
}

export type MovieDetails = { title: string; releaseDate: string | null };

export async function getMovie(tmdbId: number): Promise<MovieDetails> {
  const m = await get<{ title: string; releaseDate?: string }>(`/movie/${tmdbId}`);
  return { title: m.title, releaseDate: m.releaseDate ?? null };
}

export type TvDetails = {
  name: string;
  firstAirDate: string | null;
  seasons: { seasonNumber: number; episodeCount: number }[];
};

export async function getTv(tmdbId: number): Promise<TvDetails> {
  const t = await get<{
    name: string;
    firstAirDate?: string;
    seasons: { seasonNumber: number; episodeCount: number }[];
  }>(`/tv/${tmdbId}`);
  return {
    name: t.name,
    firstAirDate: t.firstAirDate ?? null,
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

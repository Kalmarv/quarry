import { config } from "../config";

async function get<T>(path: string): Promise<T> {
  const { JELLYFIN_URL, JELLYFIN_API_KEY } = config();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${JELLYFIN_URL}${path}${sep}api_key=${JELLYFIN_API_KEY}`);
  if (!res.ok) throw new Error(`jellyfin GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export type LibrarySnapshot = {
  /** TMDB ids of movies present. */
  movies: Set<number>;
  /** "tmdbId:season:episode" keys of episodes present. */
  episodes: Set<string>;
  /** tmdbId -> on-disk series folder path (host view unavailable; used for folder naming hints). */
  seriesPaths: Map<number, string>;
  fetchedAt: number;
};

type JfItem = {
  Id: string;
  Name: string;
  Path?: string;
  ProviderIds?: Record<string, string>;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
};

let cache: LibrarySnapshot | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function snapshot(force = false): Promise<LibrarySnapshot> {
  if (!force && cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;

  const movies = await get<{ Items: JfItem[] }>(
    "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=ProviderIds&Limit=100000",
  );
  const movieSet = new Set<number>();
  for (const m of movies.Items) {
    const tmdb = Number(m.ProviderIds?.["Tmdb"] ?? m.ProviderIds?.["tmdb"]);
    if (tmdb) movieSet.add(tmdb);
  }

  const series = await get<{ Items: JfItem[] }>(
    "/Items?IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,Path&Limit=100000",
  );
  const seriesTmdb = new Map<string, number>();
  const seriesPaths = new Map<number, string>();
  for (const s of series.Items) {
    const tmdb = Number(s.ProviderIds?.["Tmdb"] ?? s.ProviderIds?.["tmdb"]);
    if (!tmdb) continue;
    seriesTmdb.set(s.Id, tmdb);
    if (s.Path) seriesPaths.set(tmdb, s.Path);
  }

  const episodes = await get<{ Items: JfItem[] }>(
    "/Items?IncludeItemTypes=Episode&Recursive=true&Fields=ParentIndexNumber,IndexNumber&Limit=200000",
  );
  const epSet = new Set<string>();
  for (const e of episodes.Items) {
    const tmdb = e.SeriesId ? seriesTmdb.get(e.SeriesId) : undefined;
    if (tmdb && e.ParentIndexNumber != null && e.IndexNumber != null) {
      epSet.add(`${tmdb}:${e.ParentIndexNumber}:${e.IndexNumber}`);
    }
  }

  cache = { movies: movieSet, episodes: epSet, seriesPaths, fetchedAt: Date.now() };
  return cache;
}

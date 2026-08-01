import { config } from "../config";

export type Release = {
  guid: string;
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  downloadUrl: string | null;
  magnetUrl: string | null;
};

const MOVIE_CATEGORIES = [2000];
const TV_CATEGORIES = [5000];

export async function search(query: string, mediaType: "movie" | "tv"): Promise<Release[]> {
  const { PROWLARR_URL, PROWLARR_API_KEY } = config();
  const cats = (mediaType === "movie" ? MOVIE_CATEGORIES : TV_CATEGORIES)
    .map((c) => `categories=${c}`)
    .join("&");
  const url = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(query)}&type=search&${cats}`;
  const res = await fetch(url, { headers: { "X-Api-Key": PROWLARR_API_KEY } });
  if (!res.ok) throw new Error(`prowlarr search -> ${res.status}`);
  const raw = (await res.json()) as {
    guid: string;
    title: string;
    indexer: string;
    size?: number;
    seeders?: number;
    downloadUrl?: string;
    magnetUrl?: string;
  }[];
  return raw.map((r) => ({
    guid: r.guid,
    title: r.title,
    indexer: r.indexer,
    size: r.size ?? 0,
    seeders: r.seeders ?? 0,
    downloadUrl: r.downloadUrl ?? null,
    magnetUrl: r.magnetUrl ?? null,
  }));
}

// Letterboxd has no public API; this reads the same CSI fragment endpoints the
// site's own frontend uses. Cloudflare challenges curl-like TLS fingerprints
// but passes Bun's fetch, so plain requests with a browser UA work. One grid
// fetch per page per day plus a film-page fetch per new threshold-crosser —
// deliberately gentle.

const BASE = "https://letterboxd.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

async function getHtml(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`letterboxd GET ${path} -> ${res.status}`);
  return res.text();
}

export type TrendingFilm = { slug: string; name: string; rating: number | null };

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#039;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|quot|#0?39|lt|gt);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Parse a films-browser CSI fragment: one `<li class="posteritem"
 * data-average-rating="4.39">` per film, film identity in data-item-* attrs on
 * the nested poster component. Unrated films carry no rating attribute.
 */
export function parsePopular(html: string): TrendingFilm[] {
  const out: TrendingFilm[] = [];
  for (const li of html.split('<li class="posteritem"').slice(1)) {
    const slug = li.match(/data-item-slug="([^"]+)"/);
    if (!slug) continue;
    const rating = li.match(/^[^>]*data-average-rating="([\d.]+)"/);
    const name = li.match(/data-item-name="([^"]+)"/);
    out.push({
      slug: slug[1]!,
      name: name ? decodeEntities(name[1]!) : slug[1]!,
      rating: rating ? Number(rating[1]) : null,
    });
  }
  return out;
}

/** One page (72 films) of the popular-this-month browser, most popular first. */
export async function popularThisMonth(page: number): Promise<TrendingFilm[]> {
  const pagePart = page > 1 ? `page/${page}/` : "";
  const html = await getHtml(
    `/csi/films/films-browser-list/popular/this/month/${pagePart}?esiAllowFilters=true`,
  );
  return parsePopular(html);
}

export type FilmIds = { tmdbId: number; tmdbType: string };

/** The film page's body tag carries data-tmdb-id / data-tmdb-type. */
export async function filmTmdb(slug: string): Promise<FilmIds> {
  const html = await getHtml(`/film/${slug}/`);
  const m = html.match(/<body[^>]*data-tmdb-type="([^"]+)"[^>]*data-tmdb-id="(\d+)"/);
  if (!m) throw new Error(`no TMDB id on film page for ${slug}`);
  return { tmdbId: Number(m[2]), tmdbType: m[1]! };
}

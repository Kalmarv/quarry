import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config";
import type { ItemRow, RequestRow } from "../db";
import type { LibrarySnapshot } from "../clients/jellyfin";

/** Strip characters that are illegal or troublesome in file names. */
export function sanitize(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const baseTitle = (s: string) => normalize(s.replace(/\(\d{4}\)\s*$/, ""));

/**
 * Resolve the top-level folder for a title deterministically:
 * 1. Jellyfin's own path for this series (authoritative — basename of its Path)
 * 2. An existing library folder whose name matches (year-aware: an exact
 *    "Title (Year)" match wins; a bare base-title match is used only when
 *    it is unambiguous, so Dune (1984) and Dune (2021) stay separate)
 * 3. A fresh "Title (Year)" folder
 */
export function resolveFolder(
  libraryRoot: string,
  title: string,
  year: number | null,
  jellyfinPath?: string | null,
): string {
  if (jellyfinPath) return basename(jellyfinPath);
  const wanted = year ? `${sanitize(title)} (${year})` : sanitize(title);
  let entries: string[] = [];
  try {
    entries = readdirSync(libraryRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return wanted;
  }
  const exact = entries.find((e) => normalize(e) === normalize(wanted));
  if (exact) return exact;
  const byBase = entries.filter((e) => baseTitle(e) === baseTitle(wanted));
  if (byBase.length === 1 && byBase[0]) {
    const m = /\((\d{4})\)\s*$/.exec(byBase[0]);
    if (!m || !year || Number(m[1]) === year) return byBase[0];
  }
  return wanted;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Build the final library destination for an item. The LLM never writes paths. */
export function destinationFor(
  item: ItemRow,
  request: RequestRow,
  ext: string,
  snap: LibrarySnapshot,
): string {
  const cfg = config();
  const title = sanitize(request.title);
  const year = request.year;
  if (item.media_type === "movie") {
    const folder = resolveFolder(cfg.LIBRARY_MOVIES, request.title, year, null);
    const name = year ? `${title} (${year})` : title;
    return join(cfg.LIBRARY_MOVIES, folder, `${name}${ext}`);
  }
  const folder = resolveFolder(
    cfg.LIBRARY_TV,
    request.title,
    year,
    snap.seriesPaths.get(request.tmdb_id) ?? null,
  );
  const s = item.season ?? 1;
  const e = item.episode ?? 1;
  const showName = year ? `${title} (${year})` : title;
  return join(
    cfg.LIBRARY_TV,
    folder,
    `Season ${pad(s)}`,
    `${showName} - S${pad(s)}E${pad(e)}${ext}`,
  );
}

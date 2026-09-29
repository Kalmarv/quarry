import { generateObject } from "ai";
import { z } from "zod";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, link, rename, rm, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { config } from "../config";
import { db, getSetting, logEvent, touchItem, type ItemRow, type RequestRow, type TorrentRow } from "../db";
import { modelFor, logDecision, openRouterCost } from "../llm";
import * as qbit from "../clients/qbittorrent";
import { refreshLibraries, snapshot } from "../clients/jellyfin";
import { destinationFor } from "./naming";
import { failTorrent } from "./monitor";

const MEDIA_EXT = new Set([".mkv", ".mp4", ".avi", ".m4v", ".webm", ".mov", ".ts"]);
const ARCHIVE_EXT = new Set([".rar", ".zip", ".7z"]);
const MIN_MEDIA_BYTES = 20 * 1024 * 1024;

type HostFile = { index: number; relPath: string; hostPath: string; size: number };

function mapToHost(qbitPath: string): string {
  const { QBIT_PATH_PREFIX, DOWNLOADS_PATH } = config();
  return qbitPath.startsWith(QBIT_PATH_PREFIX)
    ? DOWNLOADS_PATH + qbitPath.slice(QBIT_PATH_PREFIX.length)
    : qbitPath;
}

async function probeOk(path: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return false;
  try {
    const streams = (JSON.parse(out).streams ?? []) as { codec_type: string }[];
    return streams.some((s) => s.codec_type === "video") && streams.some((s) => s.codec_type === "audio");
  } catch {
    return false;
  }
}

/** Atomic place: hardlink if possible, else copy to .partial and rename. Exists = done. */
async function place(src: string, dest: string): Promise<"linked" | "copied" | "existed"> {
  if (existsSync(dest)) return "existed";
  mkdirSync(dirname(dest), { recursive: true });
  try {
    await link(src, dest);
    return "linked";
  } catch {
    const partial = `${dest}.quarry-partial`;
    await copyFile(src, partial);
    await rename(partial, dest);
    return "copied";
  }
}

async function extractArchives(files: HostFile[], hash: string): Promise<HostFile[]> {
  const { DOWNLOADS_PATH } = config();
  const first = files.find((f) => {
    const e = extname(f.relPath).toLowerCase();
    // Multi-part RARs: only extract the first volume; 7z handles the chain.
    return ARCHIVE_EXT.has(e) && !/\.r\d{2}$/i.test(f.relPath) && !/part(?!0*1\b)\d+\.rar$/i.test(f.relPath);
  });
  if (!first) return [];
  const outDir = join(DOWNLOADS_PATH, ".quarry-extract", hash);
  mkdirSync(outDir, { recursive: true });
  const proc = Bun.spawn(["7z", "x", "-y", `-o${outDir}`, first.hostPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`extraction failed: ${err.slice(0, 300)}`);
  }
  const out: HostFile[] = [];
  const entries = await readdir(outDir, { recursive: true });
  let idx = 1000;
  for (const rel of entries) {
    const p = join(outDir, String(rel));
    const st = statSync(p);
    if (st.isFile() && MEDIA_EXT.has(extname(p).toLowerCase()) && st.size > MIN_MEDIA_BYTES) {
      out.push({ index: idx++, relPath: String(rel), hostPath: p, size: st.size });
    }
  }
  return out;
}

const mapSchema = z.object({
  mappings: z.array(
    z.object({
      fileIndex: z.number().int(),
      itemId: z.number().int().nullable(),
    }),
  ),
});

async function mapFilesToItems(
  req: RequestRow,
  items: ItemRow[],
  files: HostFile[],
): Promise<Map<number, number>> {
  // Trivial case needs no model: one file, one item.
  if (files.length === 1 && items.length === 1 && files[0] && items[0]) {
    return new Map([[items[0].id, files[0].index]]);
  }
  const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
  const prompt = [
    `Map downloaded files to media items for: ${req.title}${req.year ? ` (${req.year})` : ""} [${req.media_type}]`,
    ``,
    `Files:`,
    ...files.map((f) => `  [${f.index}] ${f.relPath} (${gb(f.size)}GB)`),
    ``,
    `Items needed:`,
    ...items.map((i) =>
      i.media_type === "movie"
        ? `  id=${i.id} the movie itself`
        : `  id=${i.id} S${String(i.season).padStart(2, "0")}E${String(i.episode).padStart(2, "0")}${i.title ? ` "${i.title}"` : ""}`,
    ),
    ``,
    `Return one mapping per file. itemId null for junk, samples, extras, featurettes,`,
    `or episodes that are NOT in the needed list (do not import unrequested episodes).`,
    `Each itemId may appear at most once — pick the best file if several match.`,
  ].join("\n");

  const { model, modelId } = modelFor("map");
  const started = performance.now();
  const { object, providerMetadata } = await generateObject({ model, schema: mapSchema, prompt });
  logDecision({
    task: "map",
    model: modelId,
    input: { prompt },
    output: object,
    durationMs: performance.now() - started,
    costUsd: openRouterCost([{ providerMetadata }]),
  });

  const byIndex = new Map(files.map((f) => [f.index, f]));
  const itemIds = new Set(items.map((i) => i.id));
  const result = new Map<number, number>(); // itemId -> fileIndex
  for (const m of object.mappings) {
    if (m.itemId !== null && itemIds.has(m.itemId) && byIndex.has(m.fileIndex) && !result.has(m.itemId)) {
      result.set(m.itemId, m.fileIndex);
    }
  }
  return result;
}

async function importTorrent(t: TorrentRow) {
  const d = db();
  const [q] = await qbit.getByHashes([t.hash]);
  if (!q) {
    failTorrent(t.hash, "completed torrent no longer in qBittorrent", false);
    return;
  }
  const qFiles = await qbit.getFiles(t.hash);
  const hostBase = mapToHost(q.save_path);
  const all: HostFile[] = qFiles.map((f) => ({
    index: f.index,
    relPath: f.name,
    hostPath: join(hostBase, f.name),
    size: f.size,
  }));

  let media = all.filter(
    (f) => MEDIA_EXT.has(extname(f.relPath).toLowerCase()) && f.size > MIN_MEDIA_BYTES,
  );
  let extracted = false;
  if (media.length === 0) {
    media = await extractArchives(all, t.hash);
    extracted = media.length > 0;
    if (media.length === 0) {
      failTorrent(t.hash, "no media files found in torrent", true);
      return;
    }
  }

  const items = d
    .prepare(
      `SELECT i.* FROM items i JOIN torrent_items ti ON ti.item_id = i.id
       WHERE ti.torrent_hash = ? AND i.status NOT IN ('done')`,
    )
    .all(t.hash) as ItemRow[];
  if (items.length === 0) {
    d.prepare("UPDATE torrents SET status = 'imported' WHERE hash = ?").run(t.hash);
    return;
  }
  const req = d
    .prepare("SELECT * FROM requests WHERE id = ?")
    .get(items[0]!.request_id) as RequestRow;

  const mapping = await mapFilesToItems(req, items, media);
  const byIndex = new Map(media.map((f) => [f.index, f]));
  const snap = await snapshot();

  let imported = 0;
  for (const item of items) {
    const fileIndex = mapping.get(item.id);
    const file = fileIndex !== undefined ? byIndex.get(fileIndex) : undefined;
    if (!file) continue; // handled below as uncovered

    if (!(await probeOk(file.hostPath))) {
      failTorrent(t.hash, `ffprobe rejected ${file.relPath} (corrupt or fake)`, true);
      return;
    }
    const dest = destinationFor(item, req, extname(file.relPath).toLowerCase(), snap);
    const how = await place(file.hostPath, dest);
    touchItem(item.id, { status: "done", file_path: dest, failure: null });
    imported++;
    logEvent({
      message: `Imported ${how === "existed" ? "(already present)" : `(${how})`}: ${dest.split("/").slice(-2).join("/")}`,
      requestId: req.id,
      itemId: item.id,
      torrentHash: t.hash,
    });
    await Bun.sleep(50); // be gentle with NAS metadata ops
  }

  const maxAttempts = Number(getSetting("max_item_attempts")) || 3;
  for (const item of items) {
    if (mapping.has(item.id) && byIndex.has(mapping.get(item.id)!)) continue;
    const failed = item.attempts >= maxAttempts;
    touchItem(item.id, {
      status: failed ? "failed" : "wanted",
      failure: `torrent "${t.title}" did not contain this item`,
    });
    logEvent({
      level: "warn",
      message: `Not covered by "${t.title}" — ${failed ? "giving up" : "back to wanted"}`,
      requestId: req.id,
      itemId: item.id,
      torrentHash: t.hash,
    });
  }

  if (extracted) {
    await rm(join(config().DOWNLOADS_PATH, ".quarry-extract", t.hash), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
  d.prepare("UPDATE torrents SET status = 'imported' WHERE hash = ?").run(t.hash);
  logEvent({
    message: `Import finished for "${t.title}": ${imported}/${items.length} item(s)`,
    requestId: req.id,
    torrentHash: t.hash,
  });
}

/** Import every completed torrent, then tell Jellyfin to scan. */
export async function importCompleted() {
  const completed = db()
    .prepare("SELECT * FROM torrents WHERE status = 'completed'")
    .all() as TorrentRow[];
  let imported = 0;
  for (const t of completed) {
    // Mark items importing so a crash mid-import is visible, then do the work.
    db()
      .prepare(
        `UPDATE items SET status = 'importing', updated_at = datetime('now')
         WHERE status = 'downloading' AND id IN (SELECT item_id FROM torrent_items WHERE torrent_hash = ?)`,
      )
      .run(t.hash);
    try {
      await importTorrent(t);
      imported++;
    } catch (e) {
      logEvent({
        level: "error",
        message: `Import error for "${t.title}": ${e instanceof Error ? e.message : e}`,
        torrentHash: t.hash,
      });
      // Leave torrent completed; retried next tick. Items return to downloading state.
      db()
        .prepare(
          `UPDATE items SET status = 'downloading' WHERE status = 'importing'
           AND id IN (SELECT item_id FROM torrent_items WHERE torrent_hash = ?)`,
        )
        .run(t.hash);
    }
  }
  if (imported > 0) {
    await refreshLibraries().catch((e) =>
      logEvent({ level: "warn", message: `Jellyfin refresh failed: ${e.message}` }),
    );
    logEvent({ message: "Triggered Jellyfin library scan" });
  }
}

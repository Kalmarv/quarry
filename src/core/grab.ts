import { db, logEvent, type PlanRow } from "../db";
import { resolveRelease } from "../torrent";
import * as qbit from "../clients/qbittorrent";
import type { PlanPayload } from "./select";

/**
 * Execute an approved plan: resolve each release to an infohash BEFORE adding,
 * record the torrent, add to qBittorrent, and link items. Idempotent — a
 * selection whose hash already exists just links.
 */
export async function executePlan(planId: number) {
  const d = db();
  const plan = d.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow | null;
  if (!plan || plan.status !== "approved") throw new Error(`plan ${planId} is not approved`);
  const payload = JSON.parse(plan.payload) as PlanPayload;

  let grabbed = 0;
  for (const sel of payload.selections) {
    const link = sel.magnetUrl ?? sel.downloadUrl;
    if (!link) {
      logEvent({ level: "error", message: `No download link for "${sel.title}"`, requestId: plan.request_id });
      continue;
    }
    try {
      const resolved = await resolveRelease(link);
      const hash = resolved.hash;

      const isBlocked = d.prepare("SELECT 1 FROM blocklist WHERE hash = ?").get(hash);
      if (isBlocked) {
        logEvent({
          level: "warn",
          message: `Skipping "${sel.title}" — hash is blocklisted`,
          requestId: plan.request_id,
          torrentHash: hash,
        });
        continue;
      }

      const existing = d.prepare("SELECT status FROM torrents WHERE hash = ?").get(hash) as
        | { status: string }
        | null;
      if (!existing) {
        d.prepare(
          "INSERT INTO torrents (hash, title, indexer, size, status, last_progress_at) VALUES (?, ?, ?, ?, 'added', datetime('now'))",
        ).run(hash, sel.title, sel.indexer, sel.size);
      }
      // Add (or re-add after a failed earlier attempt) whenever qBittorrent
      // doesn't actually have it — the DB row alone is not proof of an add.
      const live = !existing || existing.status === "added" || existing.status === "downloading";
      if (live && (await qbit.getByHashes([hash])).length === 0) {
        if (resolved.kind === "magnet") await qbit.addTorrent({ magnet: resolved.magnet });
        else await qbit.addTorrent({ bytes: resolved.bytes });
        d.prepare(
          "UPDATE torrents SET status = 'added', failure = NULL, last_progress_at = datetime('now') WHERE hash = ?",
        ).run(hash);
      }

      const linkStmt = d.prepare(
        "INSERT OR IGNORE INTO torrent_items (torrent_hash, item_id) VALUES (?, ?)",
      );
      const itemStmt = d.prepare(
        "UPDATE items SET status = 'downloading', attempts = attempts + 1, failure = NULL, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('done')",
      );
      for (const itemId of sel.itemIds) {
        linkStmt.run(hash, itemId);
        itemStmt.run(itemId);
      }
      grabbed++;
      logEvent({
        message: `Grabbed "${sel.title}" (${sel.itemIds.length} item(s))`,
        requestId: plan.request_id,
        torrentHash: hash,
        data: { indexer: sel.indexer, sizeGb: sel.size / 1024 ** 3 },
      });
    } catch (e) {
      logEvent({
        level: "error",
        message: `Failed to grab "${sel.title}": ${e instanceof Error ? e.message : e}`,
        requestId: plan.request_id,
      });
    }
  }
  logEvent({
    message: `Plan #${planId} executed: ${grabbed}/${payload.selections.length} torrent(s) added`,
    requestId: plan.request_id,
  });
}

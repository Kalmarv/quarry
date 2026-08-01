import { db, getSetting, logEvent, type TorrentRow } from "../db";
import * as qbit from "../clients/qbittorrent";

/** Fail a torrent, optionally blocklist it, and release its unfinished items back to wanted. */
export function failTorrent(hash: string, reason: string, blocklist: boolean) {
  const d = db();
  const t = d.prepare("SELECT * FROM torrents WHERE hash = ?").get(hash) as TorrentRow | null;
  d.prepare("UPDATE torrents SET status = 'failed', failure = ? WHERE hash = ?").run(reason, hash);
  if (blocklist) {
    d.prepare("INSERT OR IGNORE INTO blocklist (hash, title, reason) VALUES (?, ?, ?)").run(
      hash,
      t?.title ?? null,
      reason,
    );
  }
  const maxAttempts = Number(getSetting("max_item_attempts")) || 3;
  const released = d
    .prepare(
      `UPDATE items SET
         status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'wanted' END,
         failure = ?,
         updated_at = datetime('now')
       WHERE status IN ('downloading', 'importing')
       AND id IN (SELECT item_id FROM torrent_items WHERE torrent_hash = ?)
       RETURNING id, status`,
    )
    .all(maxAttempts, reason, hash) as { id: number; status: string }[];
  logEvent({
    level: "warn",
    message: `Torrent failed (${reason}): "${t?.title ?? hash}" — ${released.length} item(s) ${
      released.some((r) => r.status === "failed") ? "affected, some gave up" : "back to wanted"
    }`,
    torrentHash: hash,
  });
}

/** Poll qBittorrent by hash for every live torrent and update state. */
export async function monitorTorrents() {
  const d = db();
  const live = d
    .prepare("SELECT * FROM torrents WHERE status IN ('added', 'downloading')")
    .all() as TorrentRow[];
  if (live.length === 0) return;

  const stallHours = Number(getSetting("stall_hours")) || 12;
  const found = new Map((await qbit.getByHashes(live.map((t) => t.hash))).map((q) => [q.hash, q]));

  for (const t of live) {
    const q = found.get(t.hash);
    if (!q) {
      // Grace period: qBittorrent can take a moment to register a magnet.
      const ageMin = (Date.now() - new Date(t.added_at + "Z").getTime()) / 60000;
      if (ageMin > 10) failTorrent(t.hash, "disappeared from qBittorrent", false);
      continue;
    }

    if (qbit.DEAD_STATES.has(q.state)) {
      failTorrent(t.hash, `qBittorrent state: ${q.state}`, true);
      continue;
    }

    const complete = q.progress >= 1 || qbit.COMPLETE_STATES.has(q.state);
    if (complete) {
      d.prepare(
        "UPDATE torrents SET status = 'completed', progress = 1, content_path = ? WHERE hash = ?",
      ).run(q.content_path, t.hash);
      logEvent({ message: `Download complete: "${q.name}"`, torrentHash: t.hash });
      continue;
    }

    const progressed = q.progress > t.progress + 1e-6;
    d.prepare(
      `UPDATE torrents SET status = 'downloading', progress = ?, content_path = ?,
       last_progress_at = CASE WHEN ? THEN datetime('now') ELSE last_progress_at END
       WHERE hash = ?`,
    ).run(q.progress, q.content_path, progressed ? 1 : 0, t.hash);

    const lastProgress = t.last_progress_at ?? t.added_at;
    const stalledHrs = (Date.now() - new Date(lastProgress + "Z").getTime()) / 3600000;
    if (!progressed && q.num_seeds === 0 && stalledHrs > stallHours) {
      failTorrent(t.hash, `stalled: no progress for ${Math.round(stalledHrs)}h with 0 seeders`, true);
    }
  }
}

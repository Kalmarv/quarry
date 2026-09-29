import { Hono } from "hono";
import { db, getSetting, setSetting, DEFAULT_SETTINGS, type PlanRow } from "../db";
import { executePlan } from "../core/grab";
import { tickSoon } from "../core/reconcile";

export const api = new Hono();

api.get("/health", (c) => c.json({ ok: true }));

/**
 * Where a request stands, for the UI's sections. Ordered by who has to act:
 * review/failed need the user, downloading/searching are quarry's work in
 * flight, upcoming waits on the calendar.
 */
export type Phase = "review" | "failed" | "downloading" | "searching" | "upcoming" | "done";

type RequestSummary = {
  status: string;
  pending_plan_id: number | null;
  live_torrents: number;
  active_count: number;
  wanted_count: number;
  unaired_count: number;
};

export function phaseOf(r: RequestSummary): Phase {
  if (r.status === "completed" || r.status === "dismissed") return "done";
  if (r.pending_plan_id !== null) return "review";
  if (r.status === "failed") return "failed";
  if (r.live_torrents > 0 || r.active_count > 0) return "downloading";
  if (r.wanted_count > 0) return "searching";
  if (r.unaired_count > 0) return "upcoming";
  return "done";
}

api.get("/requests", (c) => {
  const rows = db()
    .prepare(
      `SELECT r.*,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id) AS item_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'wanted') AS wanted_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status IN ('downloading','importing')) AS active_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'unaired') AS unaired_count,
        (SELECT MIN(air_date) FROM items i WHERE i.request_id = r.id AND i.status = 'unaired') AS next_air_date,
        (SELECT MAX(id) FROM plans p WHERE p.request_id = r.id AND p.status = 'pending') AS pending_plan_id,
        live.n AS live_torrents,
        live.progress AS download_progress
       FROM requests r
       LEFT JOIN (
         -- Size-weighted, so a finished 200MB episode doesn't read as half of a 60GB pack.
         SELECT rt.rid, COUNT(*) AS n,
           SUM(t.progress * COALESCE(t.size, 1)) / SUM(COALESCE(t.size, 1)) AS progress
         FROM (
           SELECT DISTINCT i.request_id AS rid, ti.torrent_hash AS hash
           FROM torrent_items ti JOIN items i ON i.id = ti.item_id
         ) rt
         JOIN torrents t ON t.hash = rt.hash
         WHERE t.status IN ('added', 'downloading', 'completed')
         GROUP BY rt.rid
       ) live ON live.rid = r.id
       ORDER BY r.id DESC`,
    )
    .all() as (Omit<RequestSummary, "live_torrents"> & { live_torrents: number | null })[];
  return c.json(
    rows.map((row) => {
      const r = { ...row, live_torrents: row.live_torrents ?? 0 };
      return { ...r, phase: phaseOf(r) };
    }),
  );
});

api.get("/requests/:id", (c) => {
  const id = Number(c.req.param("id"));
  const d = db();
  const request = d.prepare("SELECT * FROM requests WHERE id = ?").get(id);
  if (!request) return c.json({ error: "not found" }, 404);
  const items = d
    .prepare("SELECT * FROM items WHERE request_id = ? ORDER BY season, episode")
    .all(id);
  const plans = d
    .prepare("SELECT * FROM plans WHERE request_id = ? ORDER BY id DESC")
    .all(id);
  const torrents = d
    .prepare(
      `SELECT DISTINCT t.* FROM torrents t JOIN torrent_items ti ON ti.torrent_hash = t.hash
       JOIN items i ON i.id = ti.item_id WHERE i.request_id = ? ORDER BY t.added_at DESC`,
    )
    .all(id);
  const events = d
    .prepare("SELECT * FROM events WHERE request_id = ? ORDER BY id DESC LIMIT 100")
    .all(id);
  return c.json({ request, items, plans, torrents, events });
});

api.delete("/requests/:id", (c) => {
  const id = Number(c.req.param("id"));
  const d = db();
  d.prepare("UPDATE requests SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?").run(id);
  d.prepare("UPDATE plans SET status = 'superseded' WHERE request_id = ? AND status = 'pending'").run(id);
  return c.json({ ok: true });
});

/** Skip the selection backoff: search on the next tick. */
api.post("/requests/:id/search", (c) => {
  const id = Number(c.req.param("id"));
  const res = db()
    .prepare("UPDATE requests SET select_misses = 0, next_select_at = NULL WHERE id = ? AND status = 'active'")
    .run(id);
  if (res.changes === 0) return c.json({ error: "no active request" }, 404);
  tickSoon();
  return c.json({ ok: true });
});

/** Give items that exhausted their attempts a fresh set; reopens a failed request. */
api.post("/requests/:id/retry", (c) => {
  const id = Number(c.req.param("id"));
  const d = db();
  // Entering 'wanted' fires items_wanted_update, which clears the backoff.
  const items = d
    .prepare(
      "UPDATE items SET status = 'wanted', attempts = 0, failure = NULL, updated_at = datetime('now') WHERE request_id = ? AND status = 'failed'",
    )
    .run(id);
  if (items.changes === 0) return c.json({ error: "no failed items" }, 404);
  d.prepare(
    "UPDATE requests SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status IN ('active', 'failed')",
  ).run(id);
  tickSoon();
  return c.json({ ok: true });
});

api.get("/plans/pending", (c) => {
  const rows = db()
    .prepare(
      `SELECT p.*, r.title, r.year, r.media_type FROM plans p
       JOIN requests r ON r.id = p.request_id
       WHERE p.status = 'pending' ORDER BY p.id DESC`,
    )
    .all();
  return c.json(rows);
});

api.post("/plans/:id/approve", async (c) => {
  const id = Number(c.req.param("id"));
  const d = db();
  const plan = d.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | null;
  if (!plan) return c.json({ error: "not found" }, 404);
  if (plan.status !== "pending") return c.json({ error: `plan is ${plan.status}` }, 409);
  d.prepare("UPDATE plans SET status = 'approved' WHERE id = ?").run(id);
  await executePlan(id);
  tickSoon();
  return c.json({ ok: true });
});

api.post("/plans/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { feedback?: string };
  const d = db();
  const plan = d.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | null;
  if (!plan) return c.json({ error: "not found" }, 404);
  if (plan.status !== "pending") return c.json({ error: `plan is ${plan.status}` }, 409);
  d.prepare("UPDATE plans SET status = 'rejected', feedback = ? WHERE id = ?").run(
    body.feedback ?? null,
    id,
  );
  // Feedback rides on the request into the next selection run; clearing the
  // backoff makes that run happen on the next tick.
  d.prepare(
    `UPDATE requests SET feedback = ?, select_misses = 0, next_select_at = NULL, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(body.feedback ?? null, plan.request_id);
  tickSoon();
  return c.json({ ok: true });
});

api.get("/events", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  return c.json(
    db()
      .prepare(
        `SELECT e.*, r.title AS request_title FROM events e
         LEFT JOIN requests r ON r.id = e.request_id ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit),
  );
});

api.get("/decisions", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  return c.json(
    db()
      .prepare(
        "SELECT id, ts, task, model, error, duration_ms, cost_usd FROM decisions ORDER BY id DESC LIMIT ?",
      )
      .all(limit),
  );
});

api.get("/decisions/:id", (c) => {
  const row = db().prepare("SELECT * FROM decisions WHERE id = ?").get(Number(c.req.param("id")));
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});

api.get("/settings", (c) => {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(key);
  return c.json(out);
});

api.put("/settings", async (c) => {
  const body = (await c.req.json()) as Record<string, string>;
  for (const [k, v] of Object.entries(body)) {
    if (k in DEFAULT_SETTINGS) setSetting(k, String(v));
  }
  return c.json({ ok: true });
});

api.post("/tick", (c) => {
  tickSoon(0);
  return c.json({ ok: true });
});

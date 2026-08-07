import { Hono } from "hono";
import { db, getSetting, setSetting, DEFAULT_SETTINGS, type PlanRow } from "../db";
import { executePlan } from "../core/grab";
import { tickSoon } from "../core/reconcile";

export const api = new Hono();

api.get("/health", (c) => c.json({ ok: true }));

api.get("/requests", (c) => {
  const rows = db()
    .prepare(
      `SELECT r.*,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id) AS item_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status IN ('downloading','importing')) AS active_count,
        (SELECT COUNT(*) FROM items i WHERE i.request_id = r.id AND i.status = 'unaired') AS unaired_count,
        (SELECT MIN(air_date) FROM items i WHERE i.request_id = r.id AND i.status = 'unaired') AS next_air_date
       FROM requests r ORDER BY r.id DESC`,
    )
    .all();
  return c.json(rows);
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
    "UPDATE requests SET feedback = ?, last_select_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(body.feedback ?? null, plan.request_id);
  tickSoon();
  return c.json({ ok: true });
});

api.get("/events", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  return c.json(db().prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit));
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

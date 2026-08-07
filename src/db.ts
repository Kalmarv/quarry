import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export type ItemStatus =
  | "unaired"
  | "wanted"
  | "selecting"
  | "grabbing"
  | "downloading"
  | "importing"
  | "done"
  | "failed";

export type RequestRow = {
  id: number;
  source: "seerr" | "letterboxd" | "manual";
  source_key: string; // seerr request id / letterboxd film slug / tmdb id
  media_type: "movie" | "tv";
  tmdb_id: number;
  title: string;
  year: number | null;
  requested_seasons: string; // JSON number[]
  status: "active" | "completed" | "failed" | "dismissed";
  feedback: string | null;
  created_at: string;
  updated_at: string;
};

export type ItemRow = {
  id: number;
  request_id: number;
  media_type: "movie" | "tv";
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  title: string | null;
  air_date: string | null;
  status: ItemStatus;
  attempts: number;
  file_path: string | null;
  failure: string | null;
  updated_at: string;
};

export type TorrentRow = {
  hash: string;
  title: string;
  indexer: string | null;
  size: number | null;
  status: "added" | "downloading" | "completed" | "imported" | "failed";
  progress: number;
  content_path: string | null;
  last_progress_at: string | null;
  failure: string | null;
  added_at: string;
};

export type PlanRow = {
  id: number;
  request_id: number;
  payload: string; // JSON PlanPayload
  status: "pending" | "approved" | "rejected" | "superseded";
  feedback: string | null;
  created_at: string;
};

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  mkdirSync("data", { recursive: true });
  _db = new Database("data/quarry.db", { create: true });
  _db.exec("PRAGMA journal_mode = WAL;");
  migrate(_db);
  return _db;
}

export function testDb(): Database {
  const d = new Database(":memory:");
  migrate(d);
  _db = d;
  return d;
}

export function migrate(d: Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'seerr',
    source_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    requested_seasons TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    feedback TEXT,
    last_select_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, source_key)
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    media_type TEXT NOT NULL,
    tmdb_id INTEGER NOT NULL,
    season INTEGER,
    episode INTEGER,
    title TEXT,
    air_date TEXT,
    status TEXT NOT NULL DEFAULT 'wanted',
    attempts INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    failure TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tmdb_id, season, episode)
  );
  CREATE TABLE IF NOT EXISTS torrents (
    hash TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    indexer TEXT,
    size INTEGER,
    status TEXT NOT NULL DEFAULT 'added',
    progress REAL NOT NULL DEFAULT 0,
    content_path TEXT,
    last_progress_at TEXT,
    failure TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS torrent_items (
    torrent_hash TEXT NOT NULL REFERENCES torrents(hash),
    item_id INTEGER NOT NULL REFERENCES items(id),
    PRIMARY KEY (torrent_hash, item_id)
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    feedback TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL DEFAULT 'info',
    request_id INTEGER,
    item_id INTEGER,
    torrent_hash TEXT,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    duration_ms INTEGER,
    cost_usd REAL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocklist (
    hash TEXT PRIMARY KEY,
    title TEXT,
    reason TEXT,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Letterboxd slug -> TMDB id cache, so trending films we skip (already in
  -- library, wrong type) don't cost a film-page fetch every poll.
  CREATE TABLE IF NOT EXISTS lb_films (
    slug TEXT PRIMARY KEY,
    tmdb_id INTEGER NOT NULL,
    tmdb_type TEXT NOT NULL,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(id DESC);
  -- Movies use -1 sentinels: NULL != NULL in SQLite unique indexes, so NULL
  -- season/episode would let movie items duplicate. Normalize legacy rows.
  UPDATE items SET season = -1 WHERE season IS NULL;
  UPDATE items SET episode = -1 WHERE episode IS NULL;
  `);

  // Pre-letterboxd databases keyed requests on seerr_request_id alone. SQLite
  // can't alter constraints, so rebuild: every existing row becomes
  // ('seerr', <seerr id>). Safe without FK juggling — foreign_keys is off and
  // items/plans reference requests by name, which the renamed table takes over.
  const legacy = (d.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).some(
    (c) => c.name === "seerr_request_id",
  );
  if (legacy) {
    d.exec(`
    CREATE TABLE requests_new (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'seerr',
      source_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      requested_seasons TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      feedback TEXT,
      last_select_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, source_key)
    );
    INSERT INTO requests_new (id, source, source_key, media_type, tmdb_id, title, year,
      requested_seasons, status, feedback, last_select_at, created_at, updated_at)
    SELECT id, 'seerr', CAST(seerr_request_id AS TEXT), media_type, tmdb_id, title, year,
      requested_seasons, status, feedback, last_select_at, created_at, updated_at
    FROM requests;
    DROP TABLE requests;
    ALTER TABLE requests_new RENAME TO requests;
    `);
  }

  seedSettings(d);
}

export const DEFAULT_SETTINGS: Record<string, string> = {
  quality_policy: [
    "Prefer 4K HDR when a well-seeded release exists; otherwise the best 1080p.",
    "For films where presentation matters (prestige dramas, blockbusters, visually striking movies): favor high-bitrate encodes, around 4K 20-30mbps HEVC or a strong 1080p Bluray encode. Remuxes only when nothing sane exists in between.",
    "For casual watches, comedies, and kids movies: an efficient 4K HDR encode is ideal; a good 1080p is fine.",
    "TV: 4K efficient encode when available; 1080p is the right call for comedies, panel/reality shows, and very long-running series.",
    "Never pick an upscale, a cam/TS, or a garbage encode just to hit a resolution target. Well-seeded and real beats nominal quality. Prefer smaller files when quality is comparable.",
  ].join(" "),
  model_select: "x-ai/grok-4.5",
  effort_select: "high",
  model_map: "x-ai/grok-4.5",
  effort_map: "medium",
  approval_mode: "auto",
  reselect_backoff_hours: "24",
  stall_hours: "12",
  max_item_attempts: "3",
  letterboxd_enabled: "true",
  letterboxd_min_rating: "3.9",
  letterboxd_pages: "1",
};

function seedSettings(d: Database) {
  const ins = d.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

export function getSetting(key: string): string {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? DEFAULT_SETTINGS[key] ?? "";
}

export function setSetting(key: string, value: string) {
  db().prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function logEvent(opts: {
  message: string;
  level?: "info" | "warn" | "error";
  requestId?: number | null;
  itemId?: number | null;
  torrentHash?: string | null;
  data?: unknown;
}) {
  db().prepare(
    "INSERT INTO events (level, request_id, item_id, torrent_hash, message, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    opts.level ?? "info",
    opts.requestId ?? null,
    opts.itemId ?? null,
    opts.torrentHash ?? null,
    opts.message,
    opts.data === undefined ? null : JSON.stringify(opts.data),
  );
  console.log(`[${opts.level ?? "info"}] ${opts.message}`);
}

export function touchItem(id: number, fields: Partial<ItemRow>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db().prepare(`UPDATE items SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
    ...keys.map((k) => (fields as Record<string, unknown>)[k] as never),
    id,
  );
}

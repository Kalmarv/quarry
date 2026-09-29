import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, nextSelectAt, testDb } from "./db";
import { upsertItem } from "./core/poller";

function addRequest(d: Database, mediaType: "movie" | "tv" = "tv"): number {
  const res = d
    .prepare(
      "INSERT INTO requests (source, source_key, media_type, tmdb_id, title) VALUES ('manual', ?, ?, 1, 'T')",
    )
    .run(String(Math.random()), mediaType);
  return Number(res.lastInsertRowid);
}

const backoff = (d: Database, id: number) =>
  d.prepare("SELECT select_misses, next_select_at FROM requests WHERE id = ?").get(id) as {
    select_misses: number;
    next_select_at: string | null;
  };

describe("nextSelectAt", () => {
  test("doubles from the base per consecutive miss", () => {
    expect(nextSelectAt("2026-09-01 00:00:00", 1, 24, 30)).toBe("2026-09-02 00:00:00");
    expect(nextSelectAt("2026-09-01 00:00:00", 2, 24, 30)).toBe("2026-09-03 00:00:00");
    expect(nextSelectAt("2026-09-01 00:00:00", 4, 24, 30)).toBe("2026-09-09 00:00:00");
  });

  test("caps at maxDays", () => {
    expect(nextSelectAt("2026-09-01 00:00:00", 20, 24, 30)).toBe("2026-10-01 00:00:00");
  });
});

describe("backoff reset trigger", () => {
  let d: Database;
  beforeEach(() => {
    d = testDb();
  });

  test("an item entering wanted clears its request's backoff", () => {
    const rid = addRequest(d);
    d.prepare(
      "INSERT INTO items (request_id, media_type, tmdb_id, season, episode, status) VALUES (?, 'tv', 1, 1, 1, 'unaired')",
    ).run(rid);
    d.prepare("UPDATE requests SET select_misses = 5, next_select_at = '2099-01-01 00:00:00' WHERE id = ?").run(rid);

    d.prepare("UPDATE items SET status = 'wanted' WHERE request_id = ?").run(rid);
    expect(backoff(d, rid)).toEqual({ select_misses: 0, next_select_at: null });
  });

  test("updates that leave an item wanted do not reset", () => {
    const rid = addRequest(d);
    d.prepare(
      "INSERT INTO items (request_id, media_type, tmdb_id, season, episode, status) VALUES (?, 'tv', 1, 1, 1, 'wanted')",
    ).run(rid);
    d.prepare("UPDATE requests SET select_misses = 3, next_select_at = '2099-01-01 00:00:00' WHERE id = ?").run(rid);

    d.prepare("UPDATE items SET status = 'wanted', title = 'x' WHERE request_id = ?").run(rid);
    expect(backoff(d, rid).select_misses).toBe(3);
  });

  test("a newly inserted wanted item resets", () => {
    const rid = addRequest(d);
    d.prepare("UPDATE requests SET select_misses = 3, next_select_at = '2099-01-01 00:00:00' WHERE id = ?").run(rid);
    d.prepare(
      "INSERT INTO items (request_id, media_type, tmdb_id, season, episode, status) VALUES (?, 'tv', 1, 1, 2, 'wanted')",
    ).run(rid);
    expect(backoff(d, rid).next_select_at).toBeNull();
  });
});

describe("backfill from decisions log", () => {
  test("counts trailing empty runs since the last successful plan, ignoring errors", () => {
    const d = new Database(":memory:");
    migrate(d);
    // Simulate a pre-backoff database: drop the columns' effect by re-adding via a legacy table.
    d.exec(`
      DROP TRIGGER items_wanted_insert; DROP TRIGGER items_wanted_update;
      CREATE TABLE r2 AS SELECT id, source, source_key, media_type, tmdb_id, title, year,
        requested_seasons, status, feedback, last_select_at, created_at, updated_at FROM requests;
      DROP TABLE requests; ALTER TABLE r2 RENAME TO requests;
      INSERT INTO requests (id, source, source_key, media_type, tmdb_id, title, requested_seasons, status, last_select_at, created_at, updated_at)
      VALUES (1, 'seerr', '1', 'movie', 1, 'Top Gear Special', '[]', 'active', '2026-09-28 00:00:00', datetime('now'), datetime('now'));
    `);
    const log = d.prepare("INSERT INTO decisions (task, model, input, output, error) VALUES ('select', 'm', ?, ?, ?)");
    const input = JSON.stringify({ requestId: 1 });
    log.run(input, JSON.stringify({ plan: { selections: [{}] } }), null); // old success
    log.run(input, JSON.stringify({ plan: null }), null);
    log.run(input, JSON.stringify({ plan: { selections: [] } }), null);
    log.run(input, null, "Missing Authentication header"); // not evidence
    log.run(input, JSON.stringify({ plan: { selections: [] } }), null);

    migrate(d);
    expect(backoff(d, 1)).toEqual({ select_misses: 3, next_select_at: "2026-10-02 00:00:00" });
  });
});

describe("upsertItem air dates", () => {
  let rid: number;
  let d: Database;
  beforeEach(() => {
    d = testDb();
    rid = addRequest(d);
  });
  const item = (ep: number) =>
    d.prepare("SELECT status, air_date, title FROM items WHERE episode = ?").get(ep) as {
      status: string;
      air_date: string | null;
      title: string | null;
    };
  const ep = (episode: number, airDate: string | null, title = "E") => ({
    requestId: rid,
    mediaType: "tv" as const,
    tmdbId: 1,
    season: 2,
    episode,
    title,
    airDate,
    inLibrary: false,
  });

  test("undated episodes are unaired; undated movies are wanted", () => {
    upsertItem(ep(1, null));
    expect(item(1).status).toBe("unaired");
    upsertItem({ ...ep(0, null), mediaType: "movie", season: null, episode: null });
    expect((d.prepare("SELECT status FROM items WHERE episode = -1").get() as { status: string }).status).toBe(
      "wanted",
    );
  });

  test("refresh corrects legacy undated-wanted episodes and fills in dates", () => {
    d.prepare(
      "INSERT INTO items (request_id, media_type, tmdb_id, season, episode, status) VALUES (?, 'tv', 1, 2, 1, 'wanted')",
    ).run(rid);
    expect(upsertItem(ep(1, null))).toBe(false);
    expect(item(1).status).toBe("unaired");

    upsertItem(ep(1, "2000-01-01", "Pilot"));
    expect(item(1)).toEqual({ status: "wanted", air_date: "2000-01-01", title: "Pilot" });

    upsertItem(ep(1, "2099-01-01", "Pilot")); // date slipped
    expect(item(1).status).toBe("unaired");
  });

  test("acquired items are never touched, and library presence never demotes wanted", () => {
    d.prepare(
      "INSERT INTO items (request_id, media_type, tmdb_id, season, episode, status, air_date) VALUES (?, 'tv', 1, 2, 3, 'downloading', '2000-01-01')",
    ).run(rid);
    upsertItem(ep(3, "2099-01-01"));
    expect(item(3)).toMatchObject({ status: "downloading", air_date: "2000-01-01" });

    upsertItem(ep(4, "2000-01-01"));
    upsertItem({ ...ep(4, "2000-01-01"), inLibrary: true });
    expect(item(4).status).toBe("wanted");
  });
});

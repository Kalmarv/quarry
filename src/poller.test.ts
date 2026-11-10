import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { testDb } from "./db";

let availableDate: string | null = null;
mock.module("./clients/seerr", () => ({
  getMovie: async () => ({ title: "The Odyssey", releaseDate: "2026-07-15", availableDate }),
}));
const { refreshAiring } = await import("./core/poller");

describe("refreshAiring movie availability", () => {
  let d: Database;
  let rid: number;
  beforeEach(() => {
    d = testDb();
    rid = Number(
      d
        .prepare(
          `INSERT INTO requests (source, source_key, media_type, tmdb_id, title, updated_at)
           VALUES ('seerr', '1', 'movie', 1368337, 'The Odyssey', datetime('now', '-2 days'))`,
        )
        .run().lastInsertRowid,
    );
  });
  const insertItem = (status: string, airDate: string) =>
    d
      .prepare(
        `INSERT INTO items (request_id, media_type, tmdb_id, season, episode, title, air_date, status)
         VALUES (?, 'movie', 1368337, -1, -1, 'The Odyssey', ?, ?)`,
      )
      .run(rid, airDate, status);
  const item = () =>
    d.prepare("SELECT status, air_date FROM items WHERE request_id = ?").get(rid) as {
      status: string;
      air_date: string;
    };

  test("a later digital date replaces a passed theatrical+90d fallback before the flip", async () => {
    insertItem("unaired", "2000-01-01"); // fallback, already passed
    availableDate = "2099-11-17"; // TMDB has since added the real digital date
    await refreshAiring();
    expect(item()).toEqual({ status: "unaired", air_date: "2099-11-17" });
  });

  test("a future date moving later is tracked while the item stays unaired", async () => {
    insertItem("unaired", "2099-01-01");
    availableDate = "2099-06-01";
    await refreshAiring();
    expect(item()).toEqual({ status: "unaired", air_date: "2099-06-01" });
  });

  test("a digital date moving earlier into the past makes the item wanted", async () => {
    insertItem("unaired", "2099-01-01");
    availableDate = "2000-01-01";
    await refreshAiring();
    expect(item()).toEqual({ status: "wanted", air_date: "2000-01-01" });
  });
});

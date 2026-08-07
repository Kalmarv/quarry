import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { parsePopular } from "./clients/letterboxd";
import { migrate } from "./db";

// Trimmed from a real /csi/films/films-browser-list/popular/this/month/ response (2026-08).
const FIXTURE = `
<ul class="grid">
<li class="posteritem" data-average-rating="4.39">
  <div class="react-component" data-component-class="LazyPoster" data-item-name="The Odyssey (2026)" data-item-slug="the-odyssey-2026" data-item-link="/film/the-odyssey-2026/" data-details-endpoint="/film/the-odyssey-2026/json/"> <div class="poster film-poster"></div> </div>
</li>
<li class="posteritem" data-average-rating="3.42">
  <div class="react-component" data-component-class="LazyPoster" data-item-name="Weapons (2025)" data-item-slug="weapons-2025" data-item-link="/film/weapons-2025/"> </div>
</li>
<li class="posteritem">
  <div class="react-component" data-component-class="LazyPoster" data-item-name="Backrooms &#039;86 &amp; After (2026)" data-item-slug="backrooms-2026" data-item-link="/film/backrooms-2026/"> </div>
</li>
</ul>`;

describe("parsePopular", () => {
  test("extracts slug, name, and rating per grid item", () => {
    const films = parsePopular(FIXTURE);
    expect(films).toEqual([
      { slug: "the-odyssey-2026", name: "The Odyssey (2026)", rating: 4.39 },
      { slug: "weapons-2025", name: "Weapons (2025)", rating: 3.42 },
      { slug: "backrooms-2026", name: "Backrooms '86 & After (2026)", rating: null },
    ]);
  });

  test("returns empty on unrecognized markup rather than throwing", () => {
    expect(parsePopular("<html><body>nothing here</body></html>")).toEqual([]);
  });
});

describe("requests source migration", () => {
  test("rebuilds legacy seerr_request_id schema into (source, source_key)", () => {
    const d = new Database(":memory:");
    d.exec(`
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY,
        seerr_request_id INTEGER NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        tmdb_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        requested_seasons TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        feedback TEXT,
        last_select_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO requests (id, seerr_request_id, media_type, tmdb_id, title, year)
      VALUES (7, 142, 'movie', 550, 'Fight Club', 1999);
    `);
    migrate(d);

    const row = d.prepare("SELECT * FROM requests WHERE id = 7").get() as Record<string, unknown>;
    expect(row.source).toBe("seerr");
    expect(row.source_key).toBe("142");
    expect(row.title).toBe("Fight Club");
    expect(row.seerr_request_id).toBeUndefined();

    // New uniqueness: same key under a different source is a distinct request.
    d.prepare(
      "INSERT INTO requests (source, source_key, media_type, tmdb_id, title) VALUES ('letterboxd', 'fight-club', 'movie', 550, 'Fight Club')",
    ).run();
    expect(() =>
      d
        .prepare(
          "INSERT INTO requests (source, source_key, media_type, tmdb_id, title) VALUES ('letterboxd', 'fight-club', 'movie', 550, 'Fight Club')",
        )
        .run(),
    ).toThrow();
  });

  test("fresh databases get the new schema and are not rebuilt", () => {
    const d = new Database(":memory:");
    migrate(d);
    migrate(d); // idempotent
    const cols = (d.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("source");
    expect(cols).not.toContain("seerr_request_id");
  });
});

import { describe, expect, test } from "bun:test";
import { buildSelectPrompt, describeMovie, describeTv, isCamRip } from "./core/select";
import type { ItemRow, RequestRow } from "./db";

describe("isCamRip", () => {
  test("catches cam-family releases", () => {
    for (const t of [
      "Toy.Story.5.2026.1080p.HDCAM.x264",
      "Movie.2026.HD-TS.XviD",
      "Movie 2026 720p TELESYNC",
      "Movie.2026.HDTC.720p",
      "Film.2026.DVDScr.x264",
      "Film.2026.1080p.R5.WEB",
      "Movie.2026.CAM.NEW.SOURCE",
      "Movie.2026.TS.x264-GROUP",
    ])
      expect(isCamRip(t), t).toBe(true);
  });

  test("passes legitimate releases", () => {
    for (const t of [
      "Movie.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP",
      "Show.S09.1080p.10bit.WEBRip.6CH.x265.HEVC-PSA",
      "Film.2009.Hybrid.1080p.BluRay.DTS.x264-DON",
      "Movie.2018.2160p.4K.BluRay.x265.10Bit.HDR.HEVC",
      "Concert.2024.HDTV.1080i.TS-Stream.Remux", // 'TS-Stream' does hit; edge accepted
    ].slice(0, 4))
      expect(isCamRip(t), t).toBe(false);
  });
});

const odyssey = {
  title: "The Odyssey",
  originalTitle: null,
  releaseDate: "2026-07-15",
  runtime: 173,
  directors: ["Christopher Nolan"],
  cast: ["Matt Damon", "Tom Holland", "Anne Hathaway"],
  digitalDate: "2026-11-17",
  physicalDate: "2026-11-17",
  posterPath: null,
  backdropPath: null,
  overview: null,
  availableDate: "2026-11-17",
};

describe("title facts", () => {
  test("movie facts carry identity and flag home releases that can't exist yet", () => {
    expect(describeMovie(odyssey, "2026-10-13")).toEqual([
      "Directed by: Christopher Nolan",
      "Starring: Matt Damon, Tom Holland, Anne Hathaway",
      "Runtime: 173 min",
      "Theatrical release: 2026-07-15",
      "Digital (WEB) release: 2026-11-17 (not yet — no genuine release of this kind exists)",
      "Physical (Blu-ray) release: 2026-11-17 (not yet — no genuine release of this kind exists)",
    ]);
    expect(describeMovie(odyssey, "2026-12-01")).toContain("Digital (WEB) release: 2026-11-17");
  });

  test("unknown dates and missing credits are stated, not invented", () => {
    const lines = describeMovie(
      { ...odyssey, directors: [], cast: [], runtime: null, digitalDate: null, physicalDate: null },
      "2026-10-13",
    );
    expect(lines).toEqual([
      "Theatrical release: 2026-07-15",
      "Digital (WEB) release: unknown",
      "Physical (Blu-ray) release: unknown",
    ]);
  });

  test("tv facts", () => {
    expect(
      describeTv({
        name: "Shōgun",
        originalName: "SHOGUN",
        firstAirDate: "2024-02-27",
        createdBy: ["Rachel Kondo", "Justin Marks"],
        networks: ["FX"],
        posterPath: null,
        backdropPath: null,
        overview: null,
        seasons: [],
      }),
    ).toEqual([
      "Original title: SHOGUN",
      "Created by: Rachel Kondo, Justin Marks",
      "Network: FX",
      "First aired: 2024-02-27",
    ]);
  });
});

describe("buildSelectPrompt", () => {
  test("puts today, the title facts and the identity check in front of the agent", () => {
    const prompt = buildSelectPrompt({
      req: { title: "The Odyssey", year: 2026, media_type: "movie", tmdb_id: 1368337, feedback: null } as RequestRow,
      wanted: [{ id: 86, media_type: "movie", air_date: "2026-11-17" } as ItemRow],
      facts: describeMovie(odyssey, "2026-10-13"),
      qualityPolicy: "Prefer 4K.",
      blocked: [],
      now: "2026-10-13",
    });
    expect(prompt).toContain("Today is 2026-10-13.");
    expect(prompt).toContain("About this title:\n  Directed by: Christopher Nolan");
    expect(prompt).toContain("  #86 movie aired 2026-11-17");
    expect(prompt).toContain("Verify identity before quality.");
    expect(prompt).not.toContain("never select these");
  });
});

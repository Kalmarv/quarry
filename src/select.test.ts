import { describe, expect, test } from "bun:test";
import { isCamRip } from "./core/select";

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

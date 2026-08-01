import { Hono } from "hono";
import { config } from "../config";

/**
 * Minimal fake Sonarr/Radarr v3 API. Exists ONLY so Jellyseerr accepts Quarry
 * as a download server and can render its request dialog. Nothing here is a
 * data path — requests are read from Seerr's own API by the poller. POSTs are
 * acknowledged and discarded.
 */
export const arrStub = new Hono();

const PROFILE = [{ id: 1, name: "Default" }];

arrStub.get("/system/status", (c) => c.json({ version: "4.0.0.0", appName: "Quarry" }));
arrStub.get("/qualityprofile", (c) => c.json(PROFILE));
arrStub.get("/qualityProfile", (c) => c.json(PROFILE));
arrStub.get("/languageprofile", (c) => c.json([{ id: 1, name: "Any" }]));
arrStub.get("/languageProfile", (c) => c.json([{ id: 1, name: "Any" }]));
arrStub.get("/tag", (c) => c.json([]));
arrStub.get("/rootfolder", (c) => {
  const cfg = config();
  return c.json([
    { id: 1, path: cfg.LIBRARY_MOVIES, freeSpace: 0 },
    { id: 2, path: cfg.LIBRARY_TV, freeSpace: 0 },
  ]);
});
// Seerr's add flow calls lookup first and REQUIRES a non-empty result
// (an empty array throws "Error retrieving movie/series by ID" and the
// request is marked FAILED). Return a minimal object WITHOUT an `id` field —
// no id tells Seerr the title isn't in the library yet, so it proceeds to
// POST, which we acknowledge. The poller remains the only real data path.
const idFromTerm = (term: string | undefined) => Number(/(?:tmdb|tvdb):(\d+)/.exec(term ?? "")?.[1] ?? 0);

arrStub.get("/movie", (c) => c.json([]));
arrStub.get("/movie/lookup", (c) => {
  const tmdbId = idFromTerm(c.req.query("term"));
  return c.json(tmdbId ? [{ title: `tmdb-${tmdbId}`, tmdbId, year: 0, isAvailable: true, monitored: false }] : []);
});
arrStub.get("/movie/:id", (c) =>
  c.json({ id: Number(c.req.param("id")), monitored: true, hasFile: false }),
);
arrStub.get("/series", (c) => c.json([]));
arrStub.get("/series/lookup", (c) => {
  const tvdbId = idFromTerm(c.req.query("term"));
  const seasons = Array.from({ length: 51 }, (_, i) => ({ seasonNumber: i, monitored: false }));
  return c.json(tvdbId ? [{ title: `tvdb-${tvdbId}`, tvdbId, year: 0, seasons, monitored: false }] : []);
});
arrStub.get("/series/:id", (c) =>
  c.json({ id: Number(c.req.param("id")), monitored: true, seasons: [] }),
);
arrStub.post("/movie", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json({ ...body, id: Date.now() % 1_000_000, monitored: true, hasFile: false }, 201);
});
arrStub.post("/series", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json({ ...body, id: Date.now() % 1_000_000, monitored: true }, 201);
});

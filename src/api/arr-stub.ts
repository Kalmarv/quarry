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
arrStub.get("/movie", (c) => c.json([]));
arrStub.get("/movie/lookup", (c) => c.json([]));
arrStub.get("/series", (c) => c.json([]));
arrStub.get("/series/lookup", (c) => c.json([]));
arrStub.post("/movie", async (c) => c.json({ id: Date.now(), ...(await c.req.json().catch(() => ({}))) }, 201));
arrStub.post("/series", async (c) => c.json({ id: Date.now(), ...(await c.req.json().catch(() => ({}))) }, 201));

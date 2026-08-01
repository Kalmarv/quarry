import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { config } from "./config";
import { db, logEvent } from "./db";
import { api } from "./api/routes";
import { arrStub } from "./api/arr-stub";
import { tick } from "./core/reconcile";

config(); // fail fast on bad env — no silent dummy-config fallback, ever again
db();

const app = new Hono();
app.route("/api", api);
app.route("/api/v3", arrStub);
// v1 had a Seerr webhook; ack it so an old Seerr notification agent doesn't log failures.
app.post("/webhook/seerr", (c) => c.json({ ok: true }));

if (existsSync("ui/dist")) {
  app.use("/*", serveStatic({ root: "./ui/dist" }));
  app.get("*", serveStatic({ path: "./ui/dist/index.html" }));
}

Bun.serve({ port: 3000, fetch: app.fetch, idleTimeout: 60 });
logEvent({ message: "Quarry v2 started" });

const TICK_MS = 2 * 60 * 1000;
setTimeout(() => void tick(), 5_000);
setInterval(() => void tick(), TICK_MS);

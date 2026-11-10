/**
 * Side-by-side selection-model comparison on a real request.
 *
 *   bun --env-file=.env run scripts/compare-select.ts --request 23 \
 *     --models x-ai/grok-4.5,anthropic/claude-haiku-5.5 --runs 3 [--decision 753]
 *
 * Each model runs the production agent loop on the current prompt (live TMDB
 * facts) and, with --decision, on that decision's recorded prompt too. The
 * live DB is only read: settings and the request are copied into an in-memory
 * DB, so nothing here can create plans or grab torrents. Prowlarr searches
 * are cached per query so repeated runs don't hammer the indexers. The
 * blocklist is left out so earlier mistakes stay on the table.
 */
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { testDb, type ItemRow, type RequestRow } from "../src/db";
import { getSetting } from "../src/db";
import * as prowlarr from "../src/clients/prowlarr";
import * as seerr from "../src/clients/seerr";
import { buildSelectPrompt, describeMovie, describeTv, runSelectionAgent } from "../src/core/select";

const { values } = parseArgs({
  options: {
    request: { type: "string" },
    models: { type: "string" },
    runs: { type: "string", default: "1" },
    decision: { type: "string" },
    out: { type: "string", default: "/tmp/compare-select.json" },
  },
});
if (!values.request || !values.models) {
  console.error("usage: --request <id> --models <a,b,...> [--runs N] [--decision <id>]");
  process.exit(1);
}

const live = new Database("data/quarry.db", { readonly: true });
const mem = testDb();
for (const s of live.query("SELECT key, value FROM settings").all() as { key: string; value: string }[])
  mem.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(s.key, s.value);

const req = live.query("SELECT * FROM requests WHERE id = ?").get(Number(values.request)) as RequestRow | null;
if (!req) throw new Error(`no request ${values.request}`);
// Whatever their state now, every item is what the agent should be looking for.
const wanted = (
  live.query("SELECT * FROM items WHERE request_id = ? ORDER BY season, episode").all(req.id) as ItemRow[]
).map((i): ItemRow => ({ ...i, status: "wanted" }));

const facts =
  req.media_type === "movie"
    ? describeMovie(await seerr.getMovie(req.tmdb_id))
    : describeTv(await seerr.getTv(req.tmdb_id));
const prompts: Record<string, string> = {
  current: buildSelectPrompt({ req, wanted, facts, qualityPolicy: getSetting("quality_policy"), blocked: [] }),
};
if (values.decision) {
  const row = live.query("SELECT input FROM decisions WHERE id = ?").get(Number(values.decision)) as {
    input: string;
  } | null;
  if (!row) throw new Error(`no decision ${values.decision}`);
  prompts[`decision#${values.decision}`] = (JSON.parse(row.input) as { prompt: string }).prompt;
}

const cache = new Map<string, Promise<prowlarr.Release[]>>();
const search: typeof prowlarr.search = (query, mediaType) => {
  const key = `${mediaType}:${query.trim().toLowerCase()}`;
  if (!cache.has(key)) cache.set(key, prowlarr.search(query, mediaType));
  return cache.get(key)!;
};

type Row = {
  model: string;
  prompt: string;
  run: number;
  picked: string[];
  reasoning: string | null;
  queries: string[];
  costUsd: number | null;
  seconds: number;
  error?: string;
};
const rows: Row[] = [];
const models = values.models.split(",").map((m) => m.trim());

for (const [promptName, prompt] of Object.entries(prompts)) {
  for (const model of models) {
    for (let run = 1; run <= Number(values.runs); run++) {
      const r = await runSelectionAgent({ prompt, mediaType: req.media_type, wanted, modelId: model, search });
      const row: Row = {
        model,
        prompt: promptName,
        run,
        picked: r.plan?.selections.map((s) => s.title) ?? [],
        reasoning: r.plan?.reasoning ?? null,
        queries: r.searches.map((s) => s.query),
        costUsd: r.costUsd,
        seconds: Math.round(r.durationMs / 100) / 10,
        error: r.error ?? (r.plan ? undefined : "no plan submitted"),
      };
      rows.push(row);
      const verdict = row.error ? `ERROR ${row.error}` : row.picked.length ? `PICKED ${row.picked.join(" + ")}` : "EMPTY";
      console.log(
        `[${promptName}] ${model} #${run}: ${verdict} | $${row.costUsd?.toFixed(5) ?? "?"} | ${row.seconds}s | ${row.queries.length} searches`,
      );
    }
  }
}

await Bun.write(values.out!, JSON.stringify({ request: req.id, facts, prompts, rows }, null, 2));
console.log(`\nfull results (reasoning, queries): ${values.out}`);

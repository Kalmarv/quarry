import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { z } from "zod";
import { db, getSetting, logEvent, nextSelectAt, type ItemRow, type RequestRow } from "../db";
import { modelFor, logDecision, openRouterCost } from "../llm";
import * as prowlarr from "../clients/prowlarr";
import { executePlan } from "./grab";

export type PlanSelection = {
  guid: string;
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  downloadUrl: string | null;
  magnetUrl: string | null;
  itemIds: number[];
};

export type PlanPayload = {
  selections: PlanSelection[];
  reasoning: string;
};

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

// Hard filter: theater recordings and pre-retail junk never reach the LLM.
// The quality policy also forbids these, but this is the guarantee.
const CAM_RE =
  /\b(cam|camrip|hdcam|hqcam|ts|hdts|telesync|telecine|tc|hdtc|dcp|dcprip|scr|screener|dvdscr|dvdscreener|r5|workprint|wp)\b/i;
export const isCamRip = (title: string) => CAM_RE.test(title.replace(/[._\-[\]()+]/g, " "));

function itemLabel(i: ItemRow): string {
  if (i.media_type === "movie") return `#${i.id} movie`;
  return `#${i.id} S${String(i.season).padStart(2, "0")}E${String(i.episode).padStart(2, "0")}${i.title ? ` "${i.title}"` : ""}`;
}

/**
 * plan: a plan was created. empty: the agent searched and found nothing —
 * evidence the release doesn't exist yet, so it grows the backoff. error: the
 * run itself broke, which says nothing about availability.
 */
export type SelectOutcome = { kind: "plan"; planId: number } | { kind: "empty" } | { kind: "error" };

/** Run the selection agent for one request. */
export async function selectForRequest(req: RequestRow, wanted: ItemRow[]): Promise<SelectOutcome> {
  const d = db();

  const blocked = (
    d.prepare("SELECT title FROM blocklist WHERE title IS NOT NULL ORDER BY ts DESC LIMIT 40").all() as {
      title: string;
    }[]
  ).map((b) => b.title);

  // Candidates accumulate across searches; the LLM only ever sees indices.
  const candidates: prowlarr.Release[] = [];
  const seen = new Set<string>();
  // Verbatim transcript of what each search returned to the LLM, for the
  // decisions log — the searches ARE the selection logic.
  const searches: { query: string; result: string }[] = [];

  const searchTool = tool({
    description:
      "Search the torrent indexers. Returns numbered candidates (cumulative across calls). " +
      "Query grammar: 'Show Name S01' finds season packs, 'Show Name S01E05' single episodes, " +
      "'Movie Name 2021' movies. Try a broad query first, then refine.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => {
      const results = await prowlarr.search(query, req.media_type);
      const fresh = results
        .filter((r) => r.seeders > 0 && !seen.has(r.guid) && !isCamRip(r.title))
        .sort((a, b) => b.seeders - a.seeders)
        .slice(0, 40);
      for (const r of fresh) {
        seen.add(r.guid);
        candidates.push(r);
      }
      let out: string;
      if (fresh.length === 0) {
        out = `No new results for "${query}".`;
      } else {
        const start = candidates.length - fresh.length;
        out = fresh
          .map((r, i) => `[${start + i}] ${r.title} | ${gb(r.size)}GB | ${r.seeders} seeders | ${r.indexer}`)
          .join("\n");
      }
      searches.push({ query, result: out });
      return out;
    },
  });

  let submitted: PlanPayload | null = null;
  const submitTool = tool({
    description:
      "Submit your final download plan. Call exactly once, after searching. " +
      "Empty selections with reasoning means nothing suitable was found.",
    inputSchema: z.object({
      selections: z.array(
        z.object({
          candidateIndex: z.number().int(),
          itemIds: z.array(z.number().int()).min(1),
        }),
      ),
      reasoning: z.string(),
    }),
    execute: async (plan) => {
      const wantedIds = new Set(wanted.map((w) => w.id));
      const selections: PlanSelection[] = [];
      for (const s of plan.selections) {
        const c = candidates[s.candidateIndex];
        if (!c) return `Error: candidateIndex ${s.candidateIndex} does not exist. Fix and resubmit.`;
        const ids = s.itemIds.filter((id) => wantedIds.has(id));
        if (ids.length === 0)
          return `Error: selection [${s.candidateIndex}] covers no wanted item ids. Fix and resubmit.`;
        selections.push({
          guid: c.guid,
          title: c.title,
          indexer: c.indexer,
          size: c.size,
          seeders: c.seeders,
          downloadUrl: c.downloadUrl,
          magnetUrl: c.magnetUrl,
          itemIds: ids,
        });
      }
      submitted = { selections, reasoning: plan.reasoning };
      return "Plan accepted.";
    },
  });

  const label = `${req.title}${req.year ? ` (${req.year})` : ""}`;
  const prompt = [
    `Find torrents for: ${label} [${req.media_type}] (TMDB ${req.tmdb_id})`,
    ``,
    `Items needed:`,
    ...wanted.map((i) => `  ${itemLabel(i)}${i.air_date ? ` aired ${i.air_date}` : ""}`),
    ``,
    `Quality policy: ${getSetting("quality_policy")}`,
    req.feedback ? `\nUser feedback on previous attempts (OVERRIDES the policy): ${req.feedback}` : "",
    blocked.length ? `\nPreviously failed releases — never select these:\n${blocked.map((b) => `  - ${b}`).join("\n")}` : "",
    ``,
    `Select the smallest set of torrents that covers the needed items at appropriate quality.`,
    `Prefer a season pack when it covers most of a season's needed episodes; use single episodes for stragglers.`,
    `Judge quality from the release name (resolution, source, codec, group) and the policy above — you know what kind of title this is.`,
    `Do not select redundant "backup" torrents. Map every selection to the item ids it covers.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { model, modelId } = modelFor("select");
  const started = performance.now();
  let error: string | undefined;
  let costUsd: number | null = null;
  try {
    const result = await generateText({
      model,
      tools: { search: searchTool, submit_plan: submitTool },
      stopWhen: [stepCountIs(16), hasToolCall("submit_plan")],
      prompt,
    });
    costUsd = openRouterCost(result.steps);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  logDecision({
    task: "select",
    model: modelId,
    input: { prompt, requestId: req.id },
    output: { plan: submitted, searches },
    error,
    durationMs: performance.now() - started,
    costUsd,
  });
  if (error) {
    logEvent({ level: "error", message: `Selection failed: ${error}`, requestId: req.id });
    return { kind: "error" };
  }

  const plan = submitted as PlanPayload | null;
  if (!plan || plan.selections.length === 0) {
    logEvent({
      level: "warn",
      message: `Selection found nothing suitable${plan ? `: ${plan.reasoning}` : ""}`,
      requestId: req.id,
    });
    return { kind: "empty" };
  }

  const res = d
    .prepare("INSERT INTO plans (request_id, payload) VALUES (?, ?)")
    .run(req.id, JSON.stringify(plan));
  const planId = Number(res.lastInsertRowid);
  logEvent({
    message: `Plan #${planId} awaiting approval: ${plan.selections.length} torrent(s) for ${label}`,
    requestId: req.id,
    data: { selections: plan.selections.map((s) => ({ title: s.title, items: s.itemIds.length })) },
  });
  return { kind: "plan", planId };
}

/**
 * Record a selection run and decide when the next one may happen. Only empty
 * runs grow the backoff; a plan or an error retries at the base interval (a
 * plan normally parks the request on a live torrent or pending approval
 * anyway — the interval matters only if every grab in it failed). The
 * items_wanted_* triggers reset all of this when the wanted set changes.
 */
function scheduleNextSelect(req: RequestRow, outcome: SelectOutcome) {
  const baseHours = Number(getSetting("reselect_backoff_hours")) || 24;
  const maxDays = Number(getSetting("reselect_max_days")) || 30;
  const misses = outcome.kind === "empty" ? req.select_misses + 1 : outcome.kind === "plan" ? 0 : req.select_misses;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const next = nextSelectAt(now, outcome.kind === "empty" ? misses : 1, baseHours, maxDays);
  db()
    .prepare("UPDATE requests SET last_select_at = ?, select_misses = ?, next_select_at = ? WHERE id = ?")
    .run(now, misses, next, req.id);
  if (outcome.kind === "empty" && misses > 1)
    logEvent({ message: `Nothing found ${misses} times in a row — next search ${next} UTC`, requestId: req.id });
}

/** Find requests due for selection and run the agent for each. */
export async function runSelections() {
  const d = db();
  const due = d
    .prepare(
      `SELECT r.* FROM requests r
       WHERE r.status = 'active'
       AND EXISTS (SELECT 1 FROM items i WHERE i.request_id = r.id AND i.status = 'wanted')
       AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.request_id = r.id AND p.status = 'pending')
       AND NOT EXISTS (
         SELECT 1 FROM torrents t JOIN torrent_items ti ON ti.torrent_hash = t.hash
         JOIN items i ON i.id = ti.item_id
         WHERE i.request_id = r.id AND t.status IN ('added', 'downloading', 'completed')
       )
       AND (r.next_select_at IS NULL OR r.next_select_at <= datetime('now'))`,
    )
    .all() as RequestRow[];

  for (const req of due) {
    const wanted = d
      .prepare("SELECT * FROM items WHERE request_id = ? AND status = 'wanted' ORDER BY season, episode")
      .all(req.id) as ItemRow[];
    if (wanted.length === 0) continue;
    const outcome = await selectForRequest(req, wanted);
    scheduleNextSelect(req, outcome);
    if (outcome.kind === "plan" && getSetting("approval_mode") === "auto") {
      const { planId } = outcome;
      d.prepare("UPDATE plans SET status = 'approved' WHERE id = ?").run(planId);
      logEvent({ message: `Plan #${planId} auto-approved`, requestId: req.id });
      await executePlan(planId);
    }
  }
}

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config";
import { db, getSetting } from "./db";

let _provider: ReturnType<typeof createOpenRouter> | null = null;

function provider() {
  if (!_provider) _provider = createOpenRouter({ apiKey: config().OPENROUTER_API_KEY });
  return _provider;
}

export type LlmTask = "select" | "map";

/** Model + reasoning effort come from settings so swaps are a UI edit. */
export function modelFor(task: LlmTask) {
  const model = getSetting(task === "select" ? "model_select" : "model_map");
  const effort = getSetting(task === "select" ? "effort_select" : "effort_map");
  return {
    model: provider().chat(model, {
      extraBody: { reasoning: { effort } },
      usage: { include: true }, // per-response cost, see openRouterCost
    }),
    modelId: model,
  };
}

type StepMetadata = { providerMetadata?: Record<string, Record<string, unknown>> | undefined };

/**
 * Total USD cost reported by OpenRouter usage accounting. A tool loop is one
 * billed response per step, so sum them all. Null when nothing reported one.
 */
export function openRouterCost(steps: StepMetadata[]): number | null {
  let total: number | null = null;
  for (const s of steps) {
    const cost = (s.providerMetadata?.openrouter?.usage as { cost?: number } | undefined)?.cost;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total;
}

export function logDecision(opts: {
  task: LlmTask;
  model: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  costUsd?: number | null;
}) {
  db().prepare(
    "INSERT INTO decisions (task, model, input, output, error, duration_ms, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    opts.task,
    opts.model,
    JSON.stringify(opts.input),
    opts.output === undefined ? null : JSON.stringify(opts.output),
    opts.error ?? null,
    Math.round(opts.durationMs),
    opts.costUsd ?? null,
  );
}

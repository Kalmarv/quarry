import { db, logEvent } from "../db";
import { pollSeerr, refreshAiring } from "./poller";
import { monitorTorrents } from "./monitor";
import { importCompleted } from "./import";
import { runSelections } from "./select";

let running = false;

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    logEvent({
      level: "error",
      message: `${name} failed: ${e instanceof Error ? e.message : e}`,
    });
  }
}

/** Close out requests whose items have all reached a terminal state. */
function completeRequests() {
  const d = db();
  const done = d
    .prepare(
      `UPDATE requests SET status = 'completed', updated_at = datetime('now')
       WHERE status = 'active'
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status NOT IN ('done'))
       AND EXISTS (SELECT 1 FROM items i WHERE i.request_id = requests.id)
       RETURNING id, title`,
    )
    .all() as { id: number; title: string }[];
  for (const r of done) logEvent({ message: `Request completed: ${r.title}`, requestId: r.id });

  const failed = d
    .prepare(
      `UPDATE requests SET status = 'failed', updated_at = datetime('now')
       WHERE status = 'active'
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status NOT IN ('done', 'failed'))
       AND EXISTS (SELECT 1 FROM items i WHERE i.request_id = requests.id AND i.status = 'failed')
       RETURNING id, title`,
    )
    .all() as { id: number; title: string }[];
  for (const r of failed)
    logEvent({ level: "warn", message: `Request failed (some items unobtainable): ${r.title}`, requestId: r.id });
}

/**
 * One reconciliation pass. Every step is idempotent; order matters only for
 * responsiveness (observe first, then decide).
 */
export async function tick() {
  if (running) return;
  running = true;
  try {
    await step("pollSeerr", pollSeerr);
    await step("refreshAiring", refreshAiring);
    await step("monitorTorrents", monitorTorrents);
    await step("importCompleted", importCompleted);
    await step("runSelections", runSelections);
    completeRequests();
  } finally {
    running = false;
  }
}

/** Kick a tick soon without awaiting it (used after approve/inject). */
export function tickSoon(delayMs = 500) {
  setTimeout(() => void tick(), delayMs);
}

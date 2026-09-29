// The API speaks two kinds of time: SQLite UTC timestamps ("2026-09-29 19:41:26")
// and TMDB calendar dates ("2026-10-13"), which are days, not instants.

const DAY = 86_400_000;

export const fromDb = (ts: string) => new Date(ts.replace(" ", "T") + "Z");

/** A calendar date as local midnight, so "today" means the viewer's today. */
const fromDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day);
};

const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

/** "Oct 13", or "Jan 19, 2027" outside the current year. */
export function shortDate(d: Date | string): string {
  const date = typeof d === "string" ? fromDate(d) : d;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Distance to a calendar date: "today", "tomorrow", "in 5 days", "in 3 months". */
export function untilDate(d: string): string {
  const days = Math.round((fromDate(d).getTime() - startOfToday().getTime()) / DAY);
  if (days < 0) return "already out";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  const years = Math.round(days / 365);
  return years === 1 ? "in a year" : `in ${years} years`;
}

/** Distance to a timestamp in the future: "in 3 hours", "in 12 days". */
export function untilTs(ts: string): string {
  const ms = fromDb(ts).getTime() - Date.now();
  if (ms <= 60_000) return "any moment";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

/** Distance to a timestamp in the past: "just now", "4 min ago", "3 days ago". */
export function ago(ts: string): string {
  const mins = Math.round((Date.now() - fromDb(ts).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days} days ago`;
  return shortDate(fromDb(ts));
}

/** Local clock time for a timestamp, "21:04". */
export const clock = (ts: string) =>
  fromDb(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Local calendar day heading for a timestamp: "Today", "Yesterday", "Sep 27". */
export function dayLabel(ts: string): string {
  const d = fromDb(ts);
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfToday().getTime() - local.getTime()) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return shortDate(local);
}

export const size = (bytes: number | null) => {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const episodeCode = (season: number, episode: number) =>
  `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

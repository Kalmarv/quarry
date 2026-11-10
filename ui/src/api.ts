export type Phase = "review" | "failed" | "downloading" | "searching" | "upcoming" | "done";

export type Req = {
  id: number;
  title: string;
  year: number | null;
  media_type: "movie" | "tv";
  source: "seerr" | "letterboxd" | "manual";
  requested_by: string | null;
  status: "active" | "completed" | "failed" | "dismissed";
  phase: Phase;
  item_count: number;
  done_count: number;
  failed_count: number;
  wanted_count: number;
  active_count: number;
  unaired_count: number;
  next_air_date: string | null;
  pending_plan_id: number | null;
  live_torrents: number;
  download_progress: number | null;
  select_misses: number;
  last_select_at: string | null;
  next_select_at: string | null;
  poster_path: string | null; // TMDB image path; '' = TMDB has none
  backdrop_path: string | null;
  overview: string | null;
  created_at: string;
  updated_at: string;
};

export type Item = {
  id: number;
  season: number;
  episode: number;
  title: string | null;
  status: "unaired" | "wanted" | "selecting" | "grabbing" | "downloading" | "importing" | "done" | "failed";
  attempts: number;
  file_path: string | null;
  failure: string | null;
  air_date: string | null;
};

export type Selection = {
  title: string;
  indexer: string;
  size: number;
  seeders: number;
  itemIds: number[];
};

export type Plan = {
  id: number;
  request_id: number;
  payload: string; // JSON { selections, reasoning }
  status: "pending" | "approved" | "rejected" | "superseded";
  feedback: string | null;
  created_at: string;
};

export type Torrent = {
  hash: string;
  title: string;
  size: number | null;
  status: "added" | "downloading" | "completed" | "imported" | "failed";
  progress: number;
  failure: string | null;
  added_at: string;
};

export type Ev = {
  id: number;
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  request_id: number | null;
  request_title?: string | null;
};

export type RequestDetail = {
  request: Req;
  items: Item[];
  plans: Plan[];
  torrents: Torrent[];
  events: Ev[];
};

/** A TMDB image URL, or null when there's no artwork (yet). */
export const tmdbImage = (path: string | null, width: "w92" | "w185" | "w342" | "w1280") =>
  path ? `https://image.tmdb.org/t/p/${width}${path}` : null;

export const parsePlan = (p: Plan) => JSON.parse(p.payload) as { selections: Selection[]; reasoning: string };

const json = <T,>(r: Response) => r.json() as Promise<T>;
const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const api = {
  requests: () => fetch("/api/requests").then(json<Req[]>),
  request: (id: number) => fetch(`/api/requests/${id}`).then(json<RequestDetail>),
  events: (limit = 300) => fetch(`/api/events?limit=${limit}`).then(json<Ev[]>),
  settings: () => fetch("/api/settings").then(json<Record<string, string>>),
  saveSettings: (s: Record<string, string>) => send("/api/settings", "PUT", s),
  approve: (planId: number) => send(`/api/plans/${planId}/approve`, "POST"),
  reject: (planId: number, feedback: string) => send(`/api/plans/${planId}/reject`, "POST", { feedback }),
  searchNow: (id: number) => send(`/api/requests/${id}/search`, "POST"),
  retry: (id: number) => send(`/api/requests/${id}/retry`, "POST"),
  dismiss: (id: number) => send(`/api/requests/${id}`, "DELETE"),
  sync: () => send("/api/tick", "POST"),
};

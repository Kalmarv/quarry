import { config } from "../config";

const CATEGORY = "quarry";
// Full "name=value" session cookie. qBittorrent 5.2 renamed it from "SID" to
// a port-suffixed "QBT_SID_<port>" and returns 204 on login — never assume
// the cookie name, echo back whatever was set.
let cookie: string | null = null;

async function login(): Promise<string> {
  const { QBIT_URL, QBIT_USERNAME, QBIT_PASSWORD } = config();
  const res = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${encodeURIComponent(QBIT_USERNAME)}&password=${encodeURIComponent(QBIT_PASSWORD)}`,
  });
  const pair = res.headers.get("set-cookie")?.split(";")[0]?.trim();
  if (!res.ok || !pair || !pair.includes("=")) {
    throw new Error(`qbit login failed (${res.status}, cookie: ${pair ?? "none"})`);
  }
  cookie = pair;
  return cookie;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  const { QBIT_URL } = config();
  if (!cookie) await login();
  const doFetch = () =>
    fetch(`${QBIT_URL}/api/v2${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), Cookie: cookie! },
    });
  let res = await doFetch();
  if (res.status === 403 || res.status === 401) {
    await login();
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`qbit ${path} -> ${res.status}`);
  return res;
}

/** Add a torrent by magnet URI or raw .torrent bytes, under the quarry category. */
export async function addTorrent(input: { magnet?: string; bytes?: Uint8Array }) {
  const form = new FormData();
  form.set("category", CATEGORY);
  if (input.magnet) form.set("urls", input.magnet);
  else if (input.bytes) {
    form.set(
      "torrents",
      new File([input.bytes as BlobPart], "release.torrent", { type: "application/x-bittorrent" }),
    );
  } else throw new Error("addTorrent needs magnet or bytes");
  const res = await call("/torrents/add", { method: "POST", body: form });
  const text = await res.text();
  if (text.trim().startsWith("Fail")) throw new Error(`qbit add: ${text.trim()}`);
}

export type QbitTorrent = {
  hash: string;
  name: string;
  state: string;
  progress: number; // 0..1
  num_seeds: number;
  content_path: string;
  save_path: string;
};

export async function getByHashes(hashes: string[]): Promise<QbitTorrent[]> {
  if (hashes.length === 0) return [];
  const res = await call(`/torrents/info?hashes=${hashes.join("|")}`);
  return (await res.json()) as QbitTorrent[];
}

export type QbitFile = { index: number; name: string; size: number; progress: number };

export async function getFiles(hash: string): Promise<QbitFile[]> {
  const res = await call(`/torrents/files?hash=${hash}`);
  return (await res.json()) as QbitFile[];
}

export const DEAD_STATES = new Set(["error", "missingFiles"]);
export const COMPLETE_STATES = new Set([
  "uploading",
  "stalledUP",
  "pausedUP",
  "stoppedUP",
  "queuedUP",
  "forcedUP",
  "checkingUP",
]);

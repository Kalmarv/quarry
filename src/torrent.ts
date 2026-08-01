import { createHash } from "node:crypto";

// Minimal bencode decoder that tracks byte offsets, so we can slice the raw
// bytes of the `info` dict out of the original buffer. The infohash is the
// SHA-1 of those exact bytes — re-encoding is never byte-safe.

type Decoded = { value: unknown; start: number; end: number };

function decode(buf: Uint8Array, pos: number): Decoded {
  const start = pos;
  const c = buf[pos];
  if (c === undefined) throw new Error("bencode: unexpected end of buffer");
  if (c === 0x69) {
    // i<int>e
    let end = pos + 1;
    while (buf[end] !== 0x65) {
      if (end >= buf.length) throw new Error("bencode: unterminated integer");
      end++;
    }
    const value = Number(new TextDecoder().decode(buf.slice(pos + 1, end)));
    return { value, start, end: end + 1 };
  }
  if (c === 0x6c) {
    // l...e
    const list: unknown[] = [];
    pos++;
    while (buf[pos] !== 0x65) {
      const d = decode(buf, pos);
      list.push(d.value);
      pos = d.end;
    }
    return { value: list, start, end: pos + 1 };
  }
  if (c === 0x64) {
    // d...e
    const dict: Record<string, { value: unknown; start: number; end: number }> = {};
    pos++;
    while (buf[pos] !== 0x65) {
      const key = decode(buf, pos);
      pos = key.end;
      const val = decode(buf, pos);
      const keyStr = typeof key.value === "string" ? key.value : String(key.value);
      dict[keyStr] = { value: val.value, start: val.start, end: val.end };
      pos = val.end;
    }
    return { value: dict, start, end: pos + 1 };
  }
  if (c >= 0x30 && c <= 0x39) {
    // <len>:<bytes>
    let colon = pos;
    while (buf[colon] !== 0x3a) {
      if (colon >= buf.length) throw new Error("bencode: unterminated string length");
      colon++;
    }
    const len = Number(new TextDecoder().decode(buf.slice(pos, colon)));
    const end = colon + 1 + len;
    if (end > buf.length) throw new Error("bencode: string exceeds buffer");
    const raw = buf.slice(colon + 1, end);
    // Keys and names are UTF-8 text; pieces are binary. Decode leniently.
    const value = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    return { value, start, end };
  }
  throw new Error(`bencode: unexpected byte 0x${c.toString(16)} at ${pos}`);
}

/** Compute the v1 infohash (lowercase hex) and display name of a .torrent file. */
export function parseTorrentFile(buf: Uint8Array): { hash: string; name: string } {
  const top = decode(buf, 0);
  const dict = top.value as Record<string, { value: unknown; start: number; end: number }>;
  const info = dict["info"];
  if (!info) throw new Error("torrent file has no info dict");
  const infoBytes = buf.slice(info.start, info.end);
  const hash = createHash("sha1").update(infoBytes).digest("hex");
  const infoDict = info.value as Record<string, { value: unknown }>;
  const name = String(infoDict["name"]?.value ?? "");
  return { hash, name };
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToHex(s: string): string {
  let bits = "";
  for (const ch of s.toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.slice(0, 40);
}

/** Extract the v1 infohash (lowercase hex) and display name from a magnet URI. */
export function parseMagnet(uri: string): { hash: string; name: string | null } {
  const url = new URL(uri);
  if (url.protocol !== "magnet:") throw new Error("not a magnet URI");
  const params = new URLSearchParams(url.search || uri.slice(uri.indexOf("?") + 1));
  for (const xt of params.getAll("xt")) {
    const m = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt);
    if (m && m[1]) {
      const raw = m[1];
      const hash = raw.length === 40 ? raw.toLowerCase() : base32ToHex(raw);
      return { hash, name: params.get("dn") };
    }
  }
  throw new Error("magnet URI has no btih hash");
}

export type Resolved =
  | { kind: "magnet"; hash: string; magnet: string }
  | { kind: "file"; hash: string; bytes: Uint8Array };

/**
 * Resolve a Prowlarr release link to a known infohash BEFORE anything is
 * added to qBittorrent. Follows redirects manually because indexer download
 * URLs frequently redirect to magnet: links, which fetch() cannot follow.
 */
export async function resolveRelease(link: string, maxHops = 5): Promise<Resolved> {
  let current = link;
  for (let hop = 0; hop < maxHops; hop++) {
    if (current.startsWith("magnet:")) {
      const { hash } = parseMagnet(current);
      return { kind: "magnet", hash, magnet: current };
    }
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect without location from ${current}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`fetch ${res.status} for release link`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { hash } = parseTorrentFile(bytes);
    return { kind: "file", hash, bytes };
  }
  throw new Error("too many redirects resolving release link");
}

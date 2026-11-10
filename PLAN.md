# Quarry v2 — Design

Ground-up rebuild of the AI media downloader. Most of v1's fixes were
band-aids over a pipeline that lost track of state; this doc is the contract
for v2.

## Core principle

**Deterministic spine, LLM only where fuzz is irreducible.** Identity, paths,
naming, and state are code. Interpreting messy human-named releases is the LLM.

## Architecture: a reconciler, not a pipeline

No state machine library. A worker tick (every 2 min + event triggers) converges
desired state (wanted items) with observed state (qBittorrent, filesystem,
Jellyfin). Every step is idempotent; the DB row *is* the position. Restart-safe
by construction — there is no in-memory context to lose.

### The item is the unit of work

One row per movie or per episode, natural key `(tmdb_id, season, episode)`.
Item status: `unaired → wanted → selecting → grabbing → downloading → importing → done | failed`.
A request is a label over items. This gives us for free: partial-season
downloads, airing shows (unaired items flip to wanted when the air date
passes), per-episode success/failure, and dedup (the natural key is the
idempotency key).

### Torrents tracked by hash from birth — never by name

Grab flow: fetch release from Prowlarr → magnet? parse `btih` from URI;
`.torrent` file? SHA-1 of the bencoded info dict → that IS the infohash →
insert `torrents` row → add to qBittorrent (category `quarry`) → confirm via
the 5.2 add-response. Monitoring is `torrents/info?hashes=`. File locations
come from `torrents/files` + `content_path` (mapped `/downloads` →
`DOWNLOADS_PATH`) — asked, never reconstructed from names. Blocklist is
hash-keyed. Targets qBittorrent 5.2+.

### Seerr: poll, don't impersonate

Poller hits Jellyseerr's request API every tick for approved requests; upserts
requests + items (episode lists + air dates from Seerr's TMDB proxy). No
webhook parsing, no profile correlation. A ~60-line arr-compat **stub** exists
only so Seerr's UI has a valid download server (single "Default" quality
profile, discard POSTs).

### No quality profiles

One global quality policy paragraph (editable in settings), applied by the
selection LLM per title: prefer 4K HDR when available; high-bitrate encodes
for films that merit it; efficient encodes for casual/kids/comedy; TV = 4K
efficient or 1080p for comedies/long-running shows; never grab upscales or
garbage encodes to hit a resolution target. Per-request exceptions go through
reject-with-feedback.

### LLM: exactly two call sites, via OpenRouter (Vercel AI SDK)

| Task | Model | Effort | Shape |
|---|---|---|---|
| `select` — pick releases for wanted items | `openai/gpt-6-luna` | high | bounded tool loop (search_prowlarr tool, max ~12 steps) → submits plan: `{candidateIndex, coversItems[]}` |
| `map` — map torrent files to items | `openai/gpt-6-luna` | medium | one generateObject call: `{fileIndex → itemId | junk}` |

Rules learned from v1: LLMs select **by index**, never echo identifiers;
**destination paths are built by code** from templates + item metadata
(`Show (Year)/Season 02/Show (Year) - S02E03.mkv`), with existing-folder
resolution done deterministically against the library dir. Models/efforts are
settings rows — swapping is a UI edit, not a deploy.

### Import

Hardlink-first (downloads and library must be on the same filesystem),
copy fallback (extracted
archives). Atomic: write `.partial`, rename into place; exists = already done.
ffprobe validates **before** the file lands in the library. Junk filtered by
extension allowlist in code. Rate-limit metadata bursts (NAS safety: small
sleep between link ops).

### Approval

Manual for now: selection produces a plan (proposed torrents + coverage +
reasoning) → UI approve/reject-with-feedback → approve executes grabs;
feedback is stored on the request and fed to the next selection run.

### Observability

Append-only `events` table written by the workers as they act (first-class,
not derived from transitions). `decisions` logs every LLM call with cost.

## DB (SQLite, WAL, lives in ./data — local disk, never CIFS)

- `requests` — seerr_request_id UNIQUE, media_type, tmdb_id, title, year, requested_seasons, status, feedback
- `items` — UNIQUE(tmdb_id, season, episode), status, request_id, air_date, file_path, failure
- `torrents` — hash PK, release title, indexer, size, status, progress, content_path
- `torrent_items` — m2m
- `plans` — request_id, payload JSON (proposed grabs), status pending/approved/rejected, feedback
- `events`, `decisions`, `settings`, `blocklist` (hash-keyed)

## Module map (src/)

- `config.ts` env · `db.ts` schema+helpers · `llm.ts` OpenRouter wrapper + decision log
- `clients/` seerr, prowlarr, qbittorrent (v2 API, cookie auth), jellyfin (snapshot)
- `core/poller.ts` seerr→items · `core/select.ts` selection agent · `core/grab.ts` infohash+add
- `core/monitor.ts` hash-based progress/stall · `core/import.ts` map+name+link+probe
- `core/reconcile.ts` the tick · `torrent.ts` bencode/infohash/magnet parsing
- `api/` routes + arr-stub · `index.ts` boot

## Failure semantics

- Torrent stalled (0 seeders, no payload progress 12h) → fail torrent, blocklist hash, items → wanted (re-select excludes blocklisted hashes; feedback notes the failure).
- ffprobe fail → delete the bad library file, blocklist hash, items → wanted.
- Selection finds nothing → items stay wanted, retried next day (backoff in settings), surfaced in UI.
- 3 failed grabs for an item → item failed, surfaced in UI. No infinite loops: attempt counter on items.

## v1 lessons enforced here

1. Torrent identity = infohash, computed client-side before add. No name matching anywhere.
2. No in-memory workflow state. No context hydration. No lossy status mapping.
3. Item-level state — no silent partial success.
4. LLM writes no paths, echoes no filenames — indices only.
5. No Sonarr impersonation as a data path — poll the Seerr API.
6. Events written by the code doing the work, not projected from a framework.
7. Wall-clock liveness per torrent/item with explicit reasons, not a global staleness timer.

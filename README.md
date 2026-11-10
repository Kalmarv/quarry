# Quarry

Quarry fetches the movies and TV shows people request in
[Seerr](https://github.com/seerr-team/seerr) (formerly Jellyseerr). It does the
job of Radarr and Sonarr, but an LLM picks the releases. It searches your
indexers through Prowlarr, picks a release for each request, downloads it with
qBittorrent, renames and hardlinks the files into your library, and asks
Jellyfin to rescan.

Code does everything that has a right answer: identity, state, paths, naming
and verification. The LLM only handles the fuzzy parts:

- **Selection.** Given a title, its TMDB facts (director, cast, runtime,
  release dates) and a plain-English quality policy, the model searches
  Prowlarr and picks which releases cover which episodes.
- **File mapping.** Given a finished torrent's file list, the model says which
  file is which episode and which files are junk.

The model picks results by index and never writes a path. Destination paths come
from templates (`Show (Year)/Season 02/Show (Year) - S02E03.mkv`).

## How it works

Quarry is a reconciler, not a pipeline. Every two minutes (or when you press
*Check now*) one tick compares what is wanted with what qBittorrent, the disk
and Jellyfin report, and takes the next step for each item. Every step is
idempotent, and all state lives in SQLite, so a restart loses nothing.

- **One row per movie or episode.** Partial seasons, airing shows and
  per-episode failures fall out of that. Episodes that haven't aired wait as
  `unaired` until their air date, and films wait until a digital or physical
  release exists.
- **Torrents are tracked by infohash from the moment they are grabbed.** The
  hash is computed before the torrent is added, never matched by name.
  Failed torrents are blocklisted by hash.
- **Seerr is polled, not impersonated.** Quarry reads approved requests from
  Seerr's API. A small Radarr/Sonarr-compatible stub exists only so Seerr will
  accept Quarry as a download server.
- **Imports are checked before they land.** Hardlinks are preferred (copies are
  used for extracted archives), and ffprobe must accept a file before it is
  renamed into the library.
- **Plans can wait for approval.** With `approval_mode` set to `manual`, each
  selection becomes a plan you approve or reject with feedback in the UI. The
  feedback goes into the next selection.
- **Optional Letterboxd picks.** Quarry can request films trending on
  Letterboxd above a rating threshold.

[PLAN.md](PLAN.md) is the full design document.

## Requirements

- Docker with Compose
- [Seerr](https://github.com/seerr-team/seerr) 3.x (tested on 3.5.1)
- [Prowlarr](https://prowlarr.com/) with at least one indexer
- [qBittorrent](https://www.qbittorrent.org/) 5.2+ with the Web UI enabled
- [Jellyfin](https://jellyfin.org/)
- An [OpenRouter](https://openrouter.ai/) API key

Downloads and the library must be on the same filesystem, so that imports can
hardlink instead of copying.

## Setup

1. **Configure.** Copy `.env.example` to `.env` and fill it in.

   | Variable | Meaning |
   |---|---|
   | `SEERR_URL`, `SEERR_API_KEY` | Seerr base URL and API key (Settings → General) |
   | `PROWLARR_URL`, `PROWLARR_API_KEY` | Prowlarr base URL and API key |
   | `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` | qBittorrent Web UI login |
   | `JELLYFIN_URL`, `JELLYFIN_API_KEY` | Jellyfin base URL and an API key |
   | `OPENROUTER_API_KEY` | OpenRouter key for the two LLM calls |
   | `MEDIA_ROOT` | Host directory containing downloads and library; mounted into the container at the same path |
   | `LIBRARY_MOVIES`, `LIBRARY_TV` | Library folders Jellyfin watches |
   | `DOWNLOADS_PATH` | Where qBittorrent saves downloads, as a host path |
   | `QBIT_PATH_PREFIX` | The same folder as qBittorrent sees it inside its own container (default `/downloads`) |

2. **Start it.**

   ```sh
   docker compose up -d --build
   ```

   The UI is at `http://<host>:3004`. The SQLite database lives in `./data`,
   which should be on local disk, not a network share.

3. **Point Seerr at Quarry.** In Seerr, under Settings → Services, add a Radarr
   server and a Sonarr server. Both use Quarry's host, port `3004`, an empty
   URL base and any API key. Pick the "Default" profile and the root folder it
   offers. Quarry ignores what Seerr sends there and reads the requests itself.

4. **Review settings in the UI.** Settings are stored in the database and can
   be changed without a redeploy. They include the quality policy, the model
   and reasoning effort for each LLM task, approval mode, retry backoff and
   Letterboxd picks. **Two defaults are worth checking first:**
   `approval_mode` is `auto`, which grabs without asking, and Letterboxd picks
   are on.

Quarry adds torrents under the qBittorrent category `quarry`.

## Security

The UI, its API and the Radarr/Sonarr stub have **no authentication**. Run
Quarry on a trusted network, or put it behind a reverse proxy that handles
login.

## Development

Uses [Bun](https://bun.sh/).

```sh
bun install && (cd ui && bun install)
bun test               # unit tests
bun run typecheck
bun --env-file=.env run src/index.ts   # API on :3000
(cd ui && bun run dev)                 # UI with hot reload, proxies /api to :3000
```

`scripts/compare-select.ts` replays the selection agent on a real request
against several models side by side. It only reads the live database.

| Path | What it does |
|---|---|
| `src/core/reconcile.ts` | The tick |
| `src/core/poller.ts` | Seerr requests → items, air-date refresh |
| `src/core/select.ts` | Selection agent |
| `src/core/grab.ts`, `src/torrent.ts` | Infohash computation and adding to qBittorrent |
| `src/core/monitor.ts` | Download progress and stall detection |
| `src/core/import.ts` | File mapping, naming, hardlinking, ffprobe |
| `src/clients/` | Seerr, Prowlarr, qBittorrent, Jellyfin, Letterboxd |
| `src/api/` | UI API and the Radarr/Sonarr stub |
| `ui/` | React + Vite dashboard |

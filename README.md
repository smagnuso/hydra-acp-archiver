# hydra-acp-archiver

Sync extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Keeps your agent sessions in sync across the machines you work on by uploading session bundles to a shared backend (Google Drive, plain filesystem) after every turn and importing peers' bundles in the background.

Runs as a daemon-managed process, so sessions started on machine A become available on machine B without any manual export/import.

## How it works

1. **Startup cold sweep**: lists every session the daemon knows about and exports the cold ones — so installing the archiver on a machine with a pile of existing sessions backfills them all to the backend without the user having to touch each one. Hash-dedup keeps subsequent restarts cheap (already-uploaded sessions are skipped).
2. **Live monitoring**: watches every live hydra session via the daemon's WebSocket. When a session emits `turn_complete`, the archiver schedules a debounced flush (default 5 s window).
3. **On flush**: asks the daemon to `GET /v1/sessions/:id/export`, wraps the resulting `.hydra` bundle in a sync envelope (lineageId + hash + uploader info), and writes it to the backend keyed by `lineageId`.
4. **Live → cold final flush**: when a session goes cold (daemon detaches), one last flush captures its latest state before the WS bridge tears down.
5. **Pull loop**: on a separate timer (default 60 s), lists the backend, downloads any envelope newer than what it last saw, and POSTs the bundle to `/v1/sessions/import` with `replace: true`.
6. **De-dup**: uses hydra's stable `lineageId` (it survives every export/import hop) plus a SHA-256 of the canonicalized bundle to skip uploads when content hasn't actually changed.

Conflict resolution is last-writer-wins by envelope `uploadedAt`. The envelope format leaves room for a future `activeOn` claim-lock; not in this release.

## Install

From npm (recommended once published):

```sh
npm install -g @hydra-acp/archiver
```

Drops a `hydra-acp-archiver` binary on your PATH.

Or from source:

```sh
git clone git@github.com:smagnuson/hydra-acp-archiver.git ~/dev/hydra-acp-archiver
cd ~/dev/hydra-acp-archiver
npm install
npm run build
```

Register the extension with hydra:

```sh
hydra-acp extensions add hydra-acp-archiver --command hydra-acp-archiver
```

Or pointed at a local build:

```sh
hydra-acp extensions add hydra-acp-archiver \
  --command node \
  --args ~/dev/hydra-acp-archiver/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "extensions": {
    "hydra-acp-archiver": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-archiver/dist/index.js"],
      "enabled": true
    }
  }
}
```

On `hydra-acp daemon start`, hydra spawns hydra-acp-archiver as a managed subprocess. Stdout/stderr land in `~/.hydra-acp/extensions/hydra-acp-archiver.log`.

## First-time Google setup

The Google Drive backend uses OAuth 2.0 with the **`drive.file`** scope — the archiver can only see files it creates plus those you explicitly hand it via a picker. Your other Drive contents stay invisible to it.

You provide your own OAuth client (Google's terms make it impractical to ship a shared one):

1. Go to <https://console.cloud.google.com/> and create or pick a project.
2. Enable the **Google Drive API** for that project.
3. Configure the **OAuth consent screen**. User type: **External**. Add your Google account under **Test Users**.
4. **Credentials → Create credentials → OAuth client ID**. Application type: **Desktop app**.
5. Download the resulting JSON and save it to `~/.hydra-acp/archiver-google-credentials.json` (or anywhere, and set `HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS`).
6. Run:

   ```sh
   hydra-acp-archiver login
   ```

   Your browser opens to Google's consent screen. The "Google hasn't verified this app" interstitial is expected for an unverified personal-use client — click **Advanced → Go to (unsafe)** and approve. The redirect lands on a transient local server, the archiver writes `~/.hydra-acp/archiver-google-token.json` (mode 0600), and you're done.

After this, restart the daemon. The archiver process starts up, creates a `hydra-acp-archive/` folder in your Drive on first upload, and begins syncing.

## Multi-machine setup

Repeat the same login flow on each machine that should sync, using the **same Google account**. Each machine gets its own refresh token; they all point at the same Drive folder.

If you want a different Drive folder per "team" or "context," set `HYDRA_ACP_ARCHIVER_DRIVE_FOLDER` on every participating machine to the same value.

## Filesystem backend

Useful for testing locally, or for pointing at a folder that a separate sync tool (Syncthing, Dropbox client) already mirrors across your machines.

```json
{
  "extensions": {
    "hydra-acp-archiver": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-archiver/dist/index.js"],
      "env": {
        "HYDRA_ACP_ARCHIVER_BACKEND": "fs",
        "HYDRA_ACP_ARCHIVER_FS_DIR": "/home/you/Sync/hydra-archive"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `HYDRA_ACP_ARCHIVER_BACKEND` | `google-drive` | `google-drive` \| `fs` |
| `HYDRA_ACP_ARCHIVER_DRIVE_FOLDER` | `hydra-acp-archive` | Drive folder name |
| `HYDRA_ACP_ARCHIVER_FS_DIR` | `~/.hydra-acp/archive` | Used when backend is `fs` |
| `HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS` | `~/.hydra-acp/archiver-google-credentials.json` | OAuth client JSON from GCP |
| `HYDRA_ACP_ARCHIVER_CONFIG` | `~/.hydra-acp/archiver.config.js` | Rule file (optional) |
| `HYDRA_ACP_ARCHIVER_POLL_MS` | `2000` | Session discovery cadence |
| `HYDRA_ACP_ARCHIVER_DEBOUNCE_MS` | `5000` | Per-session upload debounce window |
| `HYDRA_ACP_ARCHIVER_PULL_MS` | `60000` | Backend list cadence |
| `DEBUG` | `false` | Verbose logging |

## Rule (opt-out specific sessions)

By default the archiver uploads every live session. Drop a JS module at `~/.hydra-acp/archiver.config.js` (or `HYDRA_ACP_ARCHIVER_CONFIG`) to skip some:

```js
// ~/.hydra-acp/archiver.config.js
export default function archive(ev) {
  // ev.sessionId, ev.lineageId
  // ev.meta.cwd, ev.meta.agentId, ev.meta.title

  // Don't sync work in throwaway scratch dirs:
  if (ev.meta.cwd?.startsWith("/tmp/")) {
    return false;
  }

  // Don't sync sessions whose title is prefixed with "(local)":
  if (ev.meta.title?.startsWith("(local)")) {
    return false;
  }

  return true;
}
```

Return `false` to skip an upload. Any other value (including `undefined`) archives. The rule reloads on SIGHUP, so you don't need to restart the daemon to change it.

## On-disk state

- `~/.hydra-acp/archiver-state.json` — per-lineage cache of last uploaded hash + last seen remote upload, used for self-loop suppression. Safe to delete; archiver will rebuild it.
- `~/.hydra-acp/archiver-google-credentials.json` — OAuth client JSON you downloaded.
- `~/.hydra-acp/archiver-google-token.json` — refresh + access token (mode 0600). Re-run `hydra-acp-archiver login` to refresh.

## Troubleshooting

- **`Missing HYDRA_ACP_TOKEN env var`** — you ran the archiver directly instead of via the daemon. Run it as a registered extension.
- **`No Google OAuth token at …`** — run `hydra-acp-archiver login` first.
- **`OAuth credentials file not found`** — follow the **First-time Google setup** steps to download the client JSON from GCP Console.
- **Files aren't appearing in Drive** — check `~/.hydra-acp/extensions/hydra-acp-archiver.log` for errors. Common: consent-screen test-user list doesn't include your Google account.
- **Two machines kept overwriting each other** — that's last-writer-wins working as designed if both are actively editing the same session. Avoid editing the same session on two machines simultaneously; one of them will lose its diff. A future `activeOn` claim-lock will close this gap.

## Backends

Current: `google-drive`, `fs`. Adding a new one means implementing the `SyncBackend` interface in `src/backend/types.ts` and wiring it into `src/backend/factory.ts`.

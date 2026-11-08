# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-archiver` — cross-machine session sync **extension** for Hydra.
Uploads session bundles to a shared backend (Google Drive, S3, plain
filesystem) after every turn and imports peers' bundles in the background,
so a session started on machine A shows up on machine B without manual
export/import. Supports optional AES-256-GCM encryption at rest.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`.

This is a **client extension**: it watches the daemon for `turn_complete`
events over WSS, calls the daemon's `GET /v1/sessions/:id/export` to grab a
`.hydra` bundle, wraps it in a sync envelope (`lineageId` + hash +
uploader), writes it to the backend, and on a separate pull timer imports
new envelopes via `POST /v1/sessions/import`.

De-dup relies on hydra's stable `lineageId` (survives every export/import
hop) plus a SHA-256 of the canonicalized bundle. Conflict resolution is
last-writer-wins by envelope `uploadedAt`.

## Layout

- `src/index.ts` — entry point
- `src/daemon.ts` — top-level extension lifecycle
- `src/discovery.ts`, `src/bridge.ts` — session discovery + per-session WS
- `src/cold-sweep.ts` — startup backfill of pre-existing cold sessions
- `src/archive-loop.ts`, `src/pull-loop.ts` — push and pull timers
- `src/envelope.ts` — sync envelope format (versioned; be careful when
  editing)
- `src/backend/` — pluggable backends (drive, fs, …)
- `src/oauth/`, `src/setup/`, `src/keygen.ts` — first-run flow
- `src/state.ts` — persisted uploader state (last-seen etc.)
- `src/rule.ts`, `src/config.ts` — user config

## Build & test

```
npm install
npm run build     # tsup → dist/
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-archiver` on PATH. Registered via
`hydra-acp extension add hydra-acp-archiver`.

## Conventions

- TypeScript, ESM, tsup, vitest.
- Envelope format is on-the-wire and versioned. Never break backward-compat
  silently — bump `envelope.version` and handle old envelopes on read.
- Encryption is optional but if enabled must be end-to-end: the backend
  never sees plaintext.
- Backends are pluggable — add new ones under `src/backend/` conforming to
  the same interface.

## Gotchas

- Live → cold transition: capture one **final** flush when a session goes
  cold, before the WS bridge tears down. Missing this loses the last turn.
- Debounced flush (default 5s) coalesces bursts — don't lower it without
  measuring backend load.
- `--replace: true` on import overwrites in place and kills any live copy
  of the session first; ensure the local `sessionId` is preserved so
  bookmarks (Slack threads, editor links) keep resolving.
- The pull loop must not re-import bundles this machine itself uploaded —
  compare uploader info before importing.
- **Hash canonicalization strips a hard-coded ephemeral field set**
  (`envelope.ts`: `exportedAt`, `exportedFrom`, `sessionId`,
  `upstreamSessionId`, `createdAt`, `updatedAt`). Any new time/id field
  added to bundle export without also adding it here will make every
  export→import→export cycle look "changed" and re-upload forever.
- **Self-loop suppression is by inner `sessionId`, not uploader host**
  (`pull-loop.ts`). This is deliberate — survives hostname changes and
  races. Do not "simplify" to `uploadedBy.host` matching or dedup breaks
  after any machine rename.
- **`resetDeletedImports` re-probes the daemon's session-id set every
  tick** (`pull-loop.ts`). This is what lets locally-deleted sessions
  re-import from the backend. Shortcutting it out will make deletion
  permanent per-machine.
- **Debounced flush timers are `.unref()`ed** (`archive-loop.ts`) —
  pending flushes cannot keep the process alive. The `finalFlush` on
  the warm→cold transition is the only *guaranteed* last write; don't
  remove it thinking the debounce will catch it.
- **Treat every path as possibly Windows-shaped, whatever host this runs on.**
  A cwd, a tool-call path or a session field can arrive as `C:\x`, `C:/x`, a
  mix, or UNC from a daemon on Windows, even when this code runs on Linux. Never
  split, prefix-match or find the last separator with a hard-coded `/` on a
  filesystem path; use `path.relative`, `isAbsolute` and `basename` (URLs and
  ids are not paths). Containment is `path.relative` plus a first-segment `..`
  test, never a string prefix. Windows shows full paths, never `~`; expand `~`,
  `~/` and `~\` on input only. The full checklist (spawning, renames, signals,
  testing) is in the `hydra-acp/cli` AGENTS.md under "Treat every path as
  possibly Windows-shaped".
- **Windows spawn and URL rules** (`src/util/windows-command.ts`,
  `src/setup/run-hydra.ts`, `src/util/open-browser.ts`). Never spawn a bare
  npm-installed command on Windows; use `resolveSpawnTarget` (a copy of the
  CLI's, keep it in step) and handle the throw from `quoteForCmd`. Open URLs
  only through `open-browser.ts`, which uses `rundll32` on win32: `cmd /c start`
  truncates an OAuth URL at the first `&`.
- **The rule reloads on file save as well as on `SIGHUP`** (`util/watch.ts`,
  `reloadRule` in `index.ts`). `SIGHUP` cannot be sent on Windows, so the
  watcher is the only reload path there; it is non-persistent, so a test that
  waits on it must hold a live timer or node:test reports "cancelled".
  `SIGTERM` is a hard kill on Windows, so `shutdown()` must not be the only
  place that flushes state. `chmod 0o600` on the OAuth token and the archive
  key is a no-op on Windows.
- **Write-then-rename of archiver-owned files goes through `renameWithRetry`**
  (`util/rename-retry.ts`, async). A bare `fs.rename` fails with EPERM, EBUSY or
  EACCES on Windows when an antivirus scanner or indexer holds the destination.
- **Platform-dependent text and home handling take the platform as a parameter**
  (`setup/platform-text.ts`, `util/home.ts`: `confWrittenMessage`, `confLockNote`,
  `isTransientNpxPath`, `expandHome`, `collapseHome`) so the Windows branch is
  testable on Linux. Windows never gets a `~` display; expand `~`, `~/` and `~\`
  on input only.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.

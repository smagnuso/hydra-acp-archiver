# hydra-acp-archiver

Sync extension for [hydra-acp](https://github.com/smagnuso/hydra-acp). Keeps your agent sessions in sync across the machines you work on by uploading session bundles to a shared backend (Google Drive, S3, plain filesystem) after every turn and importing peers' bundles in the background. Supports optional AES-256-GCM encryption so data at rest is unreadable without your shared key.

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

Or from source:

```sh
git clone git@github.com:smagnuson/hydra-acp-archiver.git ~/dev/hydra-acp-archiver
cd ~/dev/hydra-acp-archiver
npm install
npm run build
```

## Setup

```sh
hydra-acp-archiver setup
```

The wizard walks you through picking a backend (Google Drive / S3 / Filesystem), configuring credentials, optionally generating an AES-256-GCM key for encryption, writing `~/.hydra-acp/archiver.conf`, and registering the archiver as a hydra extension. About 1 minute for S3/Filesystem; about 5–8 minutes for Google Drive (the GCP Console click-through is the long pole).

Re-run `hydra-acp-archiver setup` any time to switch backends or rotate keys — it preserves existing custom config keys.

<details>
<summary>Manual Google Drive setup (if you prefer not to run the wizard)</summary>

The Google Drive backend uses OAuth 2.0 with the **`drive.file`** scope — the archiver can only see files it creates plus those you explicitly hand it via a picker. Your other Drive contents stay invisible to it.

You provide your own OAuth client (Google's terms make it impractical to ship a shared one):

1. Go to <https://console.cloud.google.com/> and create or pick a project.
2. Enable the **Google Drive API** for that project.
3. Configure the **OAuth consent screen**. User type: **External**. Add your Google account under **Test Users**.
4. **Credentials → Create credentials → OAuth client ID**. Application type: **Desktop app**.
5. Download the resulting JSON and save it to `~/.hydra-acp/archiver-google-credentials.json` (or anywhere, and set `HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS`).
6. Run `hydra-acp-archiver gdrive login`. Your browser opens to Google's consent screen. The "Google hasn't verified this app" interstitial is expected for an unverified personal-use client — click **Advanced → Go to (unsafe)** and approve. The redirect lands on a transient local server, the archiver writes `~/.hydra-acp/archiver-google-token.json` (mode 0600), and you're done.
7. Register: `hydra-acp extensions add hydra-acp-archiver`.

After this, restart the daemon. The archiver process starts up, creates a `hydra-acp-archive/` folder in your Drive on first upload, and begins syncing.

</details>

<details>
<summary>Manual extension registration</summary>

If you skip the wizard's registration step, run:

```sh
hydra-acp extensions add hydra-acp-archiver
```

Or pointed at a local build:

```sh
hydra-acp extensions add hydra-acp-archiver \
  --command node \
  --args ~/dev/hydra-acp-archiver/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`. On `hydra-acp daemon start`, hydra spawns hydra-acp-archiver as a managed subprocess. Stdout/stderr land in `~/.hydra-acp/extensions/hydra-acp-archiver.log`.

</details>

## Multi-machine setup

Run `hydra-acp-archiver setup` on each machine that should sync. For Google Drive, log in with the **same Google account** and use the **same Drive folder name** so each machine points at the shared archive. For S3, point each machine at the same bucket. For filesystem, point each at a directory that some external sync tool (Syncthing, Dropbox, iCloud) mirrors.

If you turned on encryption, copy `~/.hydra-acp/archiver-key` from your first machine to each peer; the wizard's fingerprint output lets you verify they match.

## S3 backend

Works with any S3-compatible store: AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, etc.

Credentials come from the standard AWS SDK chain — environment variables (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`), `~/.aws/credentials`, or an IAM role. Set `AWS_PROFILE` to use a non-default credentials profile.

```json
{
  "extensions": {
    "hydra-acp-archiver": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-archiver/dist/index.js"],
      "env": {
        "HYDRA_ACP_ARCHIVER_BACKEND": "s3",
        "HYDRA_ACP_ARCHIVER_S3_BUCKET": "my-hydra-archive",
        "HYDRA_ACP_ARCHIVER_S3_REGION": "us-east-1"
      }
    }
  }
}
```

For S3-compatible endpoints (R2, MinIO, B2):

```json
"HYDRA_ACP_ARCHIVER_S3_ENDPOINT": "https://<accountid>.r2.cloudflarestorage.com"
```

**Multi-machine setup**: point every machine at the same bucket.

**Data separation**: the archiver sets a prefix automatically so users sharing a bucket don't see each other's sessions:
- **Encryption on**: prefix defaults to the key fingerprint (e.g. `a1b2c3d4e5f6a7b8/`). Everyone sharing the same key lands in the same namespace; different keys land in different namespaces. Rotating the key changes the prefix, causing a full re-upload with the new key.
- **Encryption off**: prefix defaults to your OS username (e.g. `alice/`).

Set `HYDRA_ACP_ARCHIVER_PREFIX` explicitly to override the default.

**Delete semantics**: blobs are hard-deleted. Enable [S3 bucket versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) if you want recoverability.

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

## Encryption

All three backends support optional AES-256-GCM encryption. When enabled, blobs are encrypted before upload and decrypted after download — the backend never sees plaintext.

Generate a key on one machine:

```sh
hydra-acp-archiver keygen
```

This writes a 32-byte key as a hex file (mode 0600) and prints:

```
key written to ~/.hydra-acp/archiver-key
key fingerprint: a1b2c3d4e5f6a7b8

Copy ~/.hydra-acp/archiver-key to every machine that should share this archive.
Then add to your extension env config:
  "HYDRA_ACP_ARCHIVER_KEY_PATH": "/home/you/.hydra-acp/archiver-key"
```

Copy the key file to each machine, then set `HYDRA_ACP_ARCHIVER_KEY_PATH` in every extension env block. The fingerprint lets you verify all machines have the same key.

**Key mismatch**: if a blob was encrypted with a different key, the archiver logs `key mismatch` and skips that blob rather than failing with a confusing crypto error.

**Enabling encryption on an existing archive**: the key fingerprint becomes the new prefix, so old unencrypted blobs (written under a different prefix) are simply ignored — no decryption errors. The cold sweep re-uploads all sessions under the new prefix. To clean up old blobs, remove them from the backend manually.

## Prefix and namespace isolation

Every backend supports an optional namespace prefix. The archiver sets one automatically so multiple users sharing the same storage container don't interfere with each other.

### How the prefix is chosen

1. **`HYDRA_ACP_ARCHIVER_PREFIX` is set** — that value is used verbatim. Set it to `""` to disable the prefix entirely (not recommended on shared storage).
2. **Encryption is on, no explicit prefix** — the key fingerprint (first 8 bytes of SHA-256 of the key, encoded as 16 hex chars followed by `/`) is used, e.g. `a1b2c3d4e5f6a7b8/`. Everyone sharing the same key lands in the same namespace; different keys land in different namespaces. Rotating the key changes the prefix, which isolates new blobs from old ones.
3. **Encryption off, no explicit prefix** — the OS username (sanitized to lowercase alphanumeric + hyphens, followed by `/`) is used, e.g. `alice/`.

### Host segregation

Within the user prefix, each machine writes to its own subdirectory named by its host ID. The full storage path is `<user-prefix><hostId>/<lineageId>.hydra.archive`. For example:

```
a1b2c3d4e5f6a7b8/
  alice-macbook/uuid1.hydra.archive
  alice-macbook/uuid2.hydra.archive
  alice-desktop/uuid3.hydra.archive
```

The pull loop reads across all host subdirectories (seeing all peers' sessions) but skips its own host's files entirely — cheaper than parsing envelopes for self-loop detection. The session-ID check remains as a second layer for edge cases.

Set `HYDRA_ACP_ARCHIVER_HOST_ID` to override the default (`os.hostname()` sanitized). Useful in containers or after a machine rename. Use the same value consistently across daemon restarts on a machine — changing it creates a new subdirectory and triggers a full re-upload.

### What the prefix does per backend

| Backend | Prefix behaviour |
|---|---|
| **S3** | Prepended to the S3 object key. `ListObjectsV2` is called with the `Prefix` parameter so only matching objects are fetched — efficient on large shared buckets. |
| **fs** | Resolved as a subdirectory of the archive directory. Files land at `<dir>/<prefix>/<key>`. Each prefix gets its own isolated directory. |
| **Google Drive** | Prepended to the Drive filename. Drive has no native directory structure within a folder, so `alice/uuid.hydra.archive` is literally the filename. `list()` filters client-side. |

### Key rotation and re-upload

When encryption is enabled and you regenerate the key (`hydra-acp-archiver keygen`), the fingerprint prefix changes. The new prefix namespace is empty, so the cold sweep on the next daemon start re-uploads all sessions encrypted with the new key. Old blobs under the previous prefix are simply ignored — no decryption errors, no manual cleanup required (though you can delete the old prefix from the bucket/dir when convenient).

## Configuration file

Instead of setting environment variables in `config.json`, you can use a plain-text config file at `~/.hydra-acp/archiver.conf` (override with `HYDRA_ACP_ARCHIVER_CONF`). Environment variables always take precedence over file values.

```sh
# ~/.hydra-acp/archiver.conf
# All keys are optional — omit any you don't need.
# Env vars override these values when both are set.

BACKEND=s3

# S3
S3_BUCKET=my-hydra-archive
S3_REGION=us-east-1
# S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com

# Encryption
KEY_PATH=/home/you/.hydra-acp/archiver-key

# Identity
HOST_ID=alice-macbook

# Google Drive
# GOOGLE_CREDENTIALS=/home/you/.hydra-acp/archiver-google-credentials.json
# DRIVE_FOLDER=hydra-acp-archive

# Tuning (rarely needed)
# DEBOUNCE_MS=5000
# PULL_MS=60000
# DEBUG=false
```

Restrict permissions on the file if it contains sensitive paths: `chmod 600 ~/.hydra-acp/archiver.conf`.

The file is optional — if it doesn't exist the archiver falls back to environment variables only.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `HYDRA_ACP_ARCHIVER_CONF` | `~/.hydra-acp/archiver.conf` | Path to the config file |
| `HYDRA_ACP_ARCHIVER_BACKEND` | `google-drive` | `google-drive` \| `fs` \| `s3` |
| `HYDRA_ACP_ARCHIVER_DRIVE_FOLDER` | `hydra-acp-archive` | Drive folder name |
| `HYDRA_ACP_ARCHIVER_FS_DIR` | `~/.hydra-acp/archive` | Used when backend is `fs` |
| `HYDRA_ACP_ARCHIVER_S3_BUCKET` | — | Bucket name (required for `s3`) |
| `HYDRA_ACP_ARCHIVER_S3_REGION` | AWS SDK default | AWS region |
| `HYDRA_ACP_ARCHIVER_S3_ENDPOINT` | — | Custom endpoint for R2/MinIO/B2 |
| `HYDRA_ACP_ARCHIVER_PREFIX` | auto (fingerprint or username) | User-level namespace prefix applied by all backends |
| `HYDRA_ACP_ARCHIVER_HOST_ID` | `os.hostname()` (sanitized) | Host identifier used as a subdirectory under the user prefix |
| `HYDRA_ACP_ARCHIVER_KEY_PATH` | — | Path to encryption key file; if unset, encryption is off |
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
- `~/.hydra-acp/archiver-key` — encryption key (mode 0600), written by `hydra-acp-archiver keygen`. Copy this file to every machine in your sync group. Keep it safe — losing it means losing access to encrypted blobs.

## Troubleshooting

- **`Missing HYDRA_ACP_TOKEN env var`** — you ran the archiver directly instead of via the daemon. Run it as a registered extension.
- **`No Google OAuth token at …`** — run `hydra-acp-archiver gdrive login` first.
- **`OAuth credentials file not found`** — follow the **First-time Google setup** steps to download the client JSON from GCP Console.
- **Files aren't appearing in Drive** — check `~/.hydra-acp/extensions/hydra-acp-archiver.log` for errors. Common: consent-screen test-user list doesn't include your Google account.
- **Two machines kept overwriting each other** — that's last-writer-wins working as designed if both are actively editing the same session. Avoid editing the same session on two machines simultaneously; one of them will lose its diff. A future `activeOn` claim-lock will close this gap.

## Backends

Current: `google-drive`, `fs`, `s3`. Adding a new one means implementing the `SyncBackend` interface in `src/backend/types.ts` and wiring it into `src/backend/factory.ts`. Encryption is handled by the `EncryptedBackend` wrapper in `src/backend/encrypted.ts` — new backends get it for free.

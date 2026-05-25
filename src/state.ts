import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./util/log.js";

const log = logger("state");

export interface LineageState {
  lastUploadedHash?: string;
  lastUploadedAt?: string;
  lastSeenRemoteUploadedAt?: string;
  lastSeenRemoteBy?: string;
  // Session ID assigned by the daemon when we imported this lineage from a peer.
  // Cleared when that session is deleted, triggering an automatic re-import.
  importedSessionId?: string;
}

interface StateFile {
  // App version string from package.json. Pull state is reset whenever
  // this changes so every upgrade starts with a clean import slate.
  // Upload hashes are always preserved across upgrades.
  appVersion: string;
  prefix: string;
  backend: string;
  lineages: Record<string, LineageState>;
}

function emptyState(appVersion: string, prefix: string, backend: string): StateFile {
  return { appVersion, prefix, backend, lineages: {} };
}

// All writes go through a single in-process queue so concurrent
// setLineageState calls don't interleave their read-modify-write cycles
// and lose updates. Cross-process safety is out of scope — only one
// archiver runs per hydra daemon.
export class SyncState {
  private cache: StateFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(appVersion: string, prefix: string, backend: string): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as StateFile;
      if (!parsed.lineages) {
        log.warn(`state file at ${this.path} had unexpected shape; ignoring`);
        this.cache = emptyState(appVersion, prefix, backend);
        return;
      }
      const storedVersion = parsed.appVersion;
      const storedPrefix = parsed.prefix;
      const storedBackend = parsed.backend;
      this.cache = parsed;
      this.cache.appVersion = appVersion;
      this.cache.prefix = prefix;
      this.cache.backend = backend;

      const versionChanged = storedVersion !== appVersion;
      const namespaceChanged = storedPrefix !== prefix || storedBackend !== backend;

      if (versionChanged || namespaceChanged) {
        if (versionChanged) {
          log.info(
            `version changed (${storedVersion ?? "?"} → ${appVersion}); resetting pull state`,
          );
        }
        if (namespaceChanged) {
          log.info(
            `namespace changed (${storedBackend ?? "?"}:${storedPrefix ?? "none"} → ${backend}:${prefix}); resetting pull state`,
          );
        }
        for (const entry of Object.values(this.cache.lineages)) {
          delete entry.lastSeenRemoteUploadedAt;
          delete entry.lastSeenRemoteBy;
          delete entry.importedSessionId;
        }
        await this.flush();
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        this.cache = emptyState(appVersion, prefix, backend);
        return;
      }
      log.warn(`failed to read ${this.path}: ${e.message}; starting fresh`);
      this.cache = emptyState(appVersion, prefix, backend);
    }
  }

  get(lineageId: string): LineageState {
    if (!this.cache) {
      throw new Error("SyncState.get called before load()");
    }
    return this.cache.lineages[lineageId] ?? {};
  }

  set(lineageId: string, patch: LineageState): Promise<void> {
    if (!this.cache) {
      throw new Error("SyncState.set called before load()");
    }
    const prev = this.cache.lineages[lineageId] ?? {};
    this.cache.lineages[lineageId] = { ...prev, ...patch };
    return this.flush();
  }

  lineageIds(): string[] {
    if (!this.cache)
      throw new Error("SyncState.lineageIds called before load()");
    return Object.keys(this.cache.lineages);
  }

  // Clear pull-side state for a lineage whose imported session was deleted,
  // so the pull loop will treat the next peer envelope as unseen.
  async resetImport(lineageId: string): Promise<void> {
    if (!this.cache)
      throw new Error("SyncState.resetImport called before load()");
    const entry = this.cache.lineages[lineageId];
    if (!entry) return;
    delete entry.lastSeenRemoteUploadedAt;
    delete entry.lastSeenRemoteBy;
    delete entry.importedSessionId;
    return this.flush();
  }

  // Drop any lineage entry whose key isn't present on the backend.
  // Called once at startup so that a wiped backend (Drive nuke, retention
  // delete, etc.) doesn't leave us with stale "I already uploaded" beliefs
  // — the next flush re-uploads from scratch. State stays a hint cache;
  // the backend stays the source of truth.
  async reconcile(presentLineageIds: Set<string>): Promise<number> {
    if (!this.cache) {
      throw new Error("SyncState.reconcile called before load()");
    }
    let pruned = 0;
    for (const id of Object.keys(this.cache.lineages)) {
      if (!presentLineageIds.has(id)) {
        delete this.cache.lineages[id];
        pruned += 1;
      }
    }
    if (pruned > 0) {
      await this.flush();
    }
    return pruned;
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.cache, null, 2);
    const next = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writeChain = next.catch((err: unknown) => {
      log.warn(`failed to persist ${this.path}: ${(err as Error).message}`);
    });
    return next;
  }
}

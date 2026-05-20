import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./util/log.js";

const log = logger("state");

export interface LineageState {
  lastUploadedHash?: string;
  lastUploadedAt?: string;
  lastSeenRemoteUploadedAt?: string;
  lastSeenRemoteBy?: string;
}

interface StateFile {
  version: 1;
  lineages: Record<string, LineageState>;
}

function emptyState(): StateFile {
  return { version: 1, lineages: {} };
}

// All writes go through a single in-process queue so concurrent
// setLineageState calls don't interleave their read-modify-write cycles
// and lose updates. Cross-process safety is out of scope — only one
// archiver runs per hydra daemon.
export class SyncState {
  private cache: StateFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as StateFile;
      if (parsed.version !== 1 || !parsed.lineages) {
        log.warn(`state file at ${this.path} had unexpected shape; ignoring`);
        this.cache = emptyState();
        return;
      }
      this.cache = parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        this.cache = emptyState();
        return;
      }
      log.warn(`failed to read ${this.path}: ${e.message}; starting fresh`);
      this.cache = emptyState();
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

import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "../util/log.js";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const log = logger("backend.fs");

export interface FsBackendOptions {
  dir: string;
}

// Filesystem-backed implementation. Useful for tests, for users who want
// to point a folder-sync tool (Syncthing, Dropbox) at the archive
// directory, and for development against a local daemon.
export class FsBackend implements SyncBackend {
  constructor(private readonly opts: FsBackendOptions) {}

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    log.info(`fs backend ready at ${this.opts.dir}`);
  }

  async list(): Promise<SyncBackendEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.opts.dir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: SyncBackendEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".") || name.endsWith(".tmp")) {
        continue;
      }
      const full = resolve(this.opts.dir, name);
      try {
        const s = await stat(full);
        if (!s.isFile()) {
          continue;
        }
        out.push({
          key: name,
          size: s.size,
          modifiedAt: s.mtime.toISOString(),
        });
      } catch (err) {
        log.debug(`stat ${full}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolve(this.opts.dir, key));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const dest = resolve(this.opts.dir, key);
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, dest);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolve(this.opts.dir, key));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

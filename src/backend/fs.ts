import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { logger } from "../util/log.js";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const log = logger("backend.fs");

export interface FsBackendOptions {
  dir: string;
  prefix: string;
}

// Filesystem-backed implementation. Useful for tests, for users who want
// to point a folder-sync tool (Syncthing, Dropbox) at the archive
// directory, and for development against a local daemon.
export class FsBackend implements SyncBackend {
  private readonly root: string;

  constructor(private readonly opts: FsBackendOptions) {
    this.root = opts.prefix !== "" ? resolve(opts.dir, opts.prefix) : opts.dir;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    log.info(`fs backend ready at ${this.root}`);
  }

  async list(): Promise<SyncBackendEntry[]> {
    return this.walk(this.root, "");
  }

  private async walk(dir: string, rel: string): Promise<SyncBackendEntry[]> {
    let names: string[];
    try {
      names = await readdir(dir);
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
      const full = resolve(dir, name);
      const entryRel = rel !== "" ? `${rel}/${name}` : name;
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          out.push(...await this.walk(full, entryRel));
        } else if (s.isFile()) {
          out.push({ key: entryRel, size: s.size, modifiedAt: s.mtime.toISOString() });
        }
      } catch (err) {
        log.debug(`stat ${full}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(resolve(this.root, key));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const dest = resolve(this.root, key);
    const tmp = `${dest}.tmp`;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, dest);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolve(this.root, key));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

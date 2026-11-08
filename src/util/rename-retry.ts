import { rename as fsRename, unlink as fsUnlink } from "node:fs/promises";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 20;

export interface RenameRetryDeps {
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Windows refuses to rename over a file another process holds open; retry briefly.
export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameRetryDeps = {},
): Promise<void> {
  const rename = deps.rename ?? fsRename;
  const sleep = deps.sleep ?? sleepMs;
  const unlink = deps.unlink ?? fsUnlink;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) {
        try {
          await unlink(from);
        } catch {
          // tmp may already be gone
        }
        throw err;
      }
      await sleep(BASE_DELAY_MS * attempt);
    }
  }
}

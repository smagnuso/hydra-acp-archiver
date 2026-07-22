import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { logger } from "./util/log.js";

const log = logger("local-index");

export interface LocalSessionMeta {
  sessionId: string;
  lineageId: string;
  upstreamSessionId?: string;
  agentId?: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

// Scan `<hydraHome>/sessions/hydra_session_*/meta.json` and build a
// map keyed by lineageId. Kept in-process; call once per command.
// Non-fatal: individual read failures are logged and skipped so a
// half-written meta doesn't take out the whole listing.
export async function loadLocalIndex(
  hydraHome: string,
): Promise<Map<string, LocalSessionMeta>> {
  const out = new Map<string, LocalSessionMeta>();
  const dir = resolve(hydraHome, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    log.warn(`local-index: cannot read ${dir}: ${(err as Error).message}`);
    return out;
  }
  await Promise.all(
    names.map(async (name) => {
      if (!name.startsWith("hydra_session_")) return;
      const metaPath = resolve(dir, name, "meta.json");
      try {
        const text = await readFile(metaPath, "utf8");
        const meta = JSON.parse(text) as Partial<LocalSessionMeta>;
        if (typeof meta.sessionId !== "string" || typeof meta.lineageId !== "string") return;
        out.set(meta.lineageId, {
          sessionId: meta.sessionId,
          lineageId: meta.lineageId,
          upstreamSessionId: typeof meta.upstreamSessionId === "string" ? meta.upstreamSessionId : undefined,
          agentId: typeof meta.agentId === "string" ? meta.agentId : undefined,
          cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
          title: typeof meta.title === "string" ? meta.title : undefined,
          updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") {
          log.warn(`local-index: ${metaPath}: ${e.message}`);
        }
      }
    }),
  );
  return out;
}

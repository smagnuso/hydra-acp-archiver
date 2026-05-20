import type { ArchiveLoop } from "./archive-loop.js";
import type { HydraSessionInfo } from "./discovery.js";
import { logger } from "./util/log.js";

const log = logger("cold-sweep");

export interface ColdSweepOptions {
  daemonUrl: string;
  token: string;
  archive: ArchiveLoop;
}

// One-shot scan of every session the daemon knows about, exporting any
// cold ones. Live sessions are skipped here — they're handled by the
// per-session bridge once discovery sees them. The archive loop's
// hash-dedup ensures cold sessions that haven't changed since their
// last upload are no-ops on the backend.
//
// Runs sequentially to avoid hammering the daemon and the backend
// (especially Drive, which rate-limits). Errors on individual sessions
// are logged and skipped — partial progress is preferable to bailing.
export async function runColdSweep(
  opts: ColdSweepOptions,
): Promise<{ scanned: number; cold: number }> {
  const sessions = await listSessions(opts.daemonUrl, opts.token);
  let cold = 0;
  for (const s of sessions) {
    if (s.status === "live") {
      continue;
    }
    cold += 1;
    opts.archive.setMeta(s.sessionId, {
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
      ...(s.title !== undefined ? { title: s.title } : {}),
    });
    try {
      await opts.archive.flushNow(s.sessionId);
    } catch (err) {
      log.warn(
        `cold sweep flush ${s.sessionId} failed: ${(err as Error).message}`,
      );
    }
  }
  log.info(`cold sweep done: scanned=${sessions.length} cold=${cold}`);
  return { scanned: sessions.length, cold };
}

async function listSessions(
  daemonUrl: string,
  token: string,
): Promise<HydraSessionInfo[]> {
  const r = await fetch(`${daemonUrl}/v1/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    throw new Error(`daemon /v1/sessions returned ${r.status}`);
  }
  const body = (await r.json()) as { sessions: HydraSessionInfo[] };
  return body.sessions;
}

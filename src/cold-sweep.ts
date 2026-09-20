import type { ArchiveLoop } from "./archive-loop.js";
import type { HydraSessionInfo } from "./discovery.js";
import type { SyncState } from "./state.js";
import { logger } from "./util/log.js";

const log = logger("cold-sweep");

export interface ColdSweepOptions {
  daemonUrl: string;
  token: string;
  archive: ArchiveLoop;
  state: SyncState;
}

export interface ColdSweepLoopOptions extends ColdSweepOptions {
  intervalMs: number;
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
): Promise<{ scanned: number; cold: number; skippedMirrors: number }> {
  const sessions = await listSessions(opts.daemonUrl, opts.token);
  let cold = 0;
  let skippedMirrors = 0;
  for (const s of sessions) {
    if (s.status === "warm") {
      continue;
    }
    // Passive mirror: imported from a peer, never opened locally. No
    // upstreamSessionId means no local agent has bound it, so this
    // machine has nothing to contribute. Re-exporting would just
    // ping-pong the bundle back to the peer.
    if (s.importedFromMachine && !s.upstreamSessionId) {
      skippedMirrors += 1;
      continue;
    }
    // Fast path: the daemon bumps updatedAt on every mutation (priority
    // PATCH included), so a session whose updatedAt we already swept is
    // byte-identical to the last export — skip re-exporting it entirely.
    // Unchanged content would hash-identical anyway; this just avoids the
    // export+serialize round-trip for the (thousands of) untouched cold
    // sessions. Sessions without an updatedAt (older daemons) are never
    // skipped, degrading to always-export.
    const lastSeen = opts.state.getSweepSeen(s.sessionId);
    if (
      s.updatedAt !== undefined &&
      lastSeen !== undefined &&
      s.updatedAt <= lastSeen
    ) {
      continue;
    }
    cold += 1;
    opts.archive.setMeta(s.sessionId, {
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      ...(s.agentId !== undefined ? { agentId: s.agentId } : {}),
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.interactive !== undefined ? { interactive: s.interactive } : {}),
    });
    try {
      await opts.archive.flushNow(s.sessionId);
      // Only advance the bookmark after the export succeeded, so a
      // session that fails this tick is retried on the next one.
      if (s.updatedAt !== undefined) {
        await opts.state.setSweepSeen(s.sessionId, s.updatedAt);
      }
    } catch (err) {
      log.warn(
        `cold sweep flush ${s.sessionId} failed: ${(err as Error).message}`,
      );
    }
  }
  log.info(
    `cold sweep done: scanned=${sessions.length} cold=${cold} skipped-mirrors=${skippedMirrors}`,
  );
  return { scanned: sessions.length, cold, skippedMirrors };
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

// Runs the initial cold sweep immediately (backgrounded, matching the old
// one-shot behavior) and then re-scans every intervalMs. This is what
// propagates metadata-only changes (priority, title) on cold sessions:
// the daemon broadcasts nothing for a priority PATCH, so without this
// re-scan a cleared/raised pin would never re-export. Each tick skips
// untouched cold sessions via the updatedAt bookmark in state.json, so
// the steady-state cost is one list call plus an export per actually-
// changed session — not a backend write to every cold session. The timer
// is .unref()ed — a pending sweep must not keep the process alive.
export function startColdSweepLoop(opts: ColdSweepLoopOptions): () => void {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    void runSweep();
  }, opts.intervalMs);
  timer.unref();
  void runSweep();
  return () => {
    stopped = true;
    clearInterval(timer);
  };

  async function runSweep(): Promise<void> {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await runColdSweep(opts);
    } catch (err) {
      log.warn(`cold sweep failed: ${(err as Error).message}`);
    } finally {
      inFlight = false;
    }
  }
}

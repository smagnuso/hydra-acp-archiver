import { hostname, userInfo } from "node:os";
import type { SyncBackend } from "./backend/types.js";
import type { DaemonClient } from "./daemon.js";
import {
  hashBundle,
  keyFor,
  serialize,
  wrap,
  type HostInfo,
} from "./envelope.js";
import type { RuleFunction } from "./rule.js";
import type { SyncState } from "./state.js";
import { logger } from "./util/log.js";

const log = logger("archive");

export interface ArchiveLoopOptions {
  daemon: DaemonClient;
  backend: SyncBackend;
  state: SyncState;
  getRule: () => RuleFunction;
  debounceMs: number;
  host?: HostInfo;
}

// Per-session debounce: every markDirty resets the timer; when it
// finally fires we do one export + one upload covering all the bursts
// that landed inside the window.
interface PendingFlush {
  timer: NodeJS.Timeout;
}

export class ArchiveLoop {
  private readonly host: HostInfo;
  private readonly pending = new Map<string, PendingFlush>();
  // Tracks sessionId -> meta we know about (just cwd/title/agentId for
  // now), so the rule fn has something to decide on.
  private readonly meta = new Map<string, SessionMeta>();
  private stopped = false;

  constructor(private readonly opts: ArchiveLoopOptions) {
    this.host = opts.host ?? defaultHost();
  }

  setMeta(sessionId: string, meta: SessionMeta): void {
    this.meta.set(sessionId, meta);
  }

  forgetSession(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(sessionId);
    }
    this.meta.delete(sessionId);
  }

  // Cancel any pending debounced upload and synchronously run one final
  // flush — used when a session transitions live → cold so we capture
  // its last state. Errors are logged, not thrown, so callers can
  // fire-and-forget. The session's meta is dropped after the flush
  // resolves.
  async finalFlush(sessionId: string): Promise<void> {
    const existing = this.pending.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(sessionId);
    }
    try {
      await this.flush(sessionId);
    } catch (err) {
      log.warn(
        `final flush ${sessionId} failed: ${(err as Error).message}`,
      );
    }
    this.meta.delete(sessionId);
  }

  markDirty(sessionId: string): void {
    if (this.stopped) {
      return;
    }
    const existing = this.pending.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.flush(sessionId).catch((err: unknown) => {
        log.warn(
          `flush ${sessionId} failed: ${(err as Error).message}`,
        );
      });
    }, this.opts.debounceMs);
    timer.unref();
    this.pending.set(sessionId, { timer });
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
  }

  // flushNow is exposed for tests so they don't have to wait out the
  // debounce window. Production code goes through markDirty.
  async flushNow(sessionId: string): Promise<void> {
    const existing = this.pending.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(sessionId);
    }
    await this.flush(sessionId);
  }

  private async flush(sessionId: string): Promise<void> {
    const bundle = await this.opts.daemon.exportSession(sessionId);
    const lineageId = bundle.session.lineageId;
    if (!lineageId) {
      log.warn(`session ${sessionId} export had no lineageId; skipping`);
      return;
    }
    const meta = this.meta.get(sessionId);
    const rule = this.opts.getRule();
    const shouldArchive = await runRule(rule, {
      sessionId,
      lineageId,
      meta: meta ?? {},
    });
    if (!shouldArchive) {
      log.debug(`rule skipped session ${sessionId} (lineage ${lineageId})`);
      return;
    }
    const newHash = hashBundle(bundle);
    const prev = this.opts.state.get(lineageId);
    if (prev.lastUploadedHash === newHash) {
      log.debug(
        `unchanged content for lineage ${lineageId} — skip upload`,
      );
      return;
    }
    const envelope = wrap(bundle, lineageId, this.host);
    await this.opts.backend.put(keyFor(lineageId), serialize(envelope));
    await this.opts.state.set(lineageId, {
      lastUploadedHash: newHash,
      lastUploadedAt: envelope.uploadedAt,
    });
    log.info(
      `uploaded lineage=${lineageId} session=${sessionId} hash=${newHash.slice(0, 22)}…`,
    );
  }
}

async function runRule(
  rule: RuleFunction,
  ev: { sessionId: string; lineageId: string; meta: SessionMeta },
): Promise<boolean> {
  try {
    const r = await rule(ev);
    return r !== false;
  } catch (err) {
    log.warn(`rule threw for ${ev.sessionId}: ${(err as Error).message}; defaulting to archive`);
    return true;
  }
}

export interface SessionMeta {
  cwd?: string;
  agentId?: string;
  title?: string;
}

function defaultHost(): HostInfo {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    // happens in some sandboxes; fall through
  }
  return { host: hostname(), user };
}

import { logger } from "./util/log.js";

const log = logger("discovery");

export interface HydraSessionInfo {
  sessionId: string;
  cwd: string;
  agentId: string | undefined;
  title: string | undefined;
  attachedClients: number;
  updatedAt: string;
  status: "warm" | "cold";
  // Tri-state from the daemon's session/list response. Reflects the
  // derived effectiveInteractive() value at list time:
  //   true       — explicitly interactive, or undefined+hasContent
  //   false      — explicit (cat one-shots, transformer-spawned children)
  //   undefined  — never set and no history content yet
  // The archiver only uploads sessions that are explicitly interactive.
  interactive?: boolean;
  // Provenance. When importedFromMachine is set and upstreamSessionId is
  // empty the session is a passive mirror — pulled from a peer, never
  // opened locally. Re-uploading it would ping-pong, so the cold sweep
  // and any future export paths must skip it.
  importedFromMachine?: string;
  upstreamSessionId?: string;
}

export interface HydraDiscoveryOptions {
  daemonUrl: string;
  token: string;
  pollIntervalMs?: number;
  onAdd: (session: HydraSessionInfo) => void;
  onRemove: (sessionId: string) => void;
}

const DEFAULT_POLL_MS = 2_000;

export class HydraDiscovery {
  private timer: NodeJS.Timeout | undefined;
  private known = new Map<string, HydraSessionInfo>();
  private stopped = false;
  private inFlight = false;

  constructor(private readonly opts: HydraDiscoveryOptions) {}

  start(): void {
    log.info(
      `polling ${this.opts.daemonUrl}/v1/sessions every ${this.opts.pollIntervalMs ?? DEFAULT_POLL_MS}ms`,
    );
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const r = await fetch(`${this.opts.daemonUrl}/v1/sessions?status=warm`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!r.ok) {
        log.warn(`daemon /v1/sessions returned ${r.status}`);
        return;
      }
      const body = (await r.json()) as { sessions: HydraSessionInfo[] };
      // `status=warm`: only LIVE sessions, answered from the daemon's
      // in-memory map without reading the session store. This poll runs
      // every couple of seconds forever, and the unfiltered view costs the
      // daemon ~127ms of CPU and half a megabyte per uncached call once an
      // install has a thousand cold records — all to produce rows discarded
      // immediately below.
      //
      // NOT the same call as DaemonClient.listSessionIds, which needs the
      // full list (it detects deletions by absence, so a warm-only view
      // would look like every cold session had vanished).
      //
      // The status check stays as a belt: a daemon predating the parameter
      // ignores it and returns everything.
      const seen = new Map<string, HydraSessionInfo>();
      for (const s of body.sessions) {
        if (s.status !== "warm") {
          continue;
        }
        seen.set(s.sessionId, s);
      }
      for (const [id, s] of seen) {
        if (!this.known.has(id)) {
          this.known.set(id, s);
          try {
            this.opts.onAdd(s);
          } catch (err) {
            log.warn(`onAdd error for ${id}: ${(err as Error).message}`);
          }
        } else {
          this.known.set(id, s);
        }
      }
      for (const id of [...this.known.keys()]) {
        if (!seen.has(id)) {
          this.known.delete(id);
          try {
            this.opts.onRemove(id);
          } catch (err) {
            log.warn(`onRemove error for ${id}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      log.debug(`poll error: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }
}

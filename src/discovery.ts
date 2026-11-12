import { logger } from "./util/log.js";
import { runSessionStream, type SessionFrame } from "./session-stream.js";

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

// With the stream up, the poll only backstops it: one in this many ticks.
const STREAM_BACKSTOP_TICKS = 15;

export class HydraDiscovery {
  private timer: NodeJS.Timeout | undefined;
  private known = new Map<string, HydraSessionInfo>();
  private stopped = false;
  private inFlight = false;
  private streamAbort: AbortController | undefined;
  private streamHealthy = false;
  private backstopTicks = 0;
  // Counts frames applied, so a poll that was in flight while one landed can
  // tell its answer is older than what the frame already told us.
  private frameCount = 0;
  // Set when the stream drops: the first frame after it also triggers a full
  // poll, since a departure during the gap was never announced.
  private needResync = false;

  constructor(private readonly opts: HydraDiscoveryOptions) {}

  start(): void {
    log.info(
      `polling ${this.opts.daemonUrl}/v1/sessions every ${this.opts.pollIntervalMs ?? DEFAULT_POLL_MS}ms`,
    );
    void this.poll();
    this.timer = setInterval(() => {
      if (
        this.streamHealthy &&
        ++this.backstopTicks % STREAM_BACKSTOP_TICKS !== 0
      ) {
        return;
      }
      void this.poll();
    }, this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.startStream();
  }

  // Pushes from the daemon's warm-session stream. An older daemon has none,
  // and then the poll above does all the work, as before.
  private startStream(): void {
    const abort = new AbortController();
    this.streamAbort = abort;
    void runSessionStream<HydraSessionInfo>({
      open: (_since, signal) =>
        fetch(`${this.opts.daemonUrl}/v1/sessions/stream?status=warm`, {
          headers: { Authorization: `Bearer ${this.opts.token}` },
          signal,
        }),
      signal: abort.signal,
      onFrame: (frame) => {
        this.streamHealthy = true;
        this.applyFrame(frame);
        if (this.needResync) {
          this.needResync = false;
          void this.poll();
        }
      },
      onDisconnect: () => {
        this.streamHealthy = false;
        this.needResync = true;
      },
    }).then((outcome) => {
      if (outcome === "unsupported") {
        this.streamHealthy = false;
      }
    });
  }

  // A frame is a delta: rows replace by id and `removed` drops. It says
  // nothing about the rows it leaves out, so nothing is removed by omission.
  private applyFrame(frame: SessionFrame<HydraSessionInfo>): void {
    if (this.stopped) {
      return;
    }
    this.frameCount++;
    for (const s of frame.sessions) {
      if (s.status !== "warm") {
        this.dropKnown(s.sessionId);
        continue;
      }
      const isNew = !this.known.has(s.sessionId);
      this.known.set(s.sessionId, s);
      if (isNew) {
        try {
          this.opts.onAdd(s);
        } catch (err) {
          log.warn(`onAdd error for ${s.sessionId}: ${(err as Error).message}`);
        }
      }
    }
    for (const id of frame.removed) {
      this.dropKnown(id);
    }
  }

  private dropKnown(id: string): void {
    if (!this.known.delete(id)) {
      return;
    }
    try {
      this.opts.onRemove(id);
    } catch (err) {
      log.warn(`onRemove error for ${id}: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.streamAbort?.abort();
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
    const framesAtStart = this.frameCount;
    try {
      const r = await fetch(`${this.opts.daemonUrl}/v1/sessions?status=warm`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!r.ok) {
        log.warn(`daemon /v1/sessions returned ${r.status}`);
        return;
      }
      const body = (await r.json()) as { sessions: HydraSessionInfo[] };
      // A frame landed while this was in flight, so this answer may be older
      // than what it already told us; the next poll will correct anything.
      if (this.frameCount !== framesAtStart) {
        return;
      }
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

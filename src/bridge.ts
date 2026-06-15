import { AcpAttach } from "./acp/attach.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
} from "./acp/protocol.js";
import type { ArchiveLoop, SessionMeta } from "./archive-loop.js";
import { logger } from "./util/log.js";

const log = logger("bridge");

export interface BridgeOptions {
  daemonWsUrl: string;
  token: string;
  sessionId: string;
  meta: SessionMeta;
  archive: ArchiveLoop;
}

// One bridge per discovered session. Listens to session/update for
// turn_complete and tells the archive loop to schedule an upload.
// session_info_update keeps the cached meta fresh so any rule logic
// that reads title/agentId sees the latest values.
export class ArchiverBridge {
  private readonly attach: AcpAttach;
  private meta: SessionMeta;
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.meta = opts.meta;
    this.attach = new AcpAttach({
      sessionId: opts.sessionId,
      daemonWsUrl: opts.daemonWsUrl,
      token: opts.token,
    });
    this.opts.archive.setMeta(opts.sessionId, this.meta);
  }

  start(): void {
    this.attach.on("notification", (n) => this.onNotification(n));
    this.attach.on("request", (r) => this.onRequest(r));
    this.attach.on("error", (err) => {
      log.warn(`attach error ${this.opts.sessionId}: ${err.message}`);
    });
    this.attach.start();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    // Fire-and-forget a final flush so any pending debounced upload
    // lands before we drop the session. The finalFlush method swallows
    // errors and clears the timer + meta itself.
    void this.opts.archive.finalFlush(this.opts.sessionId);
    this.attach.stop();
  }

  updateMeta(meta: SessionMeta): void {
    this.meta = meta;
    this.opts.archive.setMeta(this.opts.sessionId, meta);
  }

  private onNotification(n: JsonRpcNotification): void {
    if (n.method !== "session/update") {
      return;
    }
    const params = (n.params ?? {}) as Record<string, unknown>;
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (kind === "session_info_update") {
      this.applySessionInfoUpdate(update);
    }

    // turn_complete is the primary upload trigger. Any other kind of
    // session/update is ignored — we don't want to upload after every
    // tool call notification, just after a turn finishes.
    if (kind === "turn_complete") {
      this.opts.archive.markDirty(this.opts.sessionId);
    }
  }

  private applySessionInfoUpdate(update: Record<string, unknown>): void {
    const next: SessionMeta = { ...this.meta };
    let changed = false;
    if (typeof update.title === "string" && next.title !== update.title) {
      next.title = update.title;
      changed = true;
    }
    const hydra = readHydraMeta(update._meta);
    const agentId = typeof hydra?.agentId === "string" ? hydra.agentId : undefined;
    if (agentId !== undefined && next.agentId !== agentId) {
      next.agentId = agentId;
      changed = true;
    }
    const interactive =
      typeof hydra?.interactive === "boolean" ? hydra.interactive : undefined;
    if (interactive !== undefined && next.interactive !== interactive) {
      next.interactive = interactive;
      changed = true;
    }
    if (changed) {
      this.updateMeta(next);
    }
  }

  private onRequest(r: JsonRpcRequest): void {
    // The hydra-acp daemon broadcasts agent→client requests to every
    // attached client and resolves the original on the first response
    // (first-responder-wins). A passive observer like the archiver
    // MUST stay silent on methods it doesn't intend to answer —
    // replying -32601 would race the real client and make permission
    // prompts / fs reads etc. resolve to an error. Just log and drop.
    log.debug(`ignoring inbound request ${r.method} id=${String(r.id)}`);
  }
}

function readHydraMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const ns = (meta as Record<string, unknown>)["hydra-acp"];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return undefined;
  }
  return ns as Record<string, unknown>;
}

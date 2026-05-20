// REST helpers for the small subset of the hydra-acp daemon API the
// archiver uses. The daemon's WebSocket surface is handled in src/acp/.
import { logger } from "./util/log.js";

const log = logger("daemon");

export interface SessionBundle {
  version: number;
  exportedAt?: string;
  session: {
    sessionId: string;
    lineageId: string;
    upstreamSessionId?: string;
    agentId?: string;
    cwd?: string;
    title?: string;
    [key: string]: unknown;
  };
  history?: unknown[];
  promptHistory?: unknown[];
  [key: string]: unknown;
}

export interface DaemonClientOptions {
  daemonUrl: string;
  token: string;
}

export class DaemonClient {
  constructor(private readonly opts: DaemonClientOptions) {}

  async listSessionIds(): Promise<Set<string>> {
    const r = await fetch(`${this.opts.daemonUrl}/v1/sessions`, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!r.ok) {
      throw new Error(`list sessions: HTTP ${r.status}`);
    }
    const body = (await r.json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    const out = new Set<string>();
    for (const s of body.sessions) {
      if (typeof s.sessionId === "string") {
        out.add(s.sessionId);
      }
    }
    return out;
  }

  async exportSession(sessionId: string): Promise<SessionBundle> {
    const url = `${this.opts.daemonUrl}/v1/sessions/${encodeURIComponent(sessionId)}/export`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!r.ok) {
      const text = await safeBody(r);
      throw new Error(`export ${sessionId}: HTTP ${r.status} ${text}`);
    }
    return (await r.json()) as SessionBundle;
  }

  async importBundle(
    bundle: SessionBundle,
    opts: { replace?: boolean; cwd?: string } = {},
  ): Promise<{ sessionId: string }> {
    const body: Record<string, unknown> = { bundle };
    if (opts.replace !== undefined) {
      body.replace = opts.replace;
    }
    if (opts.cwd !== undefined) {
      body.cwd = opts.cwd;
    }
    const r = await fetch(`${this.opts.daemonUrl}/v1/sessions/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await safeBody(r);
      throw new Error(`import lineage=${bundle.session.lineageId}: HTTP ${r.status} ${text}`);
    }
    const out = (await r.json()) as { sessionId?: string };
    if (!out.sessionId) {
      log.warn(`import returned no sessionId for lineage ${bundle.session.lineageId}`);
      return { sessionId: "" };
    }
    return { sessionId: out.sessionId };
  }
}

async function safeBody(r: Response): Promise<string> {
  try {
    const t = await r.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

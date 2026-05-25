import type { SyncBackend } from "./backend/types.js";
import type { DaemonClient } from "./daemon.js";
import { deserialize, type SyncEnvelope } from "./envelope.js";
import type { SyncState } from "./state.js";
import { logger } from "./util/log.js";

const log = logger("pull");

export interface PullLoopOptions {
  daemon: DaemonClient;
  backend: SyncBackend;
  state: SyncState;
  intervalMs: number;
  hostId: string;
}

export class PullLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private inFlight = false;

  constructor(private readonly opts: PullLoopOptions) {}

  start(): void {
    log.info(
      `polling backend every ${this.opts.intervalMs}ms for peer-uploaded bundles`,
    );
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // tickNow is exposed for tests to drive a single iteration on demand.
  async tickNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      // Snapshot the daemon's session set once per tick. Any envelope
      // whose inner bundle.session.sessionId is already present locally
      // is one we (or a peer using our credentials) uploaded — skip it.
      let localSessionIds: Set<string>;
      try {
        localSessionIds = await this.opts.daemon.listSessionIds();
      } catch (err) {
        log.warn(`session list failed; skipping tick: ${(err as Error).message}`);
        return;
      }
      await this.resetDeletedImports(localSessionIds);

      const ownPrefix = this.opts.hostId + "/";
      const entries = await this.opts.backend.list();
      for (const entry of entries) {
        if (this.stopped) {
          return;
        }
        if (entry.key.startsWith(ownPrefix)) {
          continue;
        }
        await this.processEntry(entry.key, localSessionIds).catch((err: unknown) => {
          log.warn(
            `processing ${entry.key} failed: ${(err as Error).message}`,
          );
        });
      }
    } catch (err) {
      log.warn(`backend.list failed: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  private async resetDeletedImports(localSessionIds: Set<string>): Promise<void> {
    for (const lineageId of this.opts.state.lineageIds()) {
      const entry = this.opts.state.get(lineageId);
      if (
        entry.importedSessionId !== undefined &&
        !localSessionIds.has(entry.importedSessionId)
      ) {
        await this.opts.state.resetImport(lineageId);
        log.info(
          `imported session for lineage=${lineageId} was deleted; will re-import`,
        );
      }
    }
  }

  private async processEntry(
    key: string,
    localSessionIds: Set<string>,
  ): Promise<void> {
    const raw = await this.opts.backend.get(key);
    let envelope: SyncEnvelope;
    try {
      envelope = deserialize(raw);
    } catch (err) {
      log.warn(`malformed envelope at ${key}: ${(err as Error).message}`);
      return;
    }
    const { lineageId } = envelope;

    // Self-loop suppression: if the bundle's sessionId already exists
    // in the local daemon, we (or a peer reflecting our upload) made
    // this — no need to import. This survives hostname changes and
    // race-conditions with state writes that a hostname or hash check
    // would not.
    const innerSessionId = readSessionId(envelope.bundle);
    if (innerSessionId !== undefined && localSessionIds.has(innerSessionId)) {
      return;
    }

    const local = this.opts.state.get(lineageId);

    if (
      local.lastSeenRemoteUploadedAt !== undefined &&
      envelope.uploadedAt <= local.lastSeenRemoteUploadedAt
    ) {
      return;
    }

    if (
      typeof envelope.bundle !== "object" ||
      envelope.bundle === null
    ) {
      log.warn(`envelope ${key} bundle is not an object; skipping`);
      return;
    }

    log.info(
      `importing lineage=${lineageId} from ${envelope.uploadedBy.host} uploadedAt=${envelope.uploadedAt}`,
    );
    let importedSessionId: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await this.opts.daemon.importBundle(envelope.bundle as any, {
        replace: true,
      });
      importedSessionId = result.sessionId;
    } catch (err) {
      log.warn(
        `daemon import for lineage ${lineageId} failed: ${(err as Error).message}`,
      );
      return;
    }
    // Suppress the immediate re-upload that the daemon's
    // import-induced turn_complete (if any) would trigger: we record
    // the envelope hash as our last-uploaded hash so the archive-loop
    // sees "no change" on the next export.
    await this.opts.state.set(lineageId, {
      lastSeenRemoteUploadedAt: envelope.uploadedAt,
      lastSeenRemoteBy: envelope.uploadedBy.host,
      lastUploadedHash: envelope.bundleHash,
      lastUploadedAt: envelope.uploadedAt,
      importedSessionId,
    });
  }
}

function readSessionId(bundle: unknown): string | undefined {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return undefined;
  }
  const session = (bundle as Record<string, unknown>).session;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return undefined;
  }
  const id = (session as Record<string, unknown>).sessionId;
  return typeof id === "string" ? id : undefined;
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { SyncBackend } from "./backend/types.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveLoop } from "./archive-loop.js";
import { EncryptedBackend } from "./backend/encrypted.js";
import { makeBackend } from "./backend/factory.js";
import { ArchiverBridge } from "./bridge.js";
import { runColdSweep } from "./cold-sweep.js";
import { loadConfig, loadEncryptionKey, loadLoginConfig } from "./config.js";
import { DaemonClient } from "./daemon.js";
import { HydraDiscovery } from "./discovery.js";
import { lineageFromKey } from "./envelope.js";
import { runKeygen } from "./keygen.js";
import { runGoogleLogin } from "./oauth/google.js";
import { PullLoop } from "./pull-loop.js";
import { DEFAULT_RULE, loadRule, type RuleFunction } from "./rule.js";
import { SyncState } from "./state.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

const USAGE = `usage: hydra-acp-archiver [<command>]

Commands:
  (no args)      Run as a daemon-managed extension (the daemon spawns it
                 this way automatically when registered).
  gdrive login   Interactive Google OAuth flow — opens a browser and writes
                 the refresh token to ~/.hydra-acp/archiver-google-token.json.
  keygen         Generate a symmetric encryption key and write it to
                 HYDRA_ACP_ARCHIVER_KEY_PATH (or ~/.hydra-acp/archiver-key).

Flags:
  --version, -v   Print version and exit.
  --help, -h      Show this message.
`;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

async function runLogin(): Promise<void> {
  setDebug(TRUTHY.has((process.env.DEBUG ?? "").toLowerCase()));
  const cfg = loadLoginConfig();
  log.info(`credentials=${cfg.credentialsPath} token=${cfg.tokenPath}`);
  await runGoogleLogin({
    credentialsPath: cfg.credentialsPath,
    tokenPath: cfg.tokenPath,
  });
  log.info("login complete — you can now start the archiver extension");
}

async function runExtension(): Promise<void> {
  const config = loadConfig();
  setDebug(config.debug);

  const encryptionKey = await loadEncryptionKey(config.encryptionKeyPath);

  if (config.prefix === "") {
    if (encryptionKey !== undefined) {
      config.prefix = createHash("sha256").update(encryptionKey).digest().subarray(0, 8).toString("hex") + "/";
      log.info(`auto-prefix (key fingerprint): ${config.prefix}`);
    } else {
      config.prefix = userInfo().username.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "/";
      log.info(`auto-prefix (username): ${config.prefix}`);
    }
  }

  const state = new SyncState(config.statePath);
  await state.load(config.prefix, config.backend);

  function buildBackend(prefix: string): SyncBackend {
    const raw = makeBackend({ ...config, prefix });
    return encryptionKey !== undefined ? new EncryptedBackend(raw, encryptionKey) : raw;
  }

  // syncBackend sees the full user namespace (all hosts) — used for listing
  // and pulling. uploadBackend scopes writes to this host's subdirectory.
  const syncBackend = buildBackend(config.prefix);
  const uploadBackend = buildBackend(config.prefix + config.hostId + "/");
  await syncBackend.init();
  await uploadBackend.init();

  // Reconcile state.json with what's actually on the backend. Without
  // this a wiped backend (manual nuke, retention delete, expired share)
  // leaves us believing every lineage is "already uploaded" — the hash
  // skip in archive-loop never fires a re-upload and the user wonders
  // why nothing flooded in. One list call at startup makes state a
  // hint-cache instead of a source of truth.
  try {
    const entries = await syncBackend.list();
    const presentLineages = new Set<string>();
    for (const e of entries) {
      const id = lineageFromKey(e.key);
      if (id !== undefined) {
        presentLineages.add(id);
      }
    }
    const pruned = await state.reconcile(presentLineages);
    log.info(
      `reconciled state with backend: present=${presentLineages.size} pruned=${pruned}`,
    );
  } catch (err) {
    log.warn(
      `state reconcile skipped — backend list failed: ${(err as Error).message}`,
    );
  }

  const daemon = new DaemonClient({
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
  });

  let currentRule: RuleFunction = DEFAULT_RULE;
  currentRule = await loadRule(config.ruleConfigPath);

  const archive = new ArchiveLoop({
    daemon,
    backend: uploadBackend,
    state,
    getRule: () => currentRule,
    debounceMs: config.uploadDebounceMs,
    host: { host: config.hostId, user: userInfo().username },
  });

  const pull = new PullLoop({
    daemon,
    backend: syncBackend,
    state,
    intervalMs: config.pullIntervalMs,
    hostId: config.hostId,
  });
  pull.start();

  // Backfill: archive every cold session the daemon knows about.
  // Runs in the background so the rest of startup (discovery,
  // bridges) doesn't block on it. Hash dedup means restarts are cheap.
  void runColdSweep({
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
    archive,
  }).catch((err: unknown) => {
    log.warn(`cold sweep failed: ${(err as Error).message}`);
  });

  const bridges = new Map<string, ArchiverBridge>();

  const discovery = new HydraDiscovery({
    daemonUrl: config.hydraDaemonUrl,
    token: config.hydraToken,
    pollIntervalMs: config.hydraPollIntervalMs,
    onAdd: (session) => {
      if (bridges.has(session.sessionId)) {
        return;
      }
      log.info(
        `attaching to ${session.sessionId} agent=${session.agentId ?? "?"} cwd=${session.cwd}`,
      );
      const bridge = new ArchiverBridge({
        daemonWsUrl: config.hydraWsUrl,
        token: config.hydraToken,
        sessionId: session.sessionId,
        meta: {
          ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
          ...(session.agentId !== undefined
            ? { agentId: session.agentId }
            : {}),
          ...(session.title !== undefined ? { title: session.title } : {}),
        },
        archive,
      });
      bridges.set(session.sessionId, bridge);
      bridge.start();
    },
    onRemove: (sessionId) => {
      const bridge = bridges.get(sessionId);
      if (!bridge) {
        return;
      }
      log.info(`detaching from ${sessionId}`);
      bridges.delete(sessionId);
      bridge.stop();
    },
  });
  discovery.start();

  process.on("SIGHUP", () => {
    log.info(`SIGHUP — reloading rule from ${config.ruleConfigPath}`);
    loadRule(config.ruleConfigPath)
      .then((rule) => {
        currentRule = rule;
        log.info("rule reload complete");
      })
      .catch((err: unknown) => {
        log.warn(`rule reload failed: ${(err as Error).message}`);
      });
  });

  const shutdown = (sig: string): void => {
    log.info(`${sig} received — shutting down`);
    discovery.stop();
    pull.stop();
    archive.stop();
    for (const bridge of bridges.values()) {
      bridge.stop();
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info(
    `hydra-acp-archiver up; daemon=${config.hydraDaemonUrl} backend=${config.backend} host=${config.hostId} rule=${config.ruleConfigPath}`,
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(`hydra-acp-archiver ${readVersion()}\n`);
    return;
  }
  if (cmd === undefined) {
    await runExtension();
    return;
  }
  if (cmd === "gdrive") {
    const sub = process.argv[3];
    if (sub === "login") {
      await runLogin();
      return;
    }
    const subcmds = "login";
    process.stderr.write(
      sub !== undefined
        ? `hydra-acp-archiver gdrive: unknown subcommand "${sub}"\n\nAvailable: ${subcmds}\n`
        : `hydra-acp-archiver gdrive: missing subcommand\n\nAvailable: ${subcmds}\n`,
    );
    process.exit(2);
  }
  if (cmd === "login") {
    process.stderr.write(
      `hydra-acp-archiver: "login" is not a command; did you mean "gdrive login"?\n`,
    );
    process.exit(2);
  }
  if (cmd === "keygen") {
    await runKeygen();
    return;
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return;
  }
  process.stderr.write(`hydra-acp-archiver: unknown command "${cmd}"\n\n${USAGE}`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`hydra-acp-archiver: ${(err as Error).message}\n`);
  process.exit(1);
});

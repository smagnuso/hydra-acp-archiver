#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { SyncBackend } from "./backend/types.js";
import { resolvePrefix } from "./prefix.js";
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
  setup          Interactive first-run wizard — picks a backend, sets up
                 OAuth/credentials/encryption, writes archiver.conf, and
                 (optionally) registers the extension with hydra.
  (no args)      Run as a daemon-managed extension (the daemon spawns it
                 this way automatically when registered).
  gdrive login   Interactive Google OAuth flow — opens a browser and writes
                 the refresh token to ~/.hydra-acp/archiver-google-token.json.
  keygen         Generate a symmetric encryption key and write it to
                 HYDRA_ACP_ARCHIVER_KEY_PATH (or ~/.hydra-acp/archiver-key).
  restore list [--host <h>] [--agent <a>] [--cwd <s>] [--grep <s>]
               [--since <7d|iso>] [--limit <n>] [--fast] [--json]
               [--only-remote | --only-local]
                 List every bundle in the backend (across all hosts).
                 Default decrypts each envelope to show title/cwd/agent;
                 --fast skips decryption for a metadata-only view. Bundles
                 that already exist locally are marked LOCAL=yes and pulled
                 from meta.json instead of the backend (free hydration).
                 --only-remote hides local-known lineages so you see just
                 the ones you'd need to pull to get back.
  restore pull <lineageId> [--host <h>] [--to <file>|-] [--import]
               [--no-replace] [--cwd <path>] [--force]
                 Fetch a bundle by lineage. <lineageId> may include or omit
                 the hydra_lineage_ prefix. If a session with this lineage
                 already exists locally, prints its id and skips the
                 network unless --force. Otherwise writes the raw .hydra
                 bundle to <file> or stdout; --import POSTs it to the
                 daemon's /v1/sessions/import (implies replace=true unless
                 --no-replace). If multiple hosts have this lineage, the
                 newest wins; use --host to disambiguate.

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
  log.info(`token=${cfg.tokenPath}`);
  await runGoogleLogin({
    tokenPath: cfg.tokenPath,
  });
  log.info("login complete — you can now start the archiver extension");
}

async function runExtension(): Promise<void> {
  const config = loadConfig();
  setDebug(config.debug);

  const encryptionKey = await loadEncryptionKey(config.encryptionKeyPath);

  if (config.prefix === "") {
    config.prefix = resolvePrefix(config.prefix, encryptionKey);
    log.info(
      `auto-prefix (${encryptionKey !== undefined ? "key fingerprint" : "username"}): ${config.prefix}`,
    );
  }

  const state = new SyncState(config.statePath);
  await state.load(readVersion(), config.prefix, config.backend);

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
    toolContent: config.toolContent,
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
          ...(session.interactive !== undefined
            ? { interactive: session.interactive }
            : {}),
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
  if (cmd === "restore") {
    const sub = process.argv[3];
    const rest = process.argv.slice(4);
    const { parseListArgs, parsePullArgs, runRestoreList, runRestorePull } =
      await import("./restore.js");
    if (sub === "list") {
      await runRestoreList(parseListArgs(rest));
      return;
    }
    if (sub === "pull") {
      await runRestorePull(parsePullArgs(rest));
      return;
    }
    process.stderr.write(
      sub !== undefined
        ? `hydra-acp-archiver restore: unknown subcommand "${sub}"\n\nAvailable: list, pull\n`
        : `hydra-acp-archiver restore: missing subcommand\n\nAvailable: list, pull\n`,
    );
    process.exit(2);
  }
  if (cmd === "setup") {
    const { runSetup } = await import("./setup/wizard.js");
    await runSetup();
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
  const msg = (err as Error).message;
  process.stderr.write(`hydra-acp-archiver: ${msg}\n`);
  if (/invalid_grant/i.test(msg)) {
    process.stderr.write(
      "Google refresh token is invalid. Run `hydra-acp-archiver gdrive login` to re-authorize.\n",
    );
    // sysexits EX_CONFIG — tells the daemon supervisor not to restart us.
    process.exit(78);
  }
  process.exit(1);
});

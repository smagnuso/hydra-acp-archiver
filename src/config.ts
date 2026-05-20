import { homedir } from "node:os";
import { resolve } from "node:path";

export type BackendKind = "google-drive" | "fs";

export interface Config {
  hydraDaemonUrl: string;
  hydraWsUrl: string;
  hydraToken: string;
  hydraHome: string;
  hydraPollIntervalMs: number;
  ruleConfigPath: string;
  // Per-session upload debounce window. A burst of session/update events
  // collapses into a single export+upload at the end of this window.
  uploadDebounceMs: number;
  // How often the pull loop calls backend.list() to discover new remote
  // envelopes uploaded by peers.
  pullIntervalMs: number;
  backend: BackendKind;
  driveFolderName: string;
  fsDir: string;
  // OAuth client credentials downloaded from GCP Console (the
  // {installed: {...}} JSON). User-supplied; archiver doesn't ship its
  // own credentials. See README.
  credentialsPath: string;
  // OAuth refresh + access token, written by the login bin.
  tokenPath: string;
  statePath: string;
  debug: boolean;
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  }
  if (httpUrl.startsWith("http://")) {
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  }
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function backendEnv(): BackendKind {
  const raw = (process.env.HYDRA_ACP_ARCHIVER_BACKEND ?? "google-drive").toLowerCase();
  if (raw === "google-drive" || raw === "fs") {
    return raw;
  }
  throw new Error(
    `HYDRA_ACP_ARCHIVER_BACKEND must be one of: google-drive, fs (got "${raw}")`,
  );
}

export function loadConfig(): Config {
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:8765";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra extension, hydra injects this automatically.",
    );
  }
  const hydraWsUrl =
    process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const hydraHome =
    process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  const ruleConfigPath =
    process.env.HYDRA_ACP_ARCHIVER_CONFIG ??
    resolve(hydraHome, "archiver.config.js");
  const credentialsPath =
    process.env.HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS ??
    resolve(hydraHome, "archiver-google-credentials.json");
  const tokenPath = resolve(hydraHome, "archiver-google-token.json");
  const statePath = resolve(hydraHome, "archiver-state.json");
  const fsDir =
    process.env.HYDRA_ACP_ARCHIVER_FS_DIR ?? resolve(hydraHome, "archive");

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    hydraHome,
    hydraPollIntervalMs: intEnv("HYDRA_ACP_ARCHIVER_POLL_MS", 2000),
    ruleConfigPath,
    uploadDebounceMs: intEnv("HYDRA_ACP_ARCHIVER_DEBOUNCE_MS", 5000),
    pullIntervalMs: intEnv("HYDRA_ACP_ARCHIVER_PULL_MS", 60000),
    backend: backendEnv(),
    driveFolderName:
      process.env.HYDRA_ACP_ARCHIVER_DRIVE_FOLDER ?? "hydra-acp-archive",
    fsDir,
    credentialsPath,
    tokenPath,
    statePath,
    debug: boolEnv("DEBUG", false),
  };
}

export interface LoginConfig {
  hydraHome: string;
  credentialsPath: string;
  tokenPath: string;
}

// loadLoginConfig is for the standalone `hydra-acp-archiver-login` bin —
// it doesn't need a daemon token, just enough config to know where to
// read credentials from and write the OAuth tokens to.
export function loadLoginConfig(): LoginConfig {
  const hydraHome =
    process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  const credentialsPath =
    process.env.HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS ??
    resolve(hydraHome, "archiver-google-credentials.json");
  return {
    hydraHome,
    credentialsPath,
    tokenPath: resolve(hydraHome, "archiver-google-token.json"),
  };
}

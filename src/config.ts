import { readFile, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const readFileAsync = promisify(readFile);

export type BackendKind = "google-drive" | "fs" | "s3";

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
  s3Bucket: string;
  s3Region: string | undefined;
  s3Endpoint: string | undefined;
  prefix: string;
  hostId: string;
  encryptionKeyPath: string | undefined;
  // OAuth client credentials downloaded from GCP Console (the
  // {installed: {...}} JSON). User-supplied; archiver doesn't ship its
  // own credentials. See README.
  credentialsPath: string;
  // OAuth refresh + access token, written by the login bin.
  tokenPath: string;
  statePath: string;
  debug: boolean;
}

// ── Conf file ────────────────────────────────────────────────────────────────

function confPath(hydraHome: string): string {
  return process.env.HYDRA_ACP_ARCHIVER_CONF ?? resolve(hydraHome, "archiver.conf");
}

function parseConfFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#"))
      continue;
    const eq = line.indexOf("=");
    if (eq === -1)
      continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    out.set(key, val);
  }
  return out;
}

// Returns an empty map when the file does not exist — conf file is optional.
function readConf(path: string): Map<string, string> {
  try {
    return parseConfFile(readFileSync(path, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT")
      return new Map();
    throw err;
  }
}

// ── Value helpers ─────────────────────────────────────────────────────────────
// Priority for every config value: env var > conf file > default.

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function str(
  envName: string,
  confKey: string,
  conf: Map<string, string>,
  fallback: string,
): string {
  return process.env[envName] ?? conf.get(confKey) ?? fallback;
}

function optStr(
  envName: string,
  confKey: string,
  conf: Map<string, string>,
): string | undefined {
  return process.env[envName] ?? conf.get(confKey);
}

function intVal(
  envName: string,
  confKey: string,
  conf: Map<string, string>,
  fallback: number,
): number {
  const raw = process.env[envName] ?? conf.get(confKey);
  if (!raw)
    return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolVal(
  envName: string,
  confKey: string,
  conf: Map<string, string>,
  fallback: boolean,
): boolean {
  const raw = process.env[envName] ?? conf.get(confKey);
  if (raw === undefined)
    return fallback;
  return TRUTHY.has(raw.toLowerCase());
}

// ── Derived helpers ───────────────────────────────────────────────────────────

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://"))
    return "wss://" + httpUrl.slice("https://".length).replace(/\/$/, "") + "/acp";
  if (httpUrl.startsWith("http://"))
    return "ws://" + httpUrl.slice("http://".length).replace(/\/$/, "") + "/acp";
  throw new Error(`hydraDaemonUrl must start with http:// or https://: ${httpUrl}`);
}

function parseBackend(raw: string): BackendKind {
  const v = raw.toLowerCase();
  if (v === "google-drive" || v === "fs" || v === "s3")
    return v;
  throw new Error(
    `BACKEND must be one of: google-drive, fs, s3 (got "${raw}")`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export function loadConfig(): Config {
  const hydraDaemonUrl =
    process.env.HYDRA_ACP_DAEMON_URL ?? "http://127.0.0.1:8765";
  const hydraToken = process.env.HYDRA_ACP_TOKEN ?? "";
  if (!hydraToken) {
    throw new Error(
      "Missing HYDRA_ACP_TOKEN env var. When run as a hydra extension, hydra injects this automatically.",
    );
  }
  const hydraWsUrl = process.env.HYDRA_ACP_WS_URL ?? deriveWsUrl(hydraDaemonUrl);
  const hydraHome = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");

  const conf = readConf(confPath(hydraHome));

  const ruleConfigPath = str(
    "HYDRA_ACP_ARCHIVER_CONFIG", "CONFIG", conf,
    resolve(hydraHome, "archiver.config.js"),
  );
  const credentialsPath = str(
    "HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS", "GOOGLE_CREDENTIALS", conf,
    resolve(hydraHome, "archiver-google-credentials.json"),
  );
  const tokenPath = resolve(hydraHome, "archiver-google-token.json");
  const statePath = resolve(hydraHome, "archiver-state.json");

  const backend = parseBackend(str("HYDRA_ACP_ARCHIVER_BACKEND", "BACKEND", conf, "google-drive"));
  const s3Bucket = str("HYDRA_ACP_ARCHIVER_S3_BUCKET", "S3_BUCKET", conf, "");
  if (backend === "s3" && !s3Bucket) {
    throw new Error(
      "S3_BUCKET is required when BACKEND is s3. Set it in archiver.conf or via HYDRA_ACP_ARCHIVER_S3_BUCKET.",
    );
  }

  return {
    hydraDaemonUrl,
    hydraWsUrl,
    hydraToken,
    hydraHome,
    hydraPollIntervalMs: intVal("HYDRA_ACP_ARCHIVER_POLL_MS", "POLL_MS", conf, 2000),
    ruleConfigPath,
    uploadDebounceMs: intVal("HYDRA_ACP_ARCHIVER_DEBOUNCE_MS", "DEBOUNCE_MS", conf, 5000),
    pullIntervalMs: intVal("HYDRA_ACP_ARCHIVER_PULL_MS", "PULL_MS", conf, 60000),
    backend,
    driveFolderName: str("HYDRA_ACP_ARCHIVER_DRIVE_FOLDER", "DRIVE_FOLDER", conf, "hydra-acp-archive"),
    fsDir: str("HYDRA_ACP_ARCHIVER_FS_DIR", "FS_DIR", conf, resolve(hydraHome, "archive")),
    s3Bucket,
    s3Region: optStr("HYDRA_ACP_ARCHIVER_S3_REGION", "S3_REGION", conf),
    s3Endpoint: optStr("HYDRA_ACP_ARCHIVER_S3_ENDPOINT", "S3_ENDPOINT", conf),
    prefix: str("HYDRA_ACP_ARCHIVER_PREFIX", "PREFIX", conf, ""),
    hostId: (optStr("HYDRA_ACP_ARCHIVER_HOST_ID", "HOST_ID", conf) ?? hostname())
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-"),
    encryptionKeyPath: optStr("HYDRA_ACP_ARCHIVER_KEY_PATH", "KEY_PATH", conf),
    credentialsPath,
    tokenPath,
    statePath,
    debug: boolVal("DEBUG", "DEBUG", conf, false),
  };
}

export async function loadEncryptionKey(
  path: string | undefined,
): Promise<Buffer | undefined> {
  if (path === undefined)
    return undefined;
  let hex: string;
  try {
    hex = (await readFileAsync(path, "utf8")).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `Encryption key file not found at ${path}. Run \`hydra-acp-archiver keygen\` to generate one.`,
      );
    }
    throw err;
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      `Encryption key at ${path} is not a valid 64-character hex string.`,
    );
  }
  return Buffer.from(hex, "hex");
}

export interface LoginConfig {
  hydraHome: string;
  credentialsPath: string;
  tokenPath: string;
}

export function loadLoginConfig(): LoginConfig {
  const hydraHome = process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
  const conf = readConf(confPath(hydraHome));
  const credentialsPath = str(
    "HYDRA_ACP_ARCHIVER_GOOGLE_CREDENTIALS", "GOOGLE_CREDENTIALS", conf,
    resolve(hydraHome, "archiver-google-credentials.json"),
  );
  return {
    hydraHome,
    credentialsPath,
    tokenPath: resolve(hydraHome, "archiver-google-token.json"),
  };
}

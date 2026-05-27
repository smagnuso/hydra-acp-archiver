import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { loadLoginConfig } from "../config.js";
import { runKeygen } from "../keygen.js";
import { runGoogleLogin } from "../oauth/google.js";
import { loadAwsCredentials } from "../util/aws-credentials.js";
import { mergeConf, PRIMARY_CONF_PATH, readExisting, writeConf } from "./conf-writer.js";
import { formatAge, scanDownloadsForGoogleCredentials } from "./downloads-scan.js";
import { ask, askSecret, confirm, openBrowser, pause, pickFromList } from "./prompts.js";

type Backend = "google-drive" | "s3" | "fs";

const TOTAL_STEPS = 6;
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function header(num: number, total: number, title: string): void {
  process.stdout.write(`\n  ${BOLD}[${num}/${total}] ${title}${RESET}\n\n`);
}

function ok(msg: string): void {
  process.stdout.write(`      ${GREEN}✓${RESET} ${msg}\n`);
}

function warn(msg: string): void {
  process.stdout.write(`      ${YELLOW}⚠${RESET} ${msg}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`      ${RED}✗ ${msg}${RESET}\n`);
  process.exit(1);
}

function info(msg: string): void {
  process.stdout.write(`      ${msg}\n`);
}

function blank(): void {
  process.stdout.write("\n");
}

function hasBin(name: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir)
      continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        if (statSync(full).isFile())
          return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

const HYDRA_HOME = resolve(homedir(), ".hydra-acp");
const HYDRA_CONFIG_PATH = resolve(HYDRA_HOME, "config.json");
const DEFAULT_KEY_PATH = resolve(HYDRA_HOME, "archiver-key");
const DEFAULT_FS_DIR = resolve(HYDRA_HOME, "archive");
const DEFAULT_DRIVE_FOLDER = "hydra-acp-archive";

function readHydraConfigExtensions(): Set<string> {
  try {
    const cfg = JSON.parse(readFileSync(HYDRA_CONFIG_PATH, "utf8")) as {
      extensions?: Record<string, unknown>;
    };
    return new Set(Object.keys(cfg.extensions ?? {}));
  } catch {
    return new Set();
  }
}

function keyFingerprint(keyPath: string): string | undefined {
  try {
    const hex = readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-f]+$/i.test(hex))
      return undefined;
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length !== 32)
      return undefined;
    return createHash("sha256").update(bytes).digest().subarray(0, 8).toString("hex");
  } catch {
    return undefined;
  }
}

async function step1ExistingCheck(): Promise<{ reconfigure: boolean }> {
  header(1, TOTAL_STEPS, "Checking existing setup");

  info("This wizard configures a backend (Google Drive / S3 / Filesystem),");
  info("optional encryption, and registers the archiver with hydra.");
  blank();

  const { map } = readExisting(PRIMARY_CONF_PATH);
  if (map.size === 0) {
    ok("No existing archiver config found.");
    return { reconfigure: true };
  }

  const backend = map.get("BACKEND") ?? "google-drive";
  info(`Existing config at ${PRIMARY_CONF_PATH}`);
  info(`  Backend: ${backend}`);
  if (backend === "google-drive")
    info(`  Drive folder: ${map.get("DRIVE_FOLDER") ?? DEFAULT_DRIVE_FOLDER}`);
  else if (backend === "s3")
    info(`  S3 bucket: ${map.get("S3_BUCKET") ?? "(missing)"}`);
  else if (backend === "fs")
    info(`  FS dir: ${map.get("FS_DIR") ?? DEFAULT_FS_DIR}`);

  const keyPath = map.get("KEY_PATH") ?? (existsSync(DEFAULT_KEY_PATH) ? DEFAULT_KEY_PATH : undefined);
  if (map.get("KEY_PATH")) {
    const fp = keyFingerprint(map.get("KEY_PATH")!);
    info(`  Encryption: on${fp ? ` (fingerprint ${fp})` : ""}`);
  } else {
    info(`  Encryption: off`);
  }

  const registered = readHydraConfigExtensions().has("hydra-acp-archiver");
  info(`  Registered with hydra: ${registered ? "yes" : "no"}`);
  blank();

  if (!(await confirm("Reconfigure from scratch?", false))) {
    info("Edit ~/.hydra-acp/archiver.conf directly to tune individual settings.");
    return { reconfigure: false };
  }
  return { reconfigure: true };
}

interface BackendChoice {
  backend: Backend;
}

async function step2PickBackend(): Promise<BackendChoice> {
  header(2, TOTAL_STEPS, "Pick a backend");

  const choices: { backend: Backend; label: string }[] = [
    {
      backend: "google-drive",
      label:
        "Google Drive\n           Easiest cross-machine sync. Free up to 15 GB. One-time GCP\n           setup (~5 min in the Cloud Console).",
    },
    {
      backend: "s3",
      label:
        "S3 / S3-compatible (R2, B2, MinIO, Wasabi)\n           Best for larger archives. Needs AWS-style creds and an\n           existing bucket.",
    },
    {
      backend: "fs",
      label:
        "Filesystem\n           Useful with Syncthing/Dropbox mirroring a folder, or for\n           local-only testing.",
    },
  ];

  const picked = await pickFromList("Choose:", choices, (c) => c.label);
  if (!picked)
    fail("A backend is required.");
  ok(`Backend: ${picked.backend}`);
  return { backend: picked.backend };
}

interface GoogleResult {
  driveFolder: string;
  credentialsPath: string;
}

async function step3aGoogleDrive(): Promise<GoogleResult> {
  header(3, TOTAL_STEPS, "Configure Google Drive");

  const login = loadLoginConfig();
  const credentialsPath = login.credentialsPath;

  if (existsSync(credentialsPath)) {
    ok(`Google OAuth credentials found at ${credentialsPath}.`);
  } else {
    info("First-time setup. You need an OAuth client from Google Cloud Console.");
    blank();
    info("  1. Pick or create a project");
    info("  2. APIs & Services → Library → enable Google Drive API");
    info("  3. OAuth consent screen → User type: External → add yourself as a Test User");
    info("  4. Credentials → Create credentials → OAuth client ID → Application: Desktop app");
    info("  5. Download the JSON (lands in ~/Downloads)");
    blank();
    await pause("Press Enter to open the Cloud Console...");
    openBrowser("https://console.cloud.google.com/");
    blank();
    await pause("Press Enter once you've downloaded the JSON...");

    const hit = scanDownloadsForGoogleCredentials();
    let srcPath: string | undefined;
    if (hit) {
      blank();
      info(`Found ${hit.path} (${formatAge(hit.ageMs)}).`);
      if (await confirm("Use this file?", true))
        srcPath = hit.path;
    }
    if (!srcPath) {
      blank();
      const manual = await ask("Path to the downloaded JSON");
      if (!manual)
        fail("A credentials file is required.");
      srcPath = manual.startsWith("~/") ? manual.replace(/^~/, homedir()) : manual;
    }
    if (!existsSync(srcPath))
      fail(`File not found: ${srcPath}`);

    mkdirSync(HYDRA_HOME, { recursive: true });
    copyFileSync(srcPath, credentialsPath);
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(credentialsPath, 0o600);
    } catch {
      // chmod not meaningful on win32
    }
    ok(`Saved to ${credentialsPath} (chmod 600).`);
  }

  blank();
  const driveFolder = await ask("Drive folder name", DEFAULT_DRIVE_FOLDER);

  blank();
  info("Now we run Google's OAuth flow. Your browser will open to a consent");
  info("screen. The 'Google hasn't verified this app' interstitial is expected");
  info("for a personal OAuth client — click 'Advanced' → 'Go to (unsafe)' → 'Allow'.");
  blank();
  await pause("Press Enter to start OAuth...");

  try {
    await runGoogleLogin({ credentialsPath, tokenPath: login.tokenPath });
  } catch (err) {
    fail(`Google OAuth failed: ${(err as Error).message}`);
  }
  ok(`OAuth complete. Token saved to ${login.tokenPath}.`);

  return { driveFolder, credentialsPath };
}

interface S3Result {
  bucket: string;
  region: string | undefined;
  endpoint: string | undefined;
}

async function step3bS3(): Promise<S3Result> {
  header(3, TOTAL_STEPS, "Configure S3");

  blank();
  info("S3 endpoint hints:");
  info(`  ${DIM}AWS S3${RESET}        leave Endpoint blank, set Region`);
  info(`  ${DIM}Cloudflare R2${RESET} https://<accountid>.r2.cloudflarestorage.com`);
  info(`  ${DIM}Backblaze B2${RESET}  https://s3.<region>.backblazeb2.com`);
  info(`  ${DIM}MinIO${RESET}         your MinIO endpoint URL`);
  blank();

  const bucket = await ask("S3 bucket name");
  if (!bucket)
    fail("A bucket name is required for S3.");
  const region = (await ask("Region (blank for SDK default)")) || undefined;
  const endpoint = (await ask("Endpoint URL (blank for AWS S3)")) || undefined;

  blank();
  try {
    const creds = loadAwsCredentials();
    const masked = `${creds.accessKeyId.slice(0, 4)}…${creds.accessKeyId.slice(-4)}`;
    const source = process.env.AWS_ACCESS_KEY_ID ? "env vars" : `~/.aws/credentials (profile: ${process.env.AWS_PROFILE ?? "default"})`;
    ok(`AWS creds found via ${source} — access key ${masked}.`);
  } catch (err) {
    warn(`${(err as Error).message}`);
    info("The archiver will fail to start until creds are in place.");
  }

  return { bucket, region, endpoint };
}

interface FsResult {
  dir: string;
}

async function step3cFilesystem(): Promise<FsResult> {
  header(3, TOTAL_STEPS, "Configure Filesystem");

  const suggestions: string[] = [];
  for (const candidate of ["Syncthing", "Dropbox", "iCloud Drive", "OneDrive"]) {
    const full = resolve(homedir(), candidate);
    if (existsSync(full))
      suggestions.push(full);
  }

  let dir: string | undefined;
  if (suggestions.length > 0) {
    info("Found sync folders that could host the archive:");
    blank();
    suggestions.forEach((s, i) => info(`  ${i + 1}. ${s}/hydra-acp-archive`));
    info(`  c. Custom path`);
    info(`  d. Default (${DEFAULT_FS_DIR})`);
    blank();
    const reply = (await ask("Choice", "d")).toLowerCase();
    if (reply === "d" || reply === "") {
      dir = DEFAULT_FS_DIR;
    } else if (reply === "c") {
      const custom = await ask("Archive directory", DEFAULT_FS_DIR);
      dir = custom.startsWith("~/") ? custom.replace(/^~/, homedir()) : custom;
    } else {
      const n = Number.parseInt(reply, 10);
      if (Number.isInteger(n) && n >= 1 && n <= suggestions.length)
        dir = resolve(suggestions[n - 1]!, "hydra-acp-archive");
    }
    if (!dir)
      fail("Invalid choice.");
  } else {
    const raw = await ask("Archive directory", DEFAULT_FS_DIR);
    dir = raw.startsWith("~/") ? raw.replace(/^~/, homedir()) : raw;
  }

  try {
    mkdirSync(dir, { recursive: true });
    const probe = resolve(dir, ".hydra-acp-archiver-test");
    writeFileSync(probe, "ok");
    rmSync(probe);
    ok(`Directory writable: ${dir}`);
  } catch (err) {
    fail(`Cannot write to ${dir}: ${(err as Error).message}`);
  }

  return { dir };
}

interface EncryptionResult {
  enabled: boolean;
  keyPath: string | undefined;
}

async function step4Encryption(backend: Backend): Promise<EncryptionResult> {
  header(4, TOTAL_STEPS, "Encryption");

  const defaultYes = backend !== "fs";
  if (backend === "fs")
    info("Filesystem backend — encryption is optional (you already control the disk).");
  else
    info(`${backend === "google-drive" ? "Google Drive" : "S3"} backend — encryption is recommended (data leaves your machine).`);
  blank();

  if (!(await confirm("Enable AES-256-GCM encryption at rest?", defaultYes))) {
    return { enabled: false, keyPath: undefined };
  }

  const existingFp = keyFingerprint(DEFAULT_KEY_PATH);
  if (existingFp) {
    info(`Existing key at ${DEFAULT_KEY_PATH} (fingerprint ${existingFp}).`);
    if (await confirm("Use this key?", true))
      return { enabled: true, keyPath: DEFAULT_KEY_PATH };
    blank();
    warn("Rotating the key makes the existing archive unreadable until re-uploaded.");
    if (!(await confirm("Generate a new key (overwrites the existing file)?", false)))
      return { enabled: true, keyPath: DEFAULT_KEY_PATH };
  }

  blank();
  await runKeygen();
  blank();
  info(`Copy ${DEFAULT_KEY_PATH} to each machine that should share this archive.`);
  return { enabled: true, keyPath: DEFAULT_KEY_PATH };
}

interface Step5Args {
  backend: Backend;
  google: GoogleResult | undefined;
  s3: S3Result | undefined;
  fs: FsResult | undefined;
  encryption: EncryptionResult;
}

async function step5WriteConfig(args: Step5Args): Promise<void> {
  header(5, TOTAL_STEPS, "Writing config");

  const login = loadLoginConfig();
  const updates: Record<string, string | undefined> = {
    BACKEND: args.backend,
  };

  if (args.backend === "google-drive" && args.google) {
    if (args.google.driveFolder !== DEFAULT_DRIVE_FOLDER)
      updates.DRIVE_FOLDER = args.google.driveFolder;
    if (args.google.credentialsPath !== login.credentialsPath)
      updates.GOOGLE_CREDENTIALS = args.google.credentialsPath;
  } else if (args.backend === "s3" && args.s3) {
    updates.S3_BUCKET = args.s3.bucket;
    if (args.s3.region)
      updates.S3_REGION = args.s3.region;
    if (args.s3.endpoint)
      updates.S3_ENDPOINT = args.s3.endpoint;
  } else if (args.backend === "fs" && args.fs) {
    if (args.fs.dir !== DEFAULT_FS_DIR)
      updates.FS_DIR = args.fs.dir;
  }

  if (args.encryption.enabled && args.encryption.keyPath)
    updates.KEY_PATH = args.encryption.keyPath;

  writeConf(PRIMARY_CONF_PATH, updates);
  ok(`Wrote ${PRIMARY_CONF_PATH} (chmod 600).`);

  blank();
  info("Final config:");
  const { map } = readExisting(PRIMARY_CONF_PATH);
  for (const [k, v] of map)
    info(`  ${k}=${v}`);
}

async function step6RegisterExtension(): Promise<void> {
  header(6, TOTAL_STEPS, "Register with hydra (optional)");

  if (!hasBin("hydra-acp")) {
    info("hydra-acp not found on PATH. Register manually later with:");
    info("  hydra-acp extensions add hydra-acp-archiver");
    return;
  }

  if (readHydraConfigExtensions().has("hydra-acp-archiver")) {
    ok("Already registered as a hydra extension.");
    info("Restart the daemon to pick up the new config: hydra-acp daemon restart");
    return;
  }

  info("hydra can manage hydra-acp-archiver as a subprocess that auto-starts");
  info("with the daemon. This adds an entry to ~/.hydra-acp/config.json.");
  blank();
  if (!(await confirm("Register hydra-acp-archiver as a hydra extension?", true))) {
    info("Skipping. Register later with:");
    info("  hydra-acp extensions add hydra-acp-archiver");
    return;
  }

  const cmdArgs = ["extensions", "add", "hydra-acp-archiver"];
  if (!hasBin("hydra-acp-archiver")) {
    const scriptPath = process.argv[1] ?? "";
    if (!scriptPath) {
      warn("Couldn't determine script path; falling back to bare command.");
    } else if (scriptPath.includes("/.npm/_npx/")) {
      warn("Looks like you're running via npx — registering this transient path");
      warn("would break on the next npx cache cleanup. Install globally first:");
      info("  npm install -g @hydra-acp/archiver");
      info("Then register with: hydra-acp extensions add hydra-acp-archiver");
      return;
    } else {
      cmdArgs.push("--command", "node", "--args", scriptPath);
    }
  }

  info(`Running: hydra-acp ${cmdArgs.join(" ")}`);
  const result = spawnSync("hydra-acp", cmdArgs, { stdio: "inherit" });
  if (result.status === 0) {
    ok("Registered.");
    info("Start the daemon (or restart if already running): hydra-acp daemon restart");
  } else {
    blank();
    warn(`hydra-acp exited with code ${result.status ?? "?"}.`);
    info("Register manually later with:");
    info(`  hydra-acp ${cmdArgs.join(" ")}`);
  }
}

export async function runSetup(): Promise<void> {
  process.stdout.write(`\n  ${BOLD}hydra-acp-archiver setup${RESET}\n`);

  const step1 = await step1ExistingCheck();
  if (!step1.reconfigure)
    return;

  const { backend } = await step2PickBackend();

  let google: GoogleResult | undefined;
  let s3: S3Result | undefined;
  let fs: FsResult | undefined;
  if (backend === "google-drive")
    google = await step3aGoogleDrive();
  else if (backend === "s3")
    s3 = await step3bS3();
  else
    fs = await step3cFilesystem();

  const encryption = await step4Encryption(backend);
  await step5WriteConfig({ backend, google, s3, fs, encryption });
  await step6RegisterExtension();

  blank();
  ok("Setup complete.");
}

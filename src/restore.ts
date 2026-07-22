import { readFile, writeFile } from "node:fs/promises";
import { EncryptedBackend } from "./backend/encrypted.js";
import { makeBackend } from "./backend/factory.js";
import type { SyncBackend, SyncBackendEntry } from "./backend/types.js";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, loadEncryptionKey } from "./config.js";
import { DaemonClient, type SessionBundle } from "./daemon.js";
import { deserialize, lineageFromKey } from "./envelope.js";
import { loadLocalIndex, type LocalSessionMeta } from "./local-index.js";
import { resolvePrefix } from "./prefix.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("restore");

const LINEAGE_PREFIX = "hydra_lineage_";

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

// Split "host/name.hydra.archive" into ["host", "name.hydra.archive"].
// Returns undefined for host when the key has no leading segment.
function splitKey(key: string): { host: string | undefined; name: string } {
  const slash = key.lastIndexOf("/");
  if (slash < 0) return { host: undefined, name: key };
  return { host: key.slice(0, slash), name: key.slice(slash + 1) };
}

// Normalize whatever the user typed into the canonical `hydra_lineage_...`
// form used by `keyFor()` / `lineageFromKey()`. Accepts both prefixed and
// bare ids so `restore pull qqzF1rSDDwJx1PIG` works.
function normalizeLineageId(input: string): string {
  return input.startsWith(LINEAGE_PREFIX) ? input : LINEAGE_PREFIX + input;
}

// Display form: drop the noisy `hydra_lineage_` prefix everywhere.
function shortLineage(lineageId: string): string {
  return lineageId.startsWith(LINEAGE_PREFIX)
    ? lineageId.slice(LINEAGE_PREFIX.length)
    : lineageId;
}

async function setupBackend(opts: {
  requireToken: boolean;
}): Promise<{
  backend: SyncBackend;
  encryptionKey: Buffer | undefined;
  daemonUrl: string;
  daemonToken: string;
  hydraHome: string;
}> {
  const config = loadConfig({ requireToken: opts.requireToken });
  setDebug(config.debug || TRUTHY.has((process.env.DEBUG ?? "").toLowerCase()));
  const encryptionKey = await loadEncryptionKey(config.encryptionKeyPath);
  config.prefix = resolvePrefix(config.prefix, encryptionKey);

  const raw = makeBackend({ ...config, prefix: config.prefix });
  const backend = encryptionKey !== undefined
    ? new EncryptedBackend(raw, encryptionKey)
    : raw;
  await backend.init();
  return {
    backend,
    encryptionKey,
    daemonUrl: config.hydraDaemonUrl,
    daemonToken: config.hydraToken,
    hydraHome: config.hydraHome,
  };
}

function hydraHomeFromEnv(): string {
  return process.env.HYDRA_ACP_HOME ?? resolve(homedir(), ".hydra-acp");
}

interface CachedMeta {
  modifiedAt: string;
  uploadedAt?: string;
  uploadedByHost?: string;
  uploadedByUser?: string;
  bundleHash?: string;
  agentId?: string;
  cwd?: string;
  title?: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CachedMeta>;
}

async function loadCache(hydraHome: string): Promise<Map<string, CachedMeta>> {
  const p = resolve(hydraHome, "archiver-restore-cache.json");
  try {
    const text = await readFile(p, "utf8");
    const parsed = JSON.parse(text) as CacheFile;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") return new Map();
    return new Map(Object.entries(parsed.entries));
  } catch {
    return new Map();
  }
}

async function saveCache(
  hydraHome: string,
  cache: Map<string, CachedMeta>,
): Promise<void> {
  const p = resolve(hydraHome, "archiver-restore-cache.json");
  const body: CacheFile = { version: 1, entries: Object.fromEntries(cache) };
  await writeFile(p, JSON.stringify(body));
}

function applyCache(row: Row, cached: CachedMeta): void {
  row.uploadedAt = cached.uploadedAt;
  row.uploadedByHost = cached.uploadedByHost;
  row.uploadedByUser = cached.uploadedByUser;
  row.bundleHash = cached.bundleHash;
  if (cached.agentId !== undefined) row.agentId = cached.agentId;
  if (cached.cwd !== undefined) row.cwd = cached.cwd;
  if (cached.title !== undefined) row.title = cached.title;
}

function rowToCached(row: Row): CachedMeta {
  const out: CachedMeta = { modifiedAt: row.modifiedAt };
  if (row.uploadedAt !== undefined) out.uploadedAt = row.uploadedAt;
  if (row.uploadedByHost !== undefined) out.uploadedByHost = row.uploadedByHost;
  if (row.uploadedByUser !== undefined) out.uploadedByUser = row.uploadedByUser;
  if (row.bundleHash !== undefined) out.bundleHash = row.bundleHash;
  if (row.agentId !== undefined) out.agentId = row.agentId;
  if (row.cwd !== undefined) out.cwd = row.cwd;
  if (row.title !== undefined) out.title = row.title;
  return out;
}

interface Row {
  lineageId: string;
  key: string;
  host: string | undefined;
  size: number;
  modifiedAt: string;
  uploadedAt?: string;
  uploadedByHost?: string;
  uploadedByUser?: string;
  bundleHash?: string;
  agentId?: string;
  cwd?: string;
  title?: string;
  localSessionId?: string;
}

function fillFromLocal(row: Row, meta: LocalSessionMeta): void {
  row.localSessionId = meta.sessionId;
  if (row.agentId === undefined && meta.agentId !== undefined) row.agentId = meta.agentId;
  if (row.cwd === undefined && meta.cwd !== undefined) row.cwd = meta.cwd;
  if (row.title === undefined && meta.title !== undefined) row.title = meta.title;
}

function toRow(entry: SyncBackendEntry): Row {
  const { host } = splitKey(entry.key);
  const lineageId = lineageFromKey(entry.key) ?? entry.key;
  return {
    lineageId,
    key: entry.key,
    host,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  };
}

async function hydrateRow(backend: SyncBackend, row: Row): Promise<void> {
  const plaintext = await backend.get(row.key);
  const envelope = deserialize(plaintext);
  row.uploadedAt = envelope.uploadedAt;
  row.uploadedByHost = envelope.uploadedBy.host;
  row.uploadedByUser = envelope.uploadedBy.user;
  row.bundleHash = envelope.bundleHash;
  const session = readSession(envelope.bundle);
  if (session) {
    if (typeof session.agentId === "string") row.agentId = session.agentId;
    if (typeof session.cwd === "string") row.cwd = session.cwd;
    if (typeof session.title === "string") row.title = session.title;
  }
}

function readSession(bundle: unknown): Record<string, unknown> | undefined {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return undefined;
  const s = (bundle as Record<string, unknown>).session;
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  return s as Record<string, unknown>;
}

// ── restore list ────────────────────────────────────────────────────────────

export interface RestoreListArgs {
  host?: string;
  agent?: string;
  cwd?: string;
  grep?: string;
  since?: string;
  limit: number;
  fast: boolean;
  json: boolean;
  onlyRemote: boolean;
  onlyLocal: boolean;
}

export function parseListArgs(argv: string[]): RestoreListArgs {
  const out: RestoreListArgs = {
    limit: 50,
    fast: false,
    json: false,
    onlyRemote: false,
    onlyLocal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--host") out.host = next();
    else if (a === "--agent") out.agent = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--grep") out.grep = next();
    else if (a === "--since") out.since = next();
    else if (a === "--limit") out.limit = Number.parseInt(next(), 10);
    else if (a === "--fast") out.fast = true;
    else if (a === "--json") out.json = true;
    else if (a === "--only-remote") out.onlyRemote = true;
    else if (a === "--only-local") out.onlyLocal = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (out.onlyRemote && out.onlyLocal) {
    throw new Error("--only-remote and --only-local are mutually exclusive");
  }
  if (!Number.isFinite(out.limit) || out.limit <= 0) out.limit = 50;
  return out;
}

function parseSince(spec: string): Date {
  const m = /^(\d+)([smhdw])$/.exec(spec.trim());
  if (m) {
    const n = Number.parseInt(m[1] as string, 10);
    const unit = m[2] as string;
    const mult =
      unit === "s" ? 1000 :
      unit === "m" ? 60_000 :
      unit === "h" ? 3_600_000 :
      unit === "d" ? 86_400_000 :
      604_800_000;
    return new Date(Date.now() - n * mult);
  }
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`--since: unrecognized value ${spec} (use e.g. 7d or an ISO date)`);
  }
  return d;
}

function pad(s: string, n: number): string {
  const w = [...s].length;
  return w >= n ? s : s + " ".repeat(n - w);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

function relTime(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const day = 86_400_000;
  if (abs < 60_000) return "<1m";
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m`;
  if (abs < day) return `${Math.floor(abs / 3_600_000)}h`;
  if (abs < 30 * day) return `${Math.floor(abs / day)}d`;
  if (abs < 365 * day) return `${Math.floor(abs / (30 * day))}mo`;
  return `${Math.floor(abs / (365 * day))}y`;
}

function collapseHome(p: string | undefined): string {
  if (!p) return "";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

export async function runRestoreList(args: RestoreListArgs): Promise<void> {
  const { backend, encryptionKey, hydraHome } = await setupBackend({ requireToken: false });
  const [entries, localIndex, cache] = await Promise.all([
    backend.list(),
    loadLocalIndex(hydraHome),
    loadCache(hydraHome),
  ]);

  const filtered: Row[] = [];
  for (const entry of entries) {
    const row = toRow(entry);
    if (!row.lineageId.startsWith(LINEAGE_PREFIX)) continue;
    if (args.host !== undefined && row.host !== args.host) continue;
    const localMeta = localIndex.get(row.lineageId);
    if (localMeta) fillFromLocal(row, localMeta);
    if (args.onlyRemote && localMeta) continue;
    if (args.onlyLocal && !localMeta) continue;
    const cached = cache.get(row.key);
    if (cached && cached.modifiedAt === row.modifiedAt) applyCache(row, cached);
    filtered.push(row);
  }
  // Newest first by Drive's modifiedTime (cheap; overridden by uploadedAt
  // once we've hydrated).
  filtered.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const sinceCutoff = args.since !== undefined ? parseSince(args.since).toISOString() : undefined;

  let rows: Row[] = filtered;
  const fast = args.fast || encryptionKey === undefined;
  if (!fast) {
    const hydrated: Row[] = [];
    const CONCURRENCY = 8;
    let processed = 0;
    const showProgress = process.stderr.isTTY && filtered.length > 50;
    const matches = (row: Row): boolean => {
      if (sinceCutoff !== undefined && (row.uploadedAt ?? row.modifiedAt) < sinceCutoff) return false;
      if (args.agent !== undefined && row.agentId !== args.agent) return false;
      if (args.cwd !== undefined && !(row.cwd ?? "").includes(args.cwd)) return false;
      if (args.grep !== undefined) {
        const needle = args.grep.toLowerCase();
        if (!(row.title ?? "").toLowerCase().includes(needle)) return false;
      }
      return true;
    };
    let cacheDirty = 0;
    const flushCache = async (): Promise<void> => {
      if (cacheDirty === 0) return;
      await saveCache(hydraHome, cache).catch((err) =>
        log.warn(`saving cache failed: ${(err as Error).message}`),
      );
      cacheDirty = 0;
    };
    outer: for (let i = 0; i < filtered.length; i += CONCURRENCY) {
      const batch = filtered.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (row) => {
          if (row.localSessionId !== undefined) return { ok: true as const, row };
          if (cache.has(row.key) && cache.get(row.key)!.modifiedAt === row.modifiedAt && row.uploadedAt !== undefined) {
            return { ok: true as const, row };
          }
          try {
            await hydrateRow(backend, row);
            cache.set(row.key, rowToCached(row));
            cacheDirty += 1;
            return { ok: true as const, row };
          } catch (err) {
            log.warn(`skipping ${row.key}: ${(err as Error).message}`);
            return { ok: false as const, row };
          }
        }),
      );
      if (cacheDirty >= 32) await flushCache();
      for (const s of settled) {
        processed += 1;
        if (!s.ok) continue;
        if (!matches(s.row)) continue;
        hydrated.push(s.row);
        if (hydrated.length >= args.limit) break outer;
      }
      if (showProgress) {
        process.stderr.write(`\rhydrated ${processed}/${filtered.length} (${hydrated.length} matches)`);
      }
    }
    if (showProgress) process.stderr.write("\r\x1b[K");
    await flushCache();
    hydrated.sort((a, b) =>
      (b.uploadedAt ?? b.modifiedAt).localeCompare(a.uploadedAt ?? a.modifiedAt),
    );
    rows = hydrated;
  } else {
    if (sinceCutoff !== undefined) {
      rows = rows.filter((r) => r.modifiedAt >= sinceCutoff);
    }
    if (args.agent !== undefined || args.cwd !== undefined || args.grep !== undefined) {
      process.stderr.write(
        "note: --agent/--cwd/--grep are ignored in --fast mode (they need decryption)\n",
      );
    }
    rows = rows.slice(0, args.limit);
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        rows.map((r) => ({
          lineageId: r.lineageId,
          host: r.host,
          agentId: r.agentId,
          uploadedAt: r.uploadedAt ?? r.modifiedAt,
          uploadedBy: r.uploadedByHost,
          title: r.title,
          cwd: r.cwd,
          size: r.size,
          bundleHash: r.bundleHash,
          key: r.key,
          localSessionId: r.localSessionId,
        })),
        null,
        2,
      ) + "\n",
    );
    return;
  }

  if (rows.length === 0) {
    process.stderr.write("no bundles found\n");
    return;
  }

  if (fast) {
    const header = `${pad("LINEAGE", 24)}  ${pad("HOST", 20)}  ${pad("AGE", 6)}  ${pad("SIZE", 8)}  KEY\n`;
    process.stdout.write(header);
    for (const r of rows) {
      const line = [
        pad(truncate(shortLineage(r.lineageId), 24), 24),
        pad(truncate(r.host ?? "", 20), 20),
        pad(relTime(r.modifiedAt), 6),
        pad(String(r.size), 8),
        r.key,
      ].join("  ") + "\n";
      process.stdout.write(line);
    }
    return;
  }

  const header = `${pad("LINEAGE", 24)}  ${pad("HOST", 16)}  ${pad("AGENT", 14)}  ${pad("AGE", 6)}  ${pad("LOCAL", 5)}  ${pad("CWD", 32)}  TITLE\n`;
  process.stdout.write(header);
  let localCount = 0;
  for (const r of rows) {
    if (r.localSessionId !== undefined) localCount += 1;
    const line = [
      pad(truncate(shortLineage(r.lineageId), 24), 24),
      pad(truncate(r.uploadedByHost ?? r.host ?? "", 16), 16),
      pad(truncate(r.agentId ?? "", 14), 14),
      pad(relTime(r.uploadedAt ?? r.modifiedAt), 6),
      pad(r.localSessionId !== undefined ? "yes" : "no", 5),
      pad(truncate(collapseHome(r.cwd), 32), 32),
      truncate(r.title ?? "", 80),
    ].join("  ") + "\n";
    process.stdout.write(line);
  }
  const summary: string[] = [];
  if (rows.length === args.limit) summary.push(`showing ${rows.length}; pass --limit to see more`);
  if (localCount > 0 && !args.onlyLocal) {
    summary.push(`${localCount}/${rows.length} already local (use --only-remote to hide)`);
  }
  if (summary.length > 0) process.stderr.write(`(${summary.join("; ")})\n`);
}

// ── restore pull ────────────────────────────────────────────────────────────

export interface RestorePullArgs {
  identifier: string;
  host?: string;
  to?: string;
  doImport: boolean;
  replace: boolean;
  cwd?: string;
  force: boolean;
}

export function parsePullArgs(argv: string[]): RestorePullArgs {
  let identifier: string | undefined;
  const out: Omit<RestorePullArgs, "identifier"> = {
    doImport: false,
    replace: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--host") out.host = next();
    else if (a === "--to") out.to = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--import") out.doImport = true;
    else if (a === "--no-replace") out.replace = false;
    else if (a === "--force") out.force = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else if (identifier === undefined) identifier = a;
    else throw new Error(`unexpected positional: ${a}`);
  }
  if (identifier === undefined) {
    throw new Error("restore pull: missing <lineageId>");
  }
  return { identifier, ...out };
}

export async function runRestorePull(args: RestorePullArgs): Promise<void> {
  const wanted = normalizeLineageId(args.identifier);

  if (!args.force) {
    const localIndex = await loadLocalIndex(hydraHomeFromEnv());
    const local = localIndex.get(wanted);
    if (local) {
      process.stderr.write(
        `lineage ${shortLineage(wanted)} is already local as ${local.sessionId}${
          local.title ? ` (${local.title})` : ""
        }\n`,
      );
      process.stderr.write(
        `use --force to fetch from remote anyway (e.g. to overwrite the local copy)\n`,
      );
      process.stdout.write(local.sessionId + "\n");
      return;
    }
  }

  const { backend, daemonUrl, daemonToken } = await setupBackend({
    requireToken: args.doImport,
  });

  const entries = await backend.list();
  const matches: SyncBackendEntry[] = [];
  for (const entry of entries) {
    if (lineageFromKey(entry.key) !== wanted) continue;
    if (args.host !== undefined) {
      const { host } = splitKey(entry.key);
      if (host !== args.host) continue;
    }
    matches.push(entry);
  }

  if (matches.length === 0) {
    throw new Error(
      `no bundle found for lineage ${shortLineage(wanted)}${
        args.host !== undefined ? ` (host=${args.host})` : ""
      }`,
    );
  }
  matches.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const chosen = matches[0] as SyncBackendEntry;
  if (matches.length > 1) {
    process.stderr.write(
      `${matches.length} copies for ${shortLineage(wanted)}; picking newest (${chosen.key}, modifiedAt=${chosen.modifiedAt})\n`,
    );
  }

  const plaintext = await backend.get(chosen.key);
  const envelope = deserialize(plaintext);
  const bundle = envelope.bundle as SessionBundle;

  process.stderr.write(
    `lineage=${shortLineage(envelope.lineageId)} uploadedBy=${envelope.uploadedBy.host} uploadedAt=${envelope.uploadedAt} hash=${envelope.bundleHash}\n`,
  );

  if (args.doImport) {
    const daemon = new DaemonClient({ daemonUrl, token: daemonToken });
    const importOpts: { replace: boolean; cwd?: string } = { replace: args.replace };
    if (args.cwd !== undefined) importOpts.cwd = args.cwd;
    const result = await daemon.importBundle(bundle, importOpts);
    process.stdout.write(
      `imported ${result.sessionId} (lineage=${shortLineage(envelope.lineageId)})\n`,
    );
    return;
  }

  const bundleJson = JSON.stringify(bundle);
  if (args.to === undefined || args.to === "-") {
    process.stdout.write(bundleJson);
    if (process.stdout.isTTY) process.stdout.write("\n");
    return;
  }
  await writeFile(args.to, bundleJson);
  process.stderr.write(`wrote ${args.to}\n`);
}

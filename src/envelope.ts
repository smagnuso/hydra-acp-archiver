import { createHash } from "node:crypto";

export const SYNC_VERSION = 1;

export interface HostInfo {
  host: string;
  user: string;
}

export interface SyncEnvelope {
  syncVersion: number;
  lineageId: string;
  uploadedAt: string;
  uploadedBy: HostInfo;
  bundleHash: string;
  bundle: unknown;
}

// Canonical JSON for hashing: object keys sorted recursively. Arrays are
// left in order — the bundle's `history` array is order-significant.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}

export function hashBundle(bundle: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalize(bundle)).digest("hex");
}

export function wrap(
  bundle: unknown,
  lineageId: string,
  host: HostInfo,
  now: Date = new Date(),
): SyncEnvelope {
  return {
    syncVersion: SYNC_VERSION,
    lineageId,
    uploadedAt: now.toISOString(),
    uploadedBy: host,
    bundleHash: hashBundle(bundle),
    bundle,
  };
}

export function unwrap(raw: unknown): SyncEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("envelope: expected JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (r.syncVersion !== SYNC_VERSION) {
    throw new Error(
      `envelope: unsupported syncVersion ${String(r.syncVersion)}; expected ${SYNC_VERSION}`,
    );
  }
  if (typeof r.lineageId !== "string" || !r.lineageId) {
    throw new Error("envelope: missing lineageId");
  }
  if (typeof r.uploadedAt !== "string" || !r.uploadedAt) {
    throw new Error("envelope: missing uploadedAt");
  }
  if (typeof r.bundleHash !== "string" || !r.bundleHash) {
    throw new Error("envelope: missing bundleHash");
  }
  const by = r.uploadedBy as Record<string, unknown> | undefined;
  if (
    !by ||
    typeof by.host !== "string" ||
    typeof by.user !== "string"
  ) {
    throw new Error("envelope: missing uploadedBy.{host,user}");
  }
  return {
    syncVersion: SYNC_VERSION,
    lineageId: r.lineageId,
    uploadedAt: r.uploadedAt,
    uploadedBy: { host: by.host, user: by.user },
    bundleHash: r.bundleHash,
    bundle: r.bundle,
  };
}

export function serialize(envelope: SyncEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function deserialize(data: Buffer | string): SyncEnvelope {
  const text = typeof data === "string" ? data : data.toString("utf8");
  return unwrap(JSON.parse(text));
}

export function keyFor(lineageId: string): string {
  return `${lineageId}.hydra.sync`;
}

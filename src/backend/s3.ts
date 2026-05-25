import { createHash, createHmac } from "node:crypto";
import { loadAwsCredentials, resolveRegion, type AwsCredentials } from "../util/aws-credentials.js";
import { logger } from "../util/log.js";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const log = logger("backend.s3");

export interface S3BackendOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix: string;
}

// ── Signature V4 ─────────────────────────────────────────────────────────────

function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

function isoDateTime(): { datetime: string; date: string } {
  const now = new Date();
  const datetime = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return { datetime, date: datetime.slice(0, 8) };
}

function buildAuthHeaders(
  method: string,
  url: URL,
  body: Buffer | undefined,
  creds: AwsCredentials,
  region: string,
): Record<string, string> {
  const { datetime, date } = isoDateTime();
  const bodyHash = sha256hex(body ?? Buffer.alloc(0));

  const toSign: Array<[string, string]> = [
    ["host", url.host],
    ["x-amz-content-sha256", bodyHash],
    ["x-amz-date", datetime],
  ];
  if (creds.sessionToken)
    toSign.push(["x-amz-security-token", creds.sessionToken]);
  toSign.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = toSign.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
  const signedHeaderNames = toSign.map(([k]) => k).join(";");

  const canonicalQuery = [...url.searchParams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    bodyHash,
  ].join("\n");

  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, date, region))
    .update(stringToSign)
    .digest("hex");

  const result: Record<string, string> = {
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": datetime,
  };
  if (creds.sessionToken)
    result["x-amz-security-token"] = creds.sessionToken;
  return result;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

// Encode each path segment individually, preserving slashes between them.
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function buildUrl(
  bucket: string,
  keyPath: string, // leading slash, empty for bucket root ("/" or "/key")
  query: Record<string, string>,
  region: string,
  endpoint?: string,
): URL {
  const base =
    endpoint !== undefined
      ? `${endpoint.replace(/\/$/, "")}/${bucket}` // path-style for custom endpoints
      : `https://${bucket}.s3.${region}.amazonaws.com`; // virtual-hosted for AWS
  const url = new URL(`${base}${keyPath}`);
  for (const [k, v] of Object.entries(query))
    url.searchParams.set(k, v);
  return url;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function xmlFirst(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m || m[1] === undefined) return undefined;
  return m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

interface S3Object { key: string; size: number; modifiedAt: string }

function parseContents(xml: string): S3Object[] {
  const out: S3Object[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    if (block === undefined) continue;
    const key = xmlFirst(block, "Key");
    if (!key) continue;
    out.push({
      key,
      size: Number.parseInt(xmlFirst(block, "Size") ?? "0", 10),
      modifiedAt: xmlFirst(block, "LastModified") ?? new Date(0).toISOString(),
    });
  }
  return out;
}

// ── HTTP request ─────────────────────────────────────────────────────────────

async function s3Fetch(
  method: string,
  url: URL,
  body: Buffer | undefined,
  creds: AwsCredentials,
  region: string,
): Promise<Response> {
  const headers = buildAuthHeaders(method, url, body, creds, region);
  if (body !== undefined)
    headers["content-length"] = String(body.length);
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = xmlFirst(text, "Code") ?? String(res.status);
    const msg = xmlFirst(text, "Message") ?? res.statusText;
    throw new Error(`s3: ${method} ${url.pathname} — ${code}: ${msg}`);
  }
  return res;
}

// ── Backend ───────────────────────────────────────────────────────────────────

export class S3Backend implements SyncBackend {
  private credentials: AwsCredentials | undefined;
  private readonly region: string;
  private readonly prefix: string;

  constructor(private readonly opts: S3BackendOptions) {
    this.region = resolveRegion(opts.region);
    this.prefix = opts.prefix;
  }

  async init(): Promise<void> {
    this.credentials = loadAwsCredentials();
    await s3Fetch(
      "HEAD",
      buildUrl(this.opts.bucket, "/", {}, this.region, this.opts.endpoint),
      undefined,
      this.credentials,
      this.region,
    );
    log.info(
      `s3 backend ready: bucket=${this.opts.bucket}${this.prefix !== "" ? ` prefix="${this.prefix}"` : ""}`,
    );
  }

  async list(): Promise<SyncBackendEntry[]> {
    const creds = this.requireCredentials();
    const entries: SyncBackendEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2" };
      if (this.prefix !== "") query["prefix"] = this.prefix;
      if (continuationToken !== undefined)
        query["continuation-token"] = continuationToken;
      const url = buildUrl(this.opts.bucket, "/", query, this.region, this.opts.endpoint);
      const xml = await (await s3Fetch("GET", url, undefined, creds, this.region)).text();
      for (const obj of parseContents(xml)) {
        entries.push({
          key: this.prefix !== "" ? obj.key.slice(this.prefix.length) : obj.key,
          size: obj.size,
          modifiedAt: obj.modifiedAt,
        });
      }
      continuationToken =
        xmlFirst(xml, "IsTruncated") === "true"
          ? xmlFirst(xml, "NextContinuationToken")
          : undefined;
    } while (continuationToken !== undefined);
    return entries;
  }

  async get(key: string): Promise<Buffer> {
    const creds = this.requireCredentials();
    const url = buildUrl(
      this.opts.bucket,
      `/${encodePath(this.prefix + key)}`,
      {},
      this.region,
      this.opts.endpoint,
    );
    return Buffer.from(await (await s3Fetch("GET", url, undefined, creds, this.region)).arrayBuffer());
  }

  async put(key: string, data: Buffer): Promise<void> {
    const creds = this.requireCredentials();
    await s3Fetch(
      "PUT",
      buildUrl(this.opts.bucket, `/${encodePath(this.prefix + key)}`, {}, this.region, this.opts.endpoint),
      data,
      creds,
      this.region,
    );
  }

  async delete(key: string): Promise<void> {
    const creds = this.requireCredentials();
    await s3Fetch(
      "DELETE",
      buildUrl(this.opts.bucket, `/${encodePath(this.prefix + key)}`, {}, this.region, this.opts.endpoint),
      undefined,
      creds,
      this.region,
    );
  }

  private requireCredentials(): AwsCredentials {
    if (!this.credentials)
      throw new Error("S3Backend used before init()");
    return this.credentials;
  }
}

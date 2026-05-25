import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { logger } from "../util/log.js";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const log = logger("backend.s3");

export interface S3BackendOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix: string;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

export class S3Backend implements SyncBackend {
  private client: S3Client | undefined;
  private readonly prefix: string;

  constructor(private readonly opts: S3BackendOptions) {
    this.prefix = opts.prefix;
  }

  async init(): Promise<void> {
    this.client = new S3Client({
      ...(this.opts.region !== undefined ? { region: this.opts.region } : {}),
      ...(this.opts.endpoint !== undefined
        ? { endpoint: this.opts.endpoint, forcePathStyle: true }
        : {}),
    });
    await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
    log.info(
      `s3 backend ready: bucket=${this.opts.bucket}${this.prefix !== "" ? ` prefix="${this.prefix}"` : ""}`,
    );
  }

  async list(): Promise<SyncBackendEntry[]> {
    const client = this.requireClient();
    const entries: SyncBackendEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await client.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          ...(this.prefix !== "" ? { Prefix: this.prefix } : {}),
          ...(continuationToken !== undefined
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key)
          continue;
        entries.push({
          key: this.prefix !== "" ? obj.Key.slice(this.prefix.length) : obj.Key,
          size: obj.Size ?? 0,
          modifiedAt: (obj.LastModified ?? new Date(0)).toISOString(),
        });
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken !== undefined);
    return entries;
  }

  async get(key: string): Promise<Buffer> {
    const client = this.requireClient();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.prefix + key }),
    );
    if (!res.Body)
      throw new Error(`s3: empty body for key ${key}`);
    return streamToBuffer(res.Body as Readable);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const client = this.requireClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.prefix + key,
        Body: data,
        ContentType: "application/octet-stream",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    const client = this.requireClient();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.prefix + key }),
    );
  }

  private requireClient(): S3Client {
    if (!this.client)
      throw new Error("S3Backend used before init()");
    return this.client;
  }
}

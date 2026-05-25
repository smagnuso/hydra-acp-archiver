import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const VERSION = 1;
const VERSION_LEN = 1;
const FINGERPRINT_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;
// Offset to the start of ciphertext within a blob.
const HEADER_LEN = VERSION_LEN + FINGERPRINT_LEN + IV_LEN;

export class EncryptedBackend implements SyncBackend {
  private readonly keyFingerprint: Buffer;

  constructor(
    private readonly inner: SyncBackend,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error("encryption key must be 32 bytes");
    this.keyFingerprint = createHash("sha256").update(key).digest().subarray(0, FINGERPRINT_LEN);
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  list(): Promise<SyncBackendEntry[]> {
    return this.inner.list();
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    await this.inner.put(
      key,
      Buffer.concat([Buffer.from([VERSION]), this.keyFingerprint, iv, ciphertext, tag]),
    );
  }

  async get(key: string): Promise<Buffer> {
    const blob = await this.inner.get(key);
    if (blob.length < HEADER_LEN + TAG_LEN)
      throw new Error(`encrypted blob too short for key ${key}`);

    const version = blob[0];
    if (version !== VERSION)
      throw new Error(`unsupported encryption version ${version} for key ${key}: upgrade the archiver`);

    const fingerprint = blob.subarray(VERSION_LEN, VERSION_LEN + FINGERPRINT_LEN);
    if (!fingerprint.equals(this.keyFingerprint))
      throw new Error(`key mismatch: blob ${key} was encrypted with a different key`);

    const iv = blob.subarray(VERSION_LEN + FINGERPRINT_LEN, HEADER_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ciphertext = blob.subarray(HEADER_LEN, blob.length - TAG_LEN);

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error(`blob ${key} failed authentication — data may be corrupted`);
    }
  }
}

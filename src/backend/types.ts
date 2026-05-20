export interface SyncBackendEntry {
  key: string;
  size: number;
  modifiedAt: string;
}

// The contract every storage backend has to satisfy. Designed around
// blob-store primitives so Google Drive, S3, Dropbox, plain fs, etc.
// can all implement it without leaking backend-specific concerns.
export interface SyncBackend {
  // Backend-specific one-time setup: auth, folder creation, etc.
  // Idempotent — safe to call repeatedly.
  init(): Promise<void>;
  list(): Promise<SyncBackendEntry[]>;
  get(key: string): Promise<Buffer>;
  // Upsert semantics: write or overwrite at this key.
  put(key: string, data: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
}

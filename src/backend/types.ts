export interface SyncBackendEntry {
  key: string;
  size: number;
  modifiedAt: string;
}

// The contract every storage backend has to satisfy. Designed around
// blob-store primitives so Google Drive, S3, Dropbox, plain fs, etc.
// can all implement it without leaking backend-specific concerns.
//
// Prefix convention: backends accept an optional prefix in their constructor
// options and apply it internally to every key. list() returns bare keys with
// the prefix stripped; get/put/delete receive bare keys and prepend the prefix
// before touching storage. Callers never see or supply the prefix — it is
// purely a storage-layer namespace. Each backend decides the joining semantics:
//   S3          — prefix is prepended to the object key; ListObjectsV2 filters
//                 server-side (efficient on large buckets).
//   fs          — prefix is resolved as a subdirectory of the base dir.
//   Google Drive — prefix is prepended to the Drive filename (Drive has no
//                 native directory structure within a folder).
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

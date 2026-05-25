import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { loadGoogleAuth } from "../oauth/google.js";
import { logger } from "../util/log.js";
import type { SyncBackend, SyncBackendEntry } from "./types.js";

const log = logger("backend.google-drive");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_MIME = "application/json";

export interface GoogleDriveBackendOptions {
  credentialsPath: string;
  tokenPath: string;
  folderName: string;
  prefix: string;
}

// Drive-backed implementation. Uses the drive.file scope, which limits
// visibility to files the app created plus those explicitly handed to
// it — so the archiver never sees the user's other Drive contents.
//
// The prefix is resolved into real Drive subfolders on init(). A prefix
// of "a1b2c3d4/alice-macbook/" creates:
//   hydra-acp-archive/
//     a1b2c3d4/
//       alice-macbook/
//         <lineageId>.hydra.archive
//
// list() recurses into all immediate subfolders of the prefix folder so the
// sync backend (prefix = "user/") can see files from all host subfolders.
export class GoogleDriveBackend implements SyncBackend {
  private drive: drive_v3.Drive | undefined;
  // The Drive folder ID corresponding to the resolved prefix path.
  private prefixFolderId: string | undefined;

  constructor(private readonly opts: GoogleDriveBackendOptions) {}

  async init(): Promise<void> {
    const auth = await loadGoogleAuth({
      credentialsPath: this.opts.credentialsPath,
      tokenPath: this.opts.tokenPath,
    });
    this.drive = google.drive({ version: "v3", auth });

    // Walk the root folder name + each prefix segment, ensuring each exists.
    let currentId = await this.ensureFolder(this.opts.folderName, undefined);
    const segments = this.opts.prefix
      .split("/")
      .filter((s) => s !== "");
    for (const seg of segments) {
      currentId = await this.ensureFolder(seg, currentId);
    }
    this.prefixFolderId = currentId;

    log.info(
      `google-drive backend ready: folder="${this.opts.folderName}" prefix="${this.opts.prefix}" id=${this.prefixFolderId}`,
    );
  }

  async list(): Promise<SyncBackendEntry[]> {
    return this.listFolder(this.requirePrefixFolderId(), "");
  }

  async get(key: string): Promise<Buffer> {
    const drive = this.requireDrive();
    const { parentId, name } = await this.resolveKey(key);
    const fileId = await this.findFileId(name, parentId);
    if (!fileId) {
      throw new Error(`google-drive: no file named ${key}`);
    }
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const drive = this.requireDrive();
    const { parentId, name } = await this.resolveKey(key);
    const existing = await this.findFileId(name, parentId);
    const media = { mimeType: FILE_MIME, body: Readable.from(data) };
    if (existing) {
      await drive.files.update({ fileId: existing, media });
      return;
    }
    await drive.files.create({
      requestBody: { name, mimeType: FILE_MIME, parents: [parentId] },
      media,
      fields: "id",
    });
  }

  async delete(key: string): Promise<void> {
    const { parentId, name } = await this.resolveKey(key);
    const fileId = await this.findFileId(name, parentId);
    if (!fileId)
      return;
    // Trash rather than hard-delete — recoverable for 30 days.
    await this.requireDrive().files.update({
      fileId,
      requestBody: { trashed: true },
    });
  }

  private requireDrive(): drive_v3.Drive {
    if (!this.drive)
      throw new Error("GoogleDriveBackend used before init()");
    return this.drive;
  }

  private requirePrefixFolderId(): string {
    if (!this.prefixFolderId)
      throw new Error("GoogleDriveBackend used before init()");
    return this.prefixFolderId;
  }

  // Resolve a key that may contain a host subdirectory segment
  // (e.g. "alice-macbook/uuid.hydra.archive") into a (parentId, filename)
  // pair, creating intermediate folders as needed.
  private async resolveKey(key: string): Promise<{ parentId: string; name: string }> {
    const parts = key.split("/");
    const name = parts[parts.length - 1] as string;
    let parentId = this.requirePrefixFolderId();
    for (const seg of parts.slice(0, -1)) {
      parentId = await this.ensureFolder(seg, parentId);
    }
    return { parentId, name };
  }

  // Recursive list: returns files in folderId and all immediate subfolders,
  // with keys relative to folderId (e.g. "alice-macbook/uuid.hydra.archive").
  private async listFolder(folderId: string, relPath: string): Promise<SyncBackendEntry[]> {
    const drive = this.requireDrive();
    const entries: SyncBackendEntry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, size, modifiedTime, mimeType)",
        spaces: "drive",
        pageSize: 200,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const f of res.data.files ?? []) {
        if (!f.name)
          continue;
        const entryRel = relPath !== "" ? `${relPath}/${f.name}` : f.name;
        if (f.mimeType === FOLDER_MIME) {
          entries.push(...await this.listFolder(f.id!, entryRel));
        } else {
          entries.push({
            key: entryRel,
            size: typeof f.size === "string" ? Number.parseInt(f.size, 10) : 0,
            modifiedAt: f.modifiedTime ?? new Date(0).toISOString(),
          });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return entries;
  }

  // Ensure a folder with the given name exists under parentId (or at root if
  // parentId is undefined). Returns the folder's Drive ID.
  private async ensureFolder(name: string, parentId: string | undefined): Promise<string> {
    const drive = this.requireDrive();
    const escaped = name.replace(/'/g, "\\'");
    const parentClause = parentId !== undefined
      ? `'${parentId}' in parents and `
      : "";
    const res = await drive.files.list({
      q: `${parentClause}name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 10,
    });
    const existing = res.data.files?.[0];
    if (existing?.id)
      return existing.id;
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
        ...(parentId !== undefined ? { parents: [parentId] } : {}),
      },
      fields: "id",
    });
    if (!created.data.id)
      throw new Error("google-drive: folder create returned no id");
    log.info(`created Drive folder "${name}" id=${created.data.id}`);
    return created.data.id;
  }

  private async findFileId(name: string, parentId: string): Promise<string | undefined> {
    const drive = this.requireDrive();
    const escaped = name.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name = '${escaped}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 2,
    });
    return res.data.files?.[0]?.id ?? undefined;
  }
}

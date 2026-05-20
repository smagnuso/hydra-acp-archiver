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
}

// Drive-backed implementation. Uses the drive.file scope, which limits
// visibility to files the app created plus those explicitly handed to
// it — so the archiver never sees the user's other Drive contents.
export class GoogleDriveBackend implements SyncBackend {
  private drive: drive_v3.Drive | undefined;
  private folderId: string | undefined;

  constructor(private readonly opts: GoogleDriveBackendOptions) {}

  async init(): Promise<void> {
    const auth = await loadGoogleAuth({
      credentialsPath: this.opts.credentialsPath,
      tokenPath: this.opts.tokenPath,
    });
    this.drive = google.drive({ version: "v3", auth });
    this.folderId = await this.ensureFolder(this.opts.folderName);
    log.info(
      `google-drive backend ready: folder="${this.opts.folderName}" id=${this.folderId}`,
    );
  }

  async list(): Promise<SyncBackendEntry[]> {
    const drive = this.requireDrive();
    const parent = this.requireFolderId();
    const entries: SyncBackendEntry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${parent}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, size, modifiedTime)",
        spaces: "drive",
        pageSize: 200,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const f of res.data.files ?? []) {
        if (!f.name) {
          continue;
        }
        entries.push({
          key: f.name,
          size: typeof f.size === "string" ? Number.parseInt(f.size, 10) : 0,
          modifiedAt: f.modifiedTime ?? new Date(0).toISOString(),
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return entries;
  }

  async get(key: string): Promise<Buffer> {
    const drive = this.requireDrive();
    const fileId = await this.findFileId(key);
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
    const parent = this.requireFolderId();
    const existing = await this.findFileId(key);
    const media = {
      mimeType: FILE_MIME,
      body: Readable.from(data),
    };
    if (existing) {
      await drive.files.update({
        fileId: existing,
        media,
      });
      return;
    }
    await drive.files.create({
      requestBody: {
        name: key,
        mimeType: FILE_MIME,
        parents: [parent],
      },
      media,
      fields: "id",
    });
  }

  async delete(key: string): Promise<void> {
    const drive = this.requireDrive();
    const fileId = await this.findFileId(key);
    if (!fileId) {
      return;
    }
    // Trash rather than hard-delete — recoverable for 30 days.
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
    });
  }

  private requireDrive(): drive_v3.Drive {
    if (!this.drive) {
      throw new Error("GoogleDriveBackend used before init()");
    }
    return this.drive;
  }

  private requireFolderId(): string {
    if (!this.folderId) {
      throw new Error("GoogleDriveBackend used before init()");
    }
    return this.folderId;
  }

  private async ensureFolder(name: string): Promise<string> {
    const drive = this.requireDrive();
    const escaped = name.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 10,
    });
    const existing = res.data.files?.[0];
    if (existing?.id) {
      return existing.id;
    }
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
      },
      fields: "id",
    });
    if (!created.data.id) {
      throw new Error("google-drive: folder create returned no id");
    }
    log.info(`created Drive folder "${name}" id=${created.data.id}`);
    return created.data.id;
  }

  private async findFileId(key: string): Promise<string | undefined> {
    const drive = this.requireDrive();
    const parent = this.requireFolderId();
    const escaped = key.replace(/'/g, "\\'");
    const res = await drive.files.list({
      q: `'${parent}' in parents and name = '${escaped}' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 2,
    });
    return res.data.files?.[0]?.id ?? undefined;
  }
}

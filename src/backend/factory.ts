import type { Config } from "../config.js";
import { FsBackend } from "./fs.js";
import { GoogleDriveBackend } from "./google-drive.js";
import { S3Backend } from "./s3.js";
import type { SyncBackend } from "./types.js";

export function makeBackend(config: Config): SyncBackend {
  switch (config.backend) {
    case "fs":
      return new FsBackend({ dir: config.fsDir, prefix: config.prefix });
    case "google-drive":
      return new GoogleDriveBackend({
        credentialsPath: config.credentialsPath,
        tokenPath: config.tokenPath,
        folderName: config.driveFolderName,
        prefix: config.prefix,
      });
    case "s3":
      return new S3Backend({
        bucket: config.s3Bucket,
        region: config.s3Region,
        endpoint: config.s3Endpoint,
        prefix: config.prefix,
      });
    default: {
      const exhaustive: never = config.backend;
      throw new Error(`unknown backend: ${String(exhaustive)}`);
    }
  }
}

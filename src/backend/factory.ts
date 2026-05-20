import type { Config } from "../config.js";
import { FsBackend } from "./fs.js";
import { GoogleDriveBackend } from "./google-drive.js";
import type { SyncBackend } from "./types.js";

export function makeBackend(config: Config): SyncBackend {
  switch (config.backend) {
    case "fs":
      return new FsBackend({ dir: config.fsDir });
    case "google-drive":
      return new GoogleDriveBackend({
        credentialsPath: config.credentialsPath,
        tokenPath: config.tokenPath,
        folderName: config.driveFolderName,
      });
    default: {
      const exhaustive: never = config.backend;
      throw new Error(`unknown backend: ${String(exhaustive)}`);
    }
  }
}

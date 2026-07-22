import { createHash } from "node:crypto";
import { userInfo } from "node:os";

// Resolve the archive-prefix from the configured value + encryption key.
// A configured non-empty prefix wins. Otherwise: fingerprint of the
// encryption key (so peers with the same key land in the same folder)
// or username fallback. Kept in one place so extension mode and the
// restore CLI derive the same value.
export function resolvePrefix(
  configured: string,
  encryptionKey: Buffer | undefined,
): string {
  if (configured !== "") {
    return configured;
  }
  if (encryptionKey !== undefined) {
    return (
      createHash("sha256").update(encryptionKey).digest().subarray(0, 8).toString("hex") + "/"
    );
  }
  return userInfo().username.toLowerCase().replace(/[^a-z0-9-]/g, "-") + "/";
}

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export async function runKeygen(): Promise<void> {
  const keyPath =
    process.env.HYDRA_ACP_ARCHIVER_KEY_PATH ??
    resolve(homedir(), ".hydra-acp", "archiver-key");

  const key = randomBytes(32);
  const hex = key.toString("hex");

  const fingerprint = createHash("sha256")
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString("hex");

  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(keyPath, hex + "\n", { mode: 0o600 });
  await chmod(keyPath, 0o600);

  process.stdout.write(`key written to ${keyPath}\n`);
  process.stdout.write(`key fingerprint: ${fingerprint}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Copy ${keyPath} to every machine that should share this archive.\n`);
  if (!process.env.HYDRA_ACP_ARCHIVER_KEY_PATH) {
    process.stdout.write(
      `Then add to your extension env config:\n  "HYDRA_ACP_ARCHIVER_KEY_PATH": "${keyPath}"\n`,
    );
  }
}

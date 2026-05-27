import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DownloadHit {
  path: string;
  ageMs: number;
}

export function scanDownloadsForGoogleCredentials(maxAgeMs = 60 * 60 * 1000): DownloadHit | undefined {
  const dir = resolve(homedir(), "Downloads");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const now = Date.now();
  let best: DownloadHit | undefined;
  for (const name of entries) {
    if (!name.startsWith("client_secret_") || !name.endsWith(".json"))
      continue;
    const full = resolve(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const age = now - mtimeMs;
    if (age < 0 || age > maxAgeMs)
      continue;
    if (!best || age < best.ageMs)
      best = { path: full, ageMs: age };
  }
  return best;
}

export function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60)
    return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)
    return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

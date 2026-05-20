import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { logger } from "./util/log.js";

const log = logger("rule");

export interface ArchiveEvent {
  sessionId: string;
  lineageId: string;
  meta: {
    cwd?: string;
    agentId?: string;
    title?: string;
  };
}

// Return false to skip archiving this session; any other value
// (including undefined) means archive.
export type RuleFunction = (
  ev: ArchiveEvent,
) => boolean | undefined | Promise<boolean | undefined>;

export const DEFAULT_RULE: RuleFunction = () => true;

let loadCounter = 0;

export async function loadRule(path: string): Promise<RuleFunction> {
  try {
    await stat(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      log.info(
        `no rule config at ${path} — archiving every live session (drop a JS file at that path to opt out specific sessions)`,
      );
      return DEFAULT_RULE;
    }
    log.warn(`stat ${path} failed: ${e.message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
  loadCounter += 1;
  const url = `${pathToFileURL(path).href}?v=${Date.now()}-${loadCounter}`;
  try {
    const mod = (await import(url)) as { default?: unknown };
    const fn = mod.default;
    if (typeof fn !== "function") {
      log.warn(`${path} did not export a default function; using DEFAULT_RULE`);
      return DEFAULT_RULE;
    }
    log.info(`loaded archiver rule from ${path}`);
    return fn as RuleFunction;
  } catch (err) {
    log.warn(`import ${path} failed: ${(err as Error).message}; using DEFAULT_RULE`);
    return DEFAULT_RULE;
  }
}

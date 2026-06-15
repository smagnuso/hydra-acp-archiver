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
    // Tristate from the daemon's session/list view (effectiveInteractive).
    // Sessions that aren't explicitly `true` carry no value worth uploading:
    //   false     — transformer-spawned workers, cat one-shots
    //   undefined — never promoted (empty editor panels, peer imports without
    //               an explicit interactive flag in their bundle)
    // Users who want different behaviour can override via the rule config.
    interactive?: boolean;
  };
}

// Return false to skip archiving this session; any other value
// (including undefined) means archive.
export type RuleFunction = (
  ev: ArchiveEvent,
) => boolean | undefined | Promise<boolean | undefined>;

// Default policy: only archive sessions the daemon considers interactive.
// Drops transformer-spawned workers and never-promoted ancillaries, which
// empirically were the only populations leaking through the daemon's own
// list filter (see audit notes — 45/49 undefined-interactive sessions were
// being uploaded with no clear value, vs 0/111 explicit interactive:false).
export const DEFAULT_RULE: RuleFunction = (ev) => ev.meta.interactive === true;

let loadCounter = 0;

export async function loadRule(path: string): Promise<RuleFunction> {
  try {
    await stat(path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      log.info(
        `no rule config at ${path} — archiving only sessions the daemon marks interactive=true (drop a JS file at that path to customize)`,
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

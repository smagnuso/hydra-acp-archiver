import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { resolveSpawnTarget, type ResolveDeps } from "../util/windows-command.js";

export interface RunHydraDeps extends ResolveDeps {
  spawnSync?: (
    command: string,
    args: string[],
    options: SpawnSyncOptions,
  ) => { status: number | null };
}

export type RunHydraResult =
  | { kind: "exited"; status: number | null }
  | { kind: "unquotable" };

export function runHydraAcp(
  cmdArgs: readonly string[],
  deps: RunHydraDeps = {},
): RunHydraResult {
  let target;
  try {
    target = resolveSpawnTarget("hydra-acp", cmdArgs, deps);
  } catch {
    return { kind: "unquotable" };
  }
  const run = deps.spawnSync ?? spawnSync;
  const result = run(target.command, target.args, {
    stdio: "inherit",
    shell: target.shell,
  });
  return { kind: "exited", status: result.status };
}

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => {
    on(event: "error", listener: (err: Error) => void): unknown;
    unref(): unknown;
  };
}

// Win32 uses rundll32 with no shell: `start` is a cmd builtin and cmd would
// split the URL at the first `&`.
export function openBrowser(
  url: string,
  onFailure: () => void,
  deps: OpenBrowserDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  try {
    if (platform === "win32") {
      const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", onFailure);
      child.unref();
      return;
    }
    const cmd = platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", onFailure);
    child.unref();
  } catch {
    onFailure();
  }
}

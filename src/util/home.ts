// Expand a leading `~`, `~/` or `~\` on user input; `~user` and mid-string tildes are left alone.
export function expandHome(input: string, home: string): string {
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    return home + input.slice(1);
  }
  return input;
}

// Windows shows full paths, never a `~` abbreviation.
export function collapseHome(
  p: string,
  home: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return p;
  }
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

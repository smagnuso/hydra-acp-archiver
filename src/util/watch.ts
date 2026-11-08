import { realpathSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename, resolve } from "node:path";

export interface WatchOptions {
  path: string;
  onChange: () => void;
  // Coalesce bursts of fs events (vim's write-temp-then-rename, editor
  // backup files, etc.) into a single reload.
  debounceMs?: number;
  onError?: (err: Error) => void;
}

export interface WatchHandle {
  stop: () => void;
}

// Watch a config file by watching its parent directory and filtering on
// basename. This survives editors that write a temp file and rename
// over the target (vim, helix, JetBrains); those flip the inode, which
// a direct `fs.watch(path)` would stop tracking. It also gracefully
// handles the file not existing yet at startup: as soon as a matching
// filename appears in the directory, the watcher fires.
//
// Symlinks: inotify on a directory only sees changes to entries in that
// directory; editing the target of a symlink that lives there does not
// touch the symlink itself, so a naive single watcher misses edits
// through the symlink. We resolve the realpath at startup and, when it
// differs from the literal path, watch both parents: the literal one
// to catch the symlink being created/swapped/removed, and the realpath
// one to catch edits to the actual file. If the symlink doesn't exist
// yet we just watch the literal parent and the realpath watcher is
// added later (on the next reload, the caller can recreate us).
// Windows filenames are case-insensitive and fs.watch reports the name as it
// is on disk, so a config typed as `Rule.config.js` and saved as
// `rule.config.js` would otherwise never reload.
function sameFileName(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function watchConfigPath(opts: WatchOptions): WatchHandle {
  const literal = resolve(opts.path);
  let real = literal;
  try {
    real = realpathSync(literal);
  } catch {
    // file doesn't exist yet; watching the literal parent is enough.
  }
  const debounce = opts.debounceMs ?? 200;
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  const trigger = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      opts.onChange();
    }, debounce);
  };
  const armParentWatcher = (filePath: string): void => {
    const dir = dirname(filePath);
    const file = basename(filePath);
    try {
      const w = watch(dir, { persistent: false }, (_event, name) => {
        if (name && sameFileName(name.toString(), file)) {
          trigger();
        }
      });
      if (opts.onError) {
        w.on("error", opts.onError);
      }
      watchers.push(w);
    } catch (err) {
      if (opts.onError) {
        opts.onError(err as Error);
      }
    }
  };
  armParentWatcher(literal);
  if (real !== literal) {
    armParentWatcher(real);
  }
  return {
    stop: (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const w of watchers) {
        w.close();
      }
    },
  };
}

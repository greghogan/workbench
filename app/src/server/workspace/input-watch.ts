import { existsSync, lstatSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { inputStamp } from "../../core/runtime/file-identity.js";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";

/** Share parent discovery among sibling inputs for a single observation. */
export function existingParentResolver(): (path: string) => string {
  const parents = new Map<string, string>();
  return (path) => {
    const parent = dirname(path);
    const known = parents.get(parent);
    if (known !== undefined) return known;
    let directory = parent;
    while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
    parents.set(parent, directory);
    return directory;
  };
}

/** Parent watches survive atomic file replacement; reconciliation also covers missed network-filesystem events. */
export class InputWatch {
  private readonly watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
  private readonly stamps = new Map<string, string>();
  private readonly members = new Map<string, Set<string>>();
  private closed = false;
  private readonly degraded = new Set<string>();
  constructor(private readonly changed: (paths: string[]) => void) {}
  update(paths: Iterable<string>): void {
    if (this.closed) return;
    const selected = new Set(paths);
    for (const path of this.stamps.keys()) if (!selected.has(path)) this.stamps.delete(path);
    this.members.clear();
    const existingParent = existingParentResolver();
    for (const path of selected) {
      if (!this.stamps.has(path)) {
        try {
          this.stamps.set(path, inputStamp(path));
        } catch (error) {
          this.stamps.set(path, "unavailable");
          this.failed(dirname(path), error);
        }
      }
      const directory = existingParent(path);
      const members = this.members.get(directory) ?? new Set<string>();
      members.add(path);
      this.members.set(directory, members);
    }
    for (const directory of this.degraded) if (!this.members.has(directory)) this.degraded.delete(directory);
    for (const [directory, entry] of this.watchers)
      if (!this.members.has(directory) || this.identity(directory) !== entry.identity) {
        entry.watcher.close();
        this.watchers.delete(directory);
      }
    for (const directory of this.members.keys())
      if (!this.watchers.has(directory)) {
        try {
          if (!lstatSync(directory).isDirectory()) continue;
          const watcher = watch(directory, (_event, name) => {
            const paths = this.members.get(directory);
            if (!paths) return;
            const changed = name ? join(directory, name) : undefined;
            const selected = changed
              ? [...paths].filter((path) => path === changed || dirname(path) !== directory)
              : paths;
            this.check(selected);
          });
          watcher.on("error", (error) => {
            this.failed(directory, error);
            watcher.close();
            if (this.watchers.get(directory)?.watcher === watcher) this.watchers.delete(directory);
          });
          this.watchers.set(directory, { watcher, identity: this.identity(directory) });
          if (this.degraded.delete(directory))
            diagnostic(LogLevel.Info, DiagnosticOperation.WorkspaceWatch, DiagnosticOutcome.Recovered, { directory });
        } catch (error) {
          this.failed(directory, error);
        }
      }
  }
  private failed(directory: string, error: unknown): void {
    if (this.closed || this.degraded.has(directory)) return;
    this.degraded.add(directory);
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WorkspaceWatch,
      DiagnosticOutcome.Degraded,
      { directory },
      error,
      "periodic input reconciliation fallback",
    );
  }
  get watcherCount(): number {
    return this.watchers.size;
  }
  private identity(directory: string): string {
    try {
      const stat = lstatSync(directory);
      return `${String(stat.dev)}:${String(stat.ino)}`;
    } catch {
      return "missing";
    }
  }
  private check(paths: Iterable<string>): void {
    const changed: string[] = [];
    for (const path of paths) {
      let stamp: string;
      try {
        stamp = inputStamp(path);
      } catch {
        continue;
      }
      if (this.stamps.get(path) !== stamp) {
        this.stamps.set(path, stamp);
        changed.push(path);
      }
    }
    if (changed.length) this.changed(changed);
  }
  reconcile(): void {
    this.check(this.stamps.keys());
    this.update(this.stamps.keys());
  }
  close(): void {
    this.closed = true;
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.stamps.clear();
    this.members.clear();
    this.degraded.clear();
  }
}

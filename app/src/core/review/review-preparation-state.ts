import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { reviewGit } from "./review-service.js";
import { BoundedState } from "../storage/bounded-state.js";
import { withCacheLockSync } from "../storage/cache-lock.js";
import { validation, type Validation } from "../runtime/validation.js";

export function reviewPreparationPath(root: string): string {
  return resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/review-preparation.json"]).trim());
}
function state(path: string) {
  const check: Validation = validation("Invalid review preparation state");
  return new BoundedState<Record<string, string>>(
    () => path,
    16 * 1024 * 1024,
    (input) => {
      check(input && typeof input === "object" && !Array.isArray(input), "pending", "must be a record");
      for (const [path, token] of Object.entries(input)) {
        check(
          path.length > 0 &&
            !path.startsWith("/") &&
            !path.split("/").includes("..") &&
            !path.includes("\\") &&
            !path.includes("\0"),
          "path",
          "must be project-relative",
        );
        check(
          typeof token === "string" && /^[a-f0-9-]{36}$/.test(token),
          path,
          "must identify its preparation operation",
        );
      }
      return input as Record<string, string>;
    },
    () => ({}),
  );
}
export function pendingRecordOutputs(root: string, observe?: (path: string) => void): ReadonlySet<string> {
  const path = reviewPreparationPath(root);
  observe?.(path);
  return new Set(Object.keys(state(path).read()));
}
/** A token prevents an older preparation from clearing a newer operation's pending repair. */
export class ReviewPreparation {
  private readonly token = randomUUID();
  private readonly paths = new Set<string>();
  constructor(private readonly root: string) {}
  private update(action: (pending: Record<string, string>) => Record<string, string>): void {
    const path = reviewPreparationPath(this.root),
      store = state(path);
    withCacheLockSync(resolve(dirname(path), "review-preparation"), () => {
      const value = store.read();
      store.write(action(value));
    });
  }
  mark(paths: readonly string[]): void {
    for (const path of paths) this.paths.add(path);
    this.update((pending) => ({ ...pending, ...Object.fromEntries(paths.map((path) => [path, this.token])) }));
  }
  complete(): void {
    this.update((pending) =>
      Object.fromEntries(
        Object.entries(pending).filter(([path, token]) => !this.paths.has(path) || token !== this.token),
      ),
    );
  }
}

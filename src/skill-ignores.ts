import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeAtomic } from "./core.js";
import { withCacheLockSync } from "./cache-lock.js";
import { gitEnvironment } from "./update-git.js";

/** Own only a marked block; other checkouts and manually authored rules remain untouched. */
export function prepareSkillIgnores(root: string, names: string[]): () => void {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return () => undefined;
  const path = result.stdout.trim();
  const owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const begin = `# BEGIN Workbench skill links ${owner}`;
  const end = `# END Workbench skill links ${owner}`;
  const block = names.length
    ? `${begin}\n${names
        .sort()
        .map((name) => `/${name}`)
        .join("\n")}\n${end}\n`
    : "";
  function read(): string {
    try {
      if (!lstatSync(path).isFile()) throw new Error(`${path}: preserve the existing Git exclude path`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  function replace(before: string): string {
    const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const starts = lines.flatMap((line, index) => (line.replace(/\r?\n$/, "") === begin ? [index] : []));
    const ends = lines.flatMap((line, index) => (line.replace(/\r?\n$/, "") === end ? [index] : []));
    if (!starts.length && !ends.length)
      return block ? `${before}${before && !before.endsWith("\n") ? "\n" : ""}${block}` : before;
    const start = starts[0] ?? -1,
      finish = ends[0] ?? -1;
    if (starts.length !== 1 || ends.length !== 1 || finish <= start)
      throw new Error(
        `${path}: malformed Workbench skill exclusion block; preserve and repair it before synchronizing`,
      );
    return lines.slice(0, start).join("") + block + lines.slice(finish + 1).join("");
  }
  // Reject malformed state before changing links, then re-read under the shared Git-file lock.
  replace(read());
  return () => {
    withCacheLockSync(path, () => {
      const before = read(),
        after = replace(before);
      if (after !== before) writeAtomic(path, after);
    });
  };
}

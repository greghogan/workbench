import { required } from "./invariants.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { writeAtomic } from "./core.js";

interface Change {
  path: string;
  before: string;
  after: string;
  charter: boolean;
}
function git(root: string, args: string[], optional = false): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && !optional))
    throw new Error(`cannot inspect proposed review: ${String(result.stderr || result.error)}`);
  return result.status === 0 ? result.stdout : "";
}
function policyPaths(text: string): string[] {
  if (!text) return [];
  const config = parse(text) as { review?: { paths?: unknown } };
  const paths = config.review?.paths ?? [];
  if (
    !Array.isArray(paths) ||
    paths.some(
      (path: unknown) =>
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path
          .replace(/\/$/, "")
          .split("/")
          .some((part) => !part || part === "." || part === ".."),
    )
  )
    throw new Error("review.paths must contain repository-relative files or directory prefixes");
  return paths as string[];
}
function proposed(root: string) {
  const paths = new Set([
    "workbench/config.toml",
    "workbench/projects.toml",
    "workbench/automation.toml",
    ...policyPaths(git(root, ["show", "HEAD:workbench/config.toml"], true)),
    ...policyPaths(git(root, ["show", ":workbench/config.toml"], true)),
    ...policyPaths(git(root, ["show", "HEAD:workbench/automation.toml"], true)),
    ...policyPaths(git(root, ["show", ":workbench/automation.toml"], true)),
  ]);
  const changes: Change[] = [];
  const raw = git(root, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z"]).split("\0");
  for (let index = 0; index < raw.length - 1; index += 2) {
    const header = required(raw[index], "expected raw[index]");
    const path = required(raw[index + 1], "expected raw[index + 1]");
    const fields = header.slice(1).split(" ");
    if (fields[4] === "U") throw new Error(`resolve the conflicted index entry: ${path}`);
    const charter = /(^|\/)workbench\/CHARTER\.md$/.test(path);
    const record = /(^|\/)workbench\/(decisions|experiments)\//.test(path);
    const conventional =
      /(^|\/)(?:quality\.json|package\.json|pyproject\.toml|Cargo\.toml|CMakeLists\.txt|eslint\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.c8rc\.json|\.clang-tidy|nextest\.toml)$/.test(
        path,
      ) ||
      path.startsWith(".github/workflows/") ||
      path.startsWith(".githooks/") ||
      path.startsWith("languages/") ||
      path.startsWith("collections/") ||
      /(^|\/)workbench\/languages\//.test(path);
    if (
      charter ||
      record ||
      conventional ||
      [...paths].some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry))
    )
      changes.push({
        path,
        before: `${String(fields[0])}:${String(fields[2])}`,
        after: `${String(fields[1])}:${String(fields[3])}`,
        charter,
      });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
  const receipt = resolve(root, git(root, ["rev-parse", "--git-path", "workbench/review.json"]).trim());
  return { changes, digest, receipt };
}

export function reviewStatus(root: string): void {
  const { changes, digest, receipt } = proposed(root);
  if (!changes.length) {
    console.log("No protected staged changes.");
    return;
  }
  process.stdout.write(
    git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", ...changes.map((change) => change.path)]),
  );
  console.log(`Review digest: ${digest}\nReceipt: ${receipt}`);
  if (changes.some((change) => change.charter)) console.log("Charter content must be written by a human.");
}

/** A cooperative acknowledgment, never a claim of authenticated human identity. */
export function approveReview(root: string, expected: string, humanWrittenCharters: boolean): void {
  const { changes, digest, receipt } = proposed(root);
  if (!changes.length) throw new Error("no protected staged changes to approve");
  if (expected !== digest) throw new Error("review digest changed; inspect 'workbench review' again");
  if (changes.some((change) => change.charter) && !humanWrittenCharters)
    throw new Error("charter changes require --human-written-charters, attesting human authorship");
  writeAtomic(
    receipt,
    `${JSON.stringify({ digest, changes, approved_at: new Date().toISOString(), human_written_charters: humanWrittenCharters }, null, 2)}\n`,
  );
  console.log("Recorded acknowledgment for the exact protected staged changes.");
}

export function checkReview(root: string): void {
  const { changes, digest, receipt } = proposed(root);
  if (!changes.length) return;
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, "utf8")) as { digest?: unknown; human_written_charters?: unknown };
    if (saved.digest === digest && (!changes.some((change) => change.charter) || saved.human_written_charters === true))
      return;
  }
  throw new Error(
    "protected staged changes need human review; inspect 'workbench review' and acknowledge its digest after approval",
  );
}

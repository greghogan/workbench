import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** Verify the private checkout against the proposed tree without updating either Git index. */
export function verifyStagedSource(repository, snapshot, index, tree) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-C",
      repository,
      "--work-tree=" + snapshot,
      "diff",
      "--no-ext-diff",
      "--quiet",
      "--ignore-submodules=all",
      tree,
    ],
    { env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8" },
  );
  if (result.status === 1)
    throw new Error(
      "Tracked staged source changed during preparation or checks.\n  Write generated files to private outputs and retry.",
    );
  if (result.status !== 0)
    throw new Error("Cannot verify tracked staged source", { cause: result.error ?? new Error(result.stderr.trim()) });
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "verify-staged.mjs" &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const [, , repository, snapshot, index, tree] = process.argv;
  try {
    if (!repository || !snapshot || !index || !tree) throw new Error("Missing staged source verification inputs");
    verifyStagedSource(repository, snapshot, index, tree);
  } catch (error) {
    console.error("workbench: " + error.message);
    if (error.cause) console.error("  " + error.cause.message);
    process.exitCode = 1;
  }
}

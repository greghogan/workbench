import { spawnSync } from "node:child_process";
import { StateConflict } from "../runtime/input-errors.js";
import { commitVersion } from "../review/review-units.js";
import { gitBytes } from "./git-snapshot.js";
import { provisionalTrailer } from "./commit-history.js";

/** Rewritten history keeps authorship and message content; the new committer date is never backdated. */
export function rewriteCommit(root: string, revision: string, parents: string[], provisional: boolean): string {
  const unit = commitVersion(root, revision),
    author = /^(.*) <([^<>]*)> (\d+ [+-]\d{4})$/.exec(unit.author);
  if (!author) throw new StateConflict("Cannot preserve the commit author");
  const setting = spawnSync("git", ["-C", root, "config", "--bool", "--get", "commit.gpgSign"], { encoding: "utf8" });
  if (setting.error || (setting.status !== 0 && setting.status !== 1))
    throw new StateConflict("Cannot inspect commit signing policy");
  const sign = setting.stdout.trim() === "true";
  if (unit.signed && !sign) throw new StateConflict("Enable commit.gpgSign before rewriting a signed commit");
  const message = provisional
    ? unit.provisional
      ? unit.message
      : unit.message.trimEnd() + `\n\n${provisionalTrailer}: true\n`
    : unit.provisional
      ? gitBytes(
          root,
          [
            "-c",
            "trailer.separators=:",
            "interpret-trailers",
            "--if-exists=replace",
            "--if-missing=doNothing",
            "--trim-empty",
            "--trailer",
            `${provisionalTrailer}:`,
          ],
          unit.message,
        ).toString()
      : unit.message;
  const result = spawnSync(
    "git",
    ["-C", root, "commit-tree", unit.tree, ...(sign ? ["-S"] : []), ...parents.flatMap((parent) => ["-p", parent])],
    {
      encoding: "utf8",
      input: message,
      env: { ...process.env, GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2], GIT_AUTHOR_DATE: author[3] },
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result.stdout.trim()))
    throw new StateConflict("Cannot prepare rewritten commit", {
      cause: result.error ?? new Error(result.stderr.trim()),
    });
  const after = result.stdout.trim();
  if (commitVersion(root, after).provisional !== provisional)
    throw new StateConflict("The rewritten commit has an unexpected review marker");
  return after;
}

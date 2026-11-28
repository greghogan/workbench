import { spawnSync } from "node:child_process";
import { projectPaths } from "../projects/project-paths.js";
import { parse as parseToml } from "smol-toml";
import { InvalidInput } from "../runtime/input-errors.js";
import { record } from "../runtime/values.mjs";
import { gitBytes, readGitObjects } from "./git-snapshot.js";
import { zeroRevision } from "./push-updates.js";
import { gitRevision } from "./refs.js";
import { commitSignatureResults } from "./signatures.js";
import { defaultReviewPolicy } from "../configuration/config-schema.js";

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function signingRequired(bytes: Buffer | undefined): boolean {
  if (!bytes) return defaultReviewPolicy.signed_commits;
  const config = parseToml(bytes.toString());
  const review = record(config.review ?? {}, "Invalid review policy");
  if (review.signed_commits !== undefined && typeof review.signed_commits !== "boolean")
    throw new InvalidInput("Invalid review policy: signed_commits must be a boolean");
  return review.signed_commits ?? defaultReviewPolicy.signed_commits;
}

/** A fork's refs and stale tracking branches cannot exclude history from this push. */
function receiverCommits(root: string, destination: string | undefined): string[] {
  if (!destination) return [];
  const remote = spawnSync("git", ["-C", root, "ls-remote", "--refs", "--", destination], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
  });
  // The exact previous object from pre-push still establishes a safe range on push-only destinations.
  if (remote.error || remote.status !== 0) return [];
  const tips = new Set(
    remote.stdout.split("\n").flatMap((row) => {
      const [object] = row.split("\t");
      return object && oid.test(object) ? [object] : [];
    }),
  );
  if (!tips.size) return [];
  const copied = gitBytes(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    [...tips].map((tip) => `${tip}^{commit}\n`).join(""),
  );
  return copied
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [commit, type] = line.split(" ");
      return commit && type === "commit" && oid.test(commit) ? [commit] : [];
    });
}

/** Apply committed policy to Git's actual pushed tip and receiver ref, including peeled tags and merge parents. */
export function checkPushSignatures(root: string, tip: string, previous: string, destination?: string): void {
  if (!oid.test(tip) || !oid.test(previous) || previous.length !== tip.length)
    throw new InvalidInput("Invalid outgoing signature range");
  if (zeroRevision(tip)) return;
  const head = gitRevision(root, `${tip}^{commit}`);
  if (!head) return;
  const base = zeroRevision(previous) ? undefined : gitRevision(root, `${previous}^{commit}`);
  const paths = [head, ...(base ? [base] : [])].map((revision) => `${revision}:${projectPaths.config}`);
  const policies = readGitObjects(root, paths);
  if (!paths.some((path) => signingRequired(policies.get(path)))) return;
  if (!base && !zeroRevision(previous) && !gitRevision(root, `${previous}^{object}`))
    throw new InvalidInput(
      "The push destination revision is unavailable locally. Fetch it before checking signatures.",
    );
  const known = new Set([...receiverCommits(root, destination), ...(base ? [base] : [])]);
  const rows = commitSignatureResults(root, [head, "--stdin"], [...known].map((commit) => `^${commit}\n`).join(""));
  const unsigned: string[] = [],
    invalid: string[] = [];
  for (const { revision, status } of rows) {
    if (status === "N") unsigned.push(revision);
    else if (status !== "G") invalid.push(revision);
  }
  if (!unsigned.length && !invalid.length) return;
  const sample = (commits: string[]) => {
    const shown = commits
      .slice(0, 5)
      .map((commit) => commit.slice(0, 12))
      .join(", ");
    return commits.length <= 5 ? shown : `${shown}, and ${String(commits.length - 5)} more`;
  };
  throw new InvalidInput(
    [
      "Publication requires verified commit signatures.",
      ...(unsigned.length
        ? [
            `\nUnsigned: ${sample(unsigned)}\nRun 'workbench sign' on the branch or tag to sign your commits. Commits by other authors need their signatures.`,
          ]
        : []),
      ...(invalid.length
        ? [`\nInvalid or untrusted: ${sample(invalid)}\nInspect Git's signatures and trust settings before pushing.`]
        : []),
    ].join("\n"),
  );
}

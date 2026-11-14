import { retainedProvisionalCommits } from "../git/commit-history.js";
import { gitBytes } from "../git/git-snapshot.js";
import { InvalidInput } from "../runtime/input-errors.js";
import { reviewChangeDigest } from "./review-snapshot.js";
import type { ReviewChange } from "./review-service.js";

/** Retention proves existing consent is still needed; it neither creates nor extends consent. */
export function retainedAcknowledgments(root: string, candidates: readonly ReviewChange[]): Set<string> {
  const retained = new Set<string>();
  if (!candidates.length) return retained;
  const batches: string[][] = [];
  let batch: string[] = [],
    size = 0;
  for (const path of new Set(candidates.map((change) => change.path))) {
    const cost = path.length * 2 + 4;
    if (batch.length && size + cost > 8192) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(path);
    size += cost;
  }
  if (batch.length) batches.push(batch);
  for (const revision of retainedProvisionalCommits(root)) {
    const parent = gitBytes(root, ["rev-list", "--parents", "-n", "1", revision]).toString().trim().split(" ")[1];
    for (const paths of batches) {
      const fields = gitBytes(root, [
        "--literal-pathspecs",
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        ...(parent ? [parent, revision] : [revision]),
        "--",
        ...paths,
      ])
        .toString()
        .split("\0");
      if (fields.pop() !== "" || fields.length % 2) throw new InvalidInput("Invalid retained review comparison");
      for (let index = 0; index < fields.length; index += 2) {
        const header = fields[index],
          path = fields[index + 1];
        const match =
          /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([a-f0-9]{40}(?:[a-f0-9]{24})?) [A-Z][0-9]*$/.exec(
            header ?? "",
          );
        const beforeMode = match?.[1],
          afterMode = match?.[2],
          before = match?.[3],
          after = match?.[4];
        if (!beforeMode || !afterMode || !before || !after || path === undefined)
          throw new InvalidInput("Invalid retained review file comparison");
        for (const change of candidates)
          if (
            change.path === path &&
            change.before === `${beforeMode}:${before}` &&
            change.after === `${afterMode}:${after}`
          )
            retained.add(reviewChangeDigest(change));
      }
    }
  }
  return retained;
}

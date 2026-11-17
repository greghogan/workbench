import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { ReviewQueue } from "../../../src/server/review/review-queue.ts";
import { ProjectHierarchy } from "../../../src/core/projects/project-hierarchy.ts";

test("review sections order charters, canonical ADR numbers, environments, and experiments independently of paths", () => {
  const project = { id: "example", path: "." };
  const paths = [
    "workbench/experiments/EXP-00.md",
    "workbench/decisions/01/ADR-0100.md",
    "workbench/decisions/ADR-0Z.md",
    "workbench/environments/ENV-00.md",
    "workbench/decisions/ADR-00.md",
    "workbench/CHARTER.md",
  ];
  const changes = paths.map((path) => ({
    path,
    before: "000000:" + "0".repeat(40),
    after: "100644:" + "a".repeat(40),
    digest: createHash("sha256").update(path).digest("hex"),
    approved: false,
    charter: path.endsWith("CHARTER.md"),
  }));
  const queue = new ReviewQueue(new ProjectHierarchy([project]), new Map(), [], changes, new Map(), () => project);
  expect(queue.groups.map((group) => group.path)).toEqual([paths[5], paths[4], paths[2], paths[1], paths[3], paths[0]]);
  expect(queue.pending).toEqual(queue.groups);
});

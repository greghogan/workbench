import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitSnapshot } from "../src/git-snapshot.ts";
import { stagedReview, ReviewSource } from "../src/review-service.ts";
import { webServers } from "./fixtures/web.mjs";
import { git } from "./fixtures/adoption.mjs";
const fixtures = webServers();
test("a Git read session retains its captured HEAD and staged blobs across later commits", () => {
  const root = fixtures.project(),
    file = "workbench/decisions/ADR-00.md";
  writeFileSync(join(root, file), "staged content\n");
  git(root, "add", file);
  const snapshot = new GitSnapshot(root),
    pending = stagedReview(root, ReviewSource.Staged, snapshot);
  const oid = snapshot.staged.get(file)?.oid;
  if (!oid) throw new Error("Missing captured staged object");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  writeFileSync(join(root, file), "later content\n");
  git(root, "add", file);
  git(root, "commit", "-qm", "Later commit");
  expect(snapshot.blob(oid).toString()).toBe("staged content\n");
  expect(stagedReview(root, ReviewSource.Staged, snapshot).digest).toBe(pending.digest);
  expect(new GitSnapshot(root).head).not.toBe(snapshot.head);
});

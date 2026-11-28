import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { git } from "./adoption.mjs";
import {
  AgentReviewKind,
  proposedAgentReview,
  recordAgentReview,
  reviewIdentity,
} from "../../src/core/review/agent-review.ts";
import { initRefFormat, type RefFormat } from "./ref-recovery.mts";
import type { TestContext } from "vitest";

export function reviewUnitFixture() {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function fixture(storage?: { format: RefFormat; context: TestContext }) {
    const root = mkdtempSync(join(tmpdir(), "workbench-units-"));
    temporary.push(root);
    if (storage) initRefFormat(root, storage.format, storage.context);
    else git(root, "init", "-qb", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    mkdirSync(join(root, "workbench/decisions"), { recursive: true });
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[review]\nchanges=true\n",
    );
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
    git(root, "add", ".");
    git(root, "commit", "-qm", "Baseline");
    const base = git(root, "rev-parse", "HEAD"),
      path = "workbench/decisions/ADR-00.md";
    const commit = (body: string, signed = false) => {
      writeFileSync(join(root, path), `---\nsummary: Fixture.\n---\n\n# ADR-0: Fixture\n\n${body}\n`);
      git(root, "add", path);
      git(root, "commit", ...(signed ? ["--gpg-sign"] : []), "-qm", `${body}\n\nWorkbench-Provisional: true`);
      return git(root, "rev-parse", "HEAD");
    };
    const agent = (revision: string) => {
      const review = proposedAgentReview(root, AgentReviewKind.Changes, { commit: revision });
      recordAgentReview(
        root,
        AgentReviewKind.Changes,
        { commit: revision },
        {
          expected: reviewIdentity(review),
          summary: "Reviewed this exact commit",
          verification: "Fixture verifies retained parent boundaries and protected contents",
        },
      );
    };
    return { root, path, base, commit, agent };
  }
  return { fixture, temporary };
}

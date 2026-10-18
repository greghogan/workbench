import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { expect, test, vi } from "vitest";
import { approveReview, checkReview, reviewStatus } from "../src/review.ts";

test.each([
  ["workbench/collections/company/decisions", "ADR-00", "ADR-01"],
  ["workbench/experiments", "EXP-00", "EXP-01"],
  ["app/workbench/experiments", "EXP-00", "EXP-01"],
  ["workbench/environments", "ENV-00", "ENV-01"],
  ["app/workbench/environments", "ENV-00", "ENV-01"],
  ["workbench/environments/01", "ENV-0100", "ENV-0101"],
])("records and supporting files require exact staged approval under %s", (directory, id, addedId) => {
  const root = mkdtempSync(join(tmpdir(), "workbench-record-review-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  const messages: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message) => messages.push(String(message)));
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const digest = () => {
    messages.length = 0;
    reviewStatus(root);
    return required(
      /Review digest: ([a-f0-9]{64})/.exec(messages.join("\n")),
      'Expected fixture value: /Review digest: ([a-f0-9]{64})/.exec(messages.join("\\n"))',
    )[1];
  };
  const record = `${directory}/${id}.md`;
  const attachment = `${directory}/${id}/capture-01/inventory.json`;
  try {
    git("init", "-q");
    mkdirSync(join(root, "workbench"), { recursive: true });
    writeFileSync(
      join(root, "workbench/projects.toml"),
      stringify({
        project: [{ id: "root", path: "." }, ...(directory.startsWith("app/") ? [{ id: "app", path: "app" }] : [])],
      }),
    );
    if (directory.includes("collections/company"))
      writeFileSync(
        join(root, "workbench/config.toml"),
        stringify({
          collections: {
            sources: [
              {
                id: "company",
                revision: "1",
                sha256: "1".repeat(64),
                visibility: "public",
                scopes: ["."],
                source: root,
                commit: "1".repeat(40),
                collection: ".",
              },
            ],
          },
        }),
      );
    mkdirSync(dirname(join(root, attachment)), { recursive: true });
    writeFileSync(join(root, record), "original record\n");
    writeFileSync(join(root, attachment), '{"cores": 8}\n');
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    );
    writeFileSync(join(root, record), "reviewed record\n");
    git("add", record);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
    writeFileSync(join(root, "implementation.txt"), "unrelated\n");
    git("add", "implementation.txt");
    checkReview(root);
    writeFileSync(join(root, attachment), '{"cores": 16}\n');
    git("add", attachment);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
    const binary = `${directory}/${id}/capture-01/profile.bin`;
    writeFileSync(join(root, binary), Buffer.from([0, 1, 2, 255]));
    git("add", binary);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
    writeFileSync(join(root, binary), Buffer.from([0, 1, 3, 255]));
    checkReview(root);
    git("add", binary);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
    git("rm", "-f", binary);
    // Discarding an uncommitted addition leaves a subset of the approved changes.
    checkReview(root);
    const added = `${directory}/${addedId}.md`;
    writeFileSync(join(root, added), "new record\n");
    git("add", added);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
    git("rm", "-f", record);
    expect(() => {
      checkReview(root);
    }).toThrow(/human review/);
    approveReview(root, required(digest(), "Fixture value digest()"), false);
    checkReview(root);
  } finally {
    log.mockRestore();
    stdout.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

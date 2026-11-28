import assert from "node:assert/strict";
import { fixture } from "../fixtures/cli-browsing.mjs";
import { git } from "../fixtures/adoption.mjs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

test("archive commands preserve CLI record access and full-text search without restoring files", () =>
  fixture(({ root, run }) => {
    git(root, "init", "-qb", "main");
    git(root, "config", "user.name", "CLI fixture");
    git(root, "config", "user.email", "cli@example.invalid");
    mkdirSync(join(root, "workbench/tasks"), { recursive: true });
    const contents = "---\nstatus: Accepted\n---\n\n# TSK-0: Delivered CLI work\n\nArchive-only search needle.\n";
    writeFileSync(join(root, "workbench/tasks/TSK-00.md"), contents);
    git(root, "add", ".");
    git(root, "commit", "-qm", "Accepted record");
    run("project", "add", root);
    run("record", "archive", "enable", "--branch", "records", "--group-size", "1");
    git(root, "add", "workbench/config.toml");
    git(root, "commit", "-qm", "Configure archival");
    run("record", "archive", "run", "--yes");
    const shown = JSON.parse(run("record", "show", "TSK-0", "--json")) as { reference: string; contents: string };
    assert.equal(shown.reference, "demo:TSK-0");
    assert.equal(shown.contents, contents);
    const found = JSON.parse(run("record", "search", "ARCHIVE-ONLY", "--type", "TSK", "--json")) as {
      reference: string;
      archived: boolean;
    }[];
    assert.deepEqual(
      found.map(({ reference, archived }) => ({ reference, archived })),
      [{ reference: "demo:TSK-0", archived: true }],
    );
    assert.equal(existsSync(join(root, "workbench/tasks/TSK-00.md")), false);
  }));

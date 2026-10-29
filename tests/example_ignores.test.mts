import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

const examples = resolve(import.meta.dirname, "../examples");
const roots = ["languages", "frameworks"].flatMap((kind) =>
  readdirSync(join(examples, kind), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${kind}/${entry.name}`),
);

test.each(roots)("standalone %s ignores generated and personal files while retaining project inputs", (example) => {
  const root = mkdtempSync(join(tmpdir(), "workbench-example-ignore-"));
  try {
    copyFileSync(join(examples, example, ".gitignore"), join(root, ".gitignore"));
    execFileSync("git", ["-C", root, "init", "--quiet", "--template="]);
    const retained = [".envrc", "coverage/coverage-summary.json", "source.txt", "workbench/config.toml"];
    for (const path of [
      ".envrc.local",
      ".direnv/environment",
      "build/objects/output.o",
      "dist/package/archive.tar",
      "coverage/coverage-final.json",
      "coverage/tests.json",
      ...retained,
    ]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "fixture\n");
    }
    const visible = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .sort();
    expect(visible).toEqual([".gitignore", ...retained].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

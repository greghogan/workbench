import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitBytes } from "../src/git-snapshot.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test.each([
  { hook: "pre-commit", status: 0 },
  { hook: "pre-commit", status: 7 },
  { hook: "pre-push", status: 0 },
  { hook: "pre-push", status: 7 },
])("$hook preserves captured status $status while checkout changes remain unstaged", ({ hook, status }) => {
  const root = mkdtempSync(join(tmpdir(), "workbench-hook-protocol-"));
  roots.push(root);
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (const path of ["workbench", "bin", ".githooks"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n");
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    "throw Error('The captured hook must not invoke a newer command protocol');\n",
  );
  const selected = join(root, ".githooks", hook);
  writeFileSync(selected, `#!/usr/bin/env bash\nprintf 'Captured hook protocol\\n'\nexit ${String(status)}\n`);
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const commit = git(["rev-parse", "HEAD"]),
    tree = git(["write-tree"]);
  const current = readFileSync(join(import.meta.dirname, "../.githooks", hook));
  writeFileSync(selected, current);
  const result = spawnSync("bash", [selected], {
    cwd: root,
    encoding: "utf8",
    input: hook === "pre-push" ? `refs/heads/main ${commit} refs/heads/main ${"0".repeat(40)}\n` : "",
    timeout: 15000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(status);
  expect(result.stdout).toContain("Captured hook protocol");
  expect(git(["write-tree"])).toBe(tree);
  expect(readFileSync(selected)).toEqual(current);
});

test("pre-push rejects provisional history before delegating to a legacy captured hook", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-provisional-hook-"));
  roots.push(root);
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  mkdirSync(join(root, ".githooks"));
  const hook = join(root, ".githooks/pre-push");
  writeFileSync(hook, "#!/usr/bin/env bash\necho 'Legacy hook allowed publication'\n");
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "Local draft\n\nWorkbench-Provisional: true"]);
  const commit = git(["rev-parse", "HEAD"]);
  writeFileSync(hook, readFileSync(join(import.meta.dirname, "../.githooks/pre-push")));
  const result = spawnSync("bash", [hook], {
    cwd: root,
    encoding: "utf8",
    input: `refs/heads/main ${commit} refs/heads/main ${"0".repeat(40)}\n`,
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("provisional commits");
  expect(
    result.stderr
      .trimEnd()
      .split("\n")
      .every((line) => line.length <= 80),
  ).toBe(true);
  expect(result.stdout).not.toContain("Legacy hook allowed publication");
});

test.each(["pre-commit", "pre-push"])("%s runs an identical captured hook using only declared tools", (name) => {
  const root = mkdtempSync(join(tmpdir(), "workbench-hook-tools-"));
  roots.push(root);
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (const directory of ["bin", ".githooks", "workbench"]) mkdirSync(join(root, directory));
  const hook = join(root, ".githooks", name);
  writeFileSync(hook, readFileSync(join(import.meta.dirname, "../.githooks", name)));
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=1\n");
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
  writeFileSync(join(root, "bin/workbench.mjs"), "console.log('Checked captured tree');\n");
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const commit = git(["rev-parse", "HEAD"]);
  const result = spawnSync(
    "bash",
    [
      "-eu",
      "-c",
      // Exercise the minimum hook environment, without optional utilities such as cmp.
      // A second snapshot is a recurrence, so fail immediately instead of leaking recursive children.
      `mkdir "$1"
directory=$(cd -- "$1" && pwd)
for tool in bash sh git node cp mkdir rm env cygpath; do
  if executable=$(type -P "$tool"); then
    printf '#!/bin/sh\\nexec %q "$@"\\n' "$executable" > "$directory/$tool"
    chmod +x "$directory/$tool"
  fi
done
temporary=$(command -v mktemp)
printf '#!/usr/bin/env bash\\nset -eu\\n[[ ! -e "$0.used" ]] || exit 78\\n: > "$0.used"\\nexec %q "$@"\\n' "$temporary" > "$directory/mktemp"
chmod +x "$directory/mktemp"
export PATH="$directory"
exec bash "$2"`,
      "fixture",
      join(root, "commands"),
      hook,
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: name === "pre-push" ? `refs/heads/main ${commit} refs/heads/main ${"0".repeat(40)}\n` : "",
      timeout: 15000,
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.match(/Checked captured tree/g)).toHaveLength(1);
});

test("push gates inspect distinct outgoing histories even when their final files are identical", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-hook-histories-"));
  roots.push(root);
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (const path of ["bin", ".githooks"]) mkdirSync(join(root, path));
  const hook = join(root, ".githooks/pre-push");
  writeFileSync(hook, readFileSync(join(import.meta.dirname, "../.githooks/pre-push")));
  writeFileSync(join(root, "bin/workbench.mjs"), "console.log('Checked history ' + process.env.WORKBENCH_PUSH_TIP);\n");
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "first history"]);
  const first = git(["rev-parse", "HEAD"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "second history"]);
  const second = git(["rev-parse", "HEAD"]);
  const result = spawnSync("bash", [hook], {
    cwd: root,
    encoding: "utf8",
    input: `refs/heads/first ${first} refs/heads/first ${"0".repeat(40)}\nrefs/heads/second ${second} refs/heads/second ${"0".repeat(40)}\n`,
    timeout: 15000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(`Checked history ${first}`);
  expect(result.stdout).toContain(`Checked history ${second}`);
});

test("post-commit uses the committed distribution despite an unstaged broken launcher", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-finish-hook-"));
  roots.push(root);
  const git = (args: string[]) => gitBytes(root, args).toString().trim();
  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  for (const path of ["bin", "bundle"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "bundle/main.cjs.br"), "fixture distribution marker");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, ".node-version"), process.versions.node);
  const launcher = join(root, "bin/workbench.mjs");
  writeFileSync(
    launcher,
    "if(process.argv.slice(2).join(' ') !== 'review finish-commit') throw Error('wrong action'); console.log('Finished ' + process.env.WORKBENCH_PROJECT_ROOT);\n",
  );
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  writeFileSync(launcher, "throw Error('unstaged launcher is broken');\n");
  const result = spawnSync("bash", [join(import.meta.dirname, "../.githooks/post-commit")], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(`Finished ${git(["rev-parse", "--show-toplevel"])}`);
  expect(readFileSync(launcher, "utf8")).toContain("unstaged launcher is broken");
});

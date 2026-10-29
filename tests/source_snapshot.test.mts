import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createSourceSnapshot } from "../scripts/source-snapshot.mts";
import { stageFile } from "../scripts/file-publication.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "workbench-source-capture-test-"));
  temporary.push(parent);
  const source = join(parent, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  return { parent, source, destination: join(parent, "snapshot") };
}
const git = (root: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Source fixture",
      "-c",
      "user.email=source@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=disabled-hooks",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );

test("source capture includes working and new source files without changing the caller's staged contents or refs", async () => {
  const { source, destination } = fixture();
  writeFileSync(join(source, "src/main.ts"), 'export const value = "committed";\n');
  writeFileSync(join(source, ".gitignore"), "node_modules\nscripts/test-coverage.mjs\n");
  git(source, "init", "--quiet");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Fixture");
  writeFileSync(join(source, "src/main.ts"), 'export const value = "staged";\n');
  git(source, "add", "src/main.ts");
  writeFileSync(join(source, "src/main.ts"), 'export const value = "working";\n');
  writeFileSync(join(source, "src/new.ts"), "export const added = true;\n");
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts/test-coverage.mts"), "export {};\n");
  writeFileSync(join(source, "scripts/test-coverage.mjs"), "generated helper must not be borrowed");
  const before = git(source, "ls-files", "--stage", "-z"),
    head = git(source, "rev-parse", "HEAD");
  const candidate = stageFile(join(source, "src/main.ts"), "unpublished source");
  const snapshot = await createSourceSnapshot({
    source,
    destination,
    environment: process.env,
    signal: new AbortController().signal,
  });
  expect(snapshot.tree).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  expect(readFileSync(join(destination, "src/main.ts"), "utf8")).toContain('"working"');
  expect(readFileSync(join(destination, "src/new.ts"), "utf8")).toContain("added");
  expect(existsSync(join(destination, "scripts/test-coverage.mjs"))).toBe(false);
  expect(git(destination, "status", "--porcelain").trim()).toBe("");
  expect(git(source, "ls-files", "--stage", "-z")).toBe(before);
  expect(git(source, "rev-parse", "HEAD")).toBe(head);
  expect(git(source, "show", ":src/main.ts")).toContain('"staged"');
  expect(existsSync(join(destination, "src", basename(candidate.temporary)))).toBe(false);
  candidate.discard();
});

test("already materialized source can be captured without original Git metadata or generated installations", async () => {
  const { source, destination } = fixture();
  writeFileSync(join(source, "src/main.ts"), "export {};\n");
  mkdirSync(join(source, "node_modules"));
  writeFileSync(join(source, "node_modules/dependency"), "installation");
  await createSourceSnapshot({ source, destination, environment: process.env, signal: new AbortController().signal });
  expect(readFileSync(join(destination, "src/main.ts"), "utf8")).toBe("export {};\n");
  expect(existsSync(join(destination, "node_modules"))).toBe(false);
});

test("capture rejects an existing destination and removes owned partial output after cancellation", async () => {
  const { source, destination } = fixture();
  writeFileSync(join(source, "src/main.ts"), "export {};\n");
  mkdirSync(destination);
  writeFileSync(join(destination, "user-work"), "preserve");
  await expect(
    createSourceSnapshot({ source, destination, environment: process.env, signal: new AbortController().signal }),
  ).rejects.toThrow();
  expect(readFileSync(join(destination, "user-work"), "utf8")).toBe("preserve");
  const cancelled = new AbortController();
  cancelled.abort();
  const output = destination + "-cancelled";
  await expect(
    createSourceSnapshot({ source, destination: output, environment: process.env, signal: cancelled.signal }),
  ).rejects.toThrow();
  expect(existsSync(output)).toBe(false);
});

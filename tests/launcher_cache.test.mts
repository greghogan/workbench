import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, renameSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cachedNpmWorkbench } from "../src/npm-cache.ts";
import { toolSpecification } from "../src/tool-pin.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const repository = "https://forge.example/team/workbench.git",
  revision = "a".repeat(40),
  specification = toolSpecification({ repository, revision });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-npm-cache-")));
  roots.push(root);
  const prefix = join(root, "_npx/arbitrary-npm-key"),
    directory = join(prefix, "node_modules/@workbench/cli");
  mkdirSync(join(directory, "bin"), { recursive: true });
  const launcher = join(directory, "bin/workbench.mjs"),
    lock = join(prefix, "package-lock.json");
  writeFileSync(launcher, "export {};\n");
  writeFileSync(
    lock,
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@workbench/cli": { resolved: specification } } }),
  );
  return { root, directory, launcher, lock };
}
test("cached npm execution requires the exact repository and revision, independent of npm's cache-key algorithm", async () => {
  const f = fixture();
  expect(await cachedNpmWorkbench(f.root, specification)).toBe(f.launcher);
  expect(await cachedNpmWorkbench(f.root, toolSpecification({ repository, revision: "b".repeat(40) }))).toBeUndefined();
  expect(
    await cachedNpmWorkbench(
      f.root,
      toolSpecification({ repository: "https://other.example/workbench.git", revision }),
    ),
  ).toBeUndefined();
});
test("cache reuse recognizes equivalent public forge transports without changing the requested transport", async () => {
  const f = fixture(),
    repository = "https://github.com/example/workbench.git",
    resolved = `git+ssh://git@github.com/example/workbench.git#${revision}`;
  writeFileSync(
    f.lock,
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@workbench/cli": { resolved } } }),
  );
  writeFileSync(
    join(f.directory, "workbench-source.json"),
    JSON.stringify({ schema_version: 1, repository, revision }),
  );
  expect(await cachedNpmWorkbench(f.root, toolSpecification({ repository, revision }))).toBe(f.launcher);
});
test.each(["malformed", "unsupported", "unbound", "conflicting-identity", "missing-launcher"])(
  "%s entries cannot authorize cached execution",
  async (kind) => {
    const f = fixture();
    if (kind === "malformed") writeFileSync(f.lock, "{");
    if (kind === "unsupported") writeFileSync(f.lock, JSON.stringify({ lockfileVersion: 999 }));
    if (kind === "unbound") writeFileSync(f.lock, JSON.stringify({ lockfileVersion: 3, packages: {} }));
    if (kind === "conflicting-identity")
      writeFileSync(
        join(f.directory, "workbench-source.json"),
        JSON.stringify({ schema_version: 1, repository, revision: "c".repeat(40) }),
      );
    if (kind === "missing-launcher") rmSync(f.launcher);
    expect(await cachedNpmWorkbench(f.root, specification)).toBeUndefined();
  },
);
test("cache links cannot redirect execution outside the npm installation", async () => {
  const f = fixture(),
    outside = join(f.root, "outside");
  mkdirSync(outside);
  rmSync(f.directory, { recursive: true });
  symlinkSync(outside, f.directory, "junction");
  expect(await cachedNpmWorkbench(f.root, specification)).toBeUndefined();
});

test("version 2 locks are accepted and inherited context cannot supply a missing binding", async () => {
  const f = fixture();
  writeFileSync(
    f.lock,
    JSON.stringify({ lockfileVersion: 2, packages: { "node_modules/@workbench/cli": { resolved: specification } } }),
  );
  expect(await cachedNpmWorkbench(f.root, specification)).toBe(f.launcher);
  vi.stubEnv("WORKBENCH_EXECUTING_SPEC", specification);
  writeFileSync(f.lock, JSON.stringify({ lockfileVersion: 2, packages: {} }));
  expect(await cachedNpmWorkbench(f.root, specification)).toBeUndefined();
});

test("oversized metadata and indirect launcher paths cannot authorize execution", async () => {
  const f = fixture();
  const original = JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/@workbench/cli": { resolved: specification } },
  });
  writeFileSync(f.lock, original + " ".repeat(1024 * 1024));
  expect(await cachedNpmWorkbench(f.root, specification)).toBeUndefined();
  writeFileSync(f.lock, original);
  const bin = join(f.directory, "bin"),
    target = join(f.directory, "actual-bin");
  renameSync(bin, target);
  symlinkSync(target, bin, "junction");
  expect(await cachedNpmWorkbench(f.root, specification)).toBeUndefined();
});

test("an invalid cache entry does not hide another complete installation", async () => {
  const f = fixture(),
    valid = join(f.root, "_npx/another-key");
  cpSync(join(f.root, "_npx/arbitrary-npm-key"), valid, { recursive: true });
  writeFileSync(f.lock, "{");
  expect(await cachedNpmWorkbench(f.root, specification)).toBe(
    join(valid, "node_modules/@workbench/cli/bin/workbench.mjs"),
  );
});

test("cache discovery handles absence and cancellation without acquiring another revision", async () => {
  const f = fixture();
  expect(await cachedNpmWorkbench(join(f.root, "absent"), specification)).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  await expect(cachedNpmWorkbench(f.root, specification, controller.signal)).rejects.toThrow();
});

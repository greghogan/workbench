import { afterEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { preparedDependenciesMatch, setupDevelopment } from "../../../../scripts/setup-development.mts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-source-dependencies-"));
  temporary.push(root);
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const manifest = { packageManager: "pnpm@12.0.0", devDependencies: { esbuild: "1.0.0" } };
  const project = {
    lockfileVersion: "9.0",
    importers: { ".": { devDependencies: { esbuild: { specifier: "1.0.0", version: "1.0.0" } } } },
    packages: { "esbuild@1.0.0": { resolution: { integrity: "fixture-integrity" } } },
  };
  write("package.json", JSON.stringify(manifest));
  write(
    "pnpm-lock.yaml",
    JSON.stringify({ importers: { ".": { packageManagerDependencies: {} } } }) + "\n---\n" + JSON.stringify(project),
  );
  write("pnpm-workspace.yaml", "{}\n");
  write(".node-version", process.versions.node);
  write(
    "node_modules/.modules.yaml",
    JSON.stringify({ packageManager: manifest.packageManager, virtualStoreDir: join(root, "external-store") }),
  );
  write("external-store/lock.yaml", JSON.stringify(project, null, 2));
  mkdirSync(join(root, "node_modules/esbuild"));
  return { root, write, manifest, project };
}

test("prepared source dependencies require the selected graph, manifest, manager, and hook", () => {
  const { root, write, manifest, project } = fixture();
  expect(preparedDependenciesMatch(root)).toBe(true);
  write("external-store/lock.yaml", JSON.stringify({ ...project, packages: {} }));
  expect(preparedDependenciesMatch(root)).toBe(false);
  write("external-store/lock.yaml", JSON.stringify(project));
  write("package.json", JSON.stringify({ ...manifest, devDependencies: { esbuild: "2.0.0" } }));
  expect(preparedDependenciesMatch(root)).toBe(false);
  write("package.json", JSON.stringify({ ...manifest, packageManager: "pnpm@13.0.0" }));
  expect(preparedDependenciesMatch(root)).toBe(false);
  write("package.json", JSON.stringify(manifest));
  write(".pnpmfile.cjs", "module.exports = {};\n");
  expect(preparedDependenciesMatch(root)).toBe(false);
  const selected = {
    ...project,
    pnpmfileChecksum: `sha256-${createHash("sha256")
      .update(readFileSync(join(root, ".pnpmfile.cjs")))
      .digest("base64")}`,
  };
  write("pnpm-lock.yaml", JSON.stringify(selected));
  write("external-store/lock.yaml", JSON.stringify(selected));
  expect(preparedDependenciesMatch(root)).toBe(true);
  rmSync(join(root, "external-store/lock.yaml"));
  expect(preparedDependenciesMatch(root)).toBe(false);
  rmSync(join(root, "node_modules/.modules.yaml"));
  expect(preparedDependenciesMatch(root)).toBe(false);
});

test("source snapshots reject a stale dependency provider before linking or executing build tools", async () => {
  const { root: provider, write, project } = fixture();
  const { root: target } = fixture();
  rmSync(join(target, "node_modules"), { recursive: true });
  write("external-store/lock.yaml", JSON.stringify({ ...project, packages: {} }));
  await expect(setupDevelopment(target, ["--build-only", "--dependencies", provider])).rejects.toThrow(
    /dependency provider does not match its source pins/,
  );
  expect(existsSync(join(target, "node_modules"))).toBe(false);
});

test("a relocated source snapshot resolves relative store metadata at its physical provider and never installs into it", async () => {
  const { root: provider, write, manifest } = fixture();
  write(
    "node_modules/.modules.yaml",
    JSON.stringify({
      packageManager: manifest.packageManager,
      virtualStoreDir: relative(join(provider, "node_modules"), join(provider, "external-store")),
    }),
  );
  const { root: target } = fixture();
  rmSync(join(target, "node_modules"), { recursive: true });
  symlinkSync(join(provider, "node_modules"), join(target, "node_modules"), "junction");
  expect(preparedDependenciesMatch(target)).toBe(true);
  await setupDevelopment(target, ["--reuse-prepared", "--verify-prepared"]);
  expect(existsSync(join(target, "bundle"))).toBe(false);
  write("external-store/lock.yaml", "{}");
  await expect(setupDevelopment(target, ["--verify-prepared"])).rejects.toThrow(/Prepare the locked dependencies/);
  await expect(setupDevelopment(target, ["--build-only"])).rejects.toThrow(/linked dependency provider/);
  expect(readFileSync(join(provider, "external-store/lock.yaml"), "utf8")).toBe("{}");
});

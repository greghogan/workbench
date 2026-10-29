import { copyScriptClosure } from "./fixtures/script-closure.mjs";
import { linkDependencies } from "../scripts/link-dependencies.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { packageManagerInstallationPlan } from "../src/package-manager.ts";
import { retainPnpmMetadata } from "../scripts/pnpm-metadata.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("metadata queries cross the real Workbench CLI argument boundary without consuming manager flags", async () => {
  const { root } = fixture();
  mkdirSync(join(root, "languages"));
  writeFileSync(join(root, "languages/index.toml"), "");
  mkdirSync(join(root, "scripts/package-manager"));
  for (const file of ["package.json", "package-lock.json"])
    copyFileSync(join(repository, "scripts/package-manager", file), join(root, "scripts/package-manager", file));
  writeFileSync(join(root, "package.json"), readFileSync(join(repository, "package.json")));
  writeFileSync(join(root, "pnpm-lock.yaml"), 'packages:\n  "transitive@1.2.3": {}\n');
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "private-cache"));
  const plan = packageManagerInstallationPlan(root, root);
  mkdirSync(join(plan.directory, "node_modules/pnpm/bin"), { recursive: true });
  mkdirSync(join(plan.directory, "bin"));
  writeFileSync(join(plan.directory, ".workbench-bootstrap"), plan.identity);
  for (const launcher of ["pnpm", "pnpm.cmd"]) writeFileSync(join(plan.directory, "bin", launcher), "fixture");
  writeFileSync(
    join(plan.directory, "node_modules/pnpm/bin/pnpm.mjs"),
    `
import { writeFileSync, readFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, "manager-args.json"))}, JSON.stringify({args: process.argv.slice(2), dependencies: JSON.parse(readFileSync('package.json', 'utf8')).dependencies}));
console.log('{}'); process.exitCode = 1;
`,
  );
  await retainPnpmMetadata(root, join(repository, "bundle/main.cjs"), ["."]);
  expect(JSON.parse(readFileSync(join(root, "manager-args.json"), "utf8"))).toEqual({
    args: ["outdated", "--long", "--json"],
    dependencies: { transitive: "1.2.3" },
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-development-preparation-"));
  temporary.push(root);
  for (const directory of ["scripts", "bin", "inputs", "temporary logs"]) mkdirSync(join(root, directory));
  copyScriptClosure(repository, root, "scripts/prepare-development.mjs");
  writeFileSync(
    join(root, "bin/workbench.mjs"),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const args = process.argv.slice(2);
const root = resolve(import.meta.dirname, '..');
const record = (event) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify(event) + '\\n');
if (args[0] === 'project' && args[1] === 'add') process.exit(0);
record({ args, offline: process.env.WORKBENCH_OFFLINE === '1' });
if (args[0] === 'package-manager-exec') {
  const query = JSON.parse(readFileSync('package.json', 'utf8'));
  record({ metadata: query.dependencies });
  if (process.env.FAIL_METADATA === '1') { console.error('metadata registry unavailable'); process.exit(17); }
  console.log('{}');
  process.exit(1); // Newer releases are a successful metadata query.
}
if (args[0] === 'tools' && process.env.FAIL_TOOLS === '1') {
  console.error('fixture native installation failed');
  process.exit(17);
}
if (args[0] === 'tools' && args.some(value => value.startsWith('foreign-'))) throw Error('tool profile is not configured for this host');
if (args[0] === 'check' && args[1] === 'matrix') {
  const host = { os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform, architecture: process.arch };
  console.log(JSON.stringify({ native: { include: [
    { ...host, path: '.' }, { ...host, path: 'app' }, { ...host, path: '.', toolchain: 'alternate' },
    { ...host, os: host.os === 'windows' ? 'linux' : 'windows', path: 'foreign-os', toolchain: 'foreign-os-profile' },
    { ...host, architecture: host.architecture === 'x64' ? 'arm64' : 'x64', path: 'foreign-architecture', toolchain: 'foreign-architecture-profile' },
  ] }, environments: { include: ['nix', 'guix'].flatMap(environment => ['.', 'app', 'managed-only'].map(path => ({ path, environment }))) } }));
} else if (args.includes('--json')) {
  console.log(JSON.stringify({ selected: ['setup', 'format', 'analysis', 'coverage', 'advisory', 'build'].map(role => ({ role })) }));
} else if (args.includes('--role')) {
  const roles = args.flatMap((value,index) => value === '--role' ? [args[index+1]] : []);
  for (const role of roles) {
  const path = args[args.indexOf('--path') + 1];
  if (role === 'advisory') throw Error('live advisory query must not run during preparation');
  if (process.env.FAIL_ROLE === role) throw Error('fixture check failed: ' + role);
  if (['format', 'analysis', 'coverage'].includes(role)) {
    const archive = join('inputs', path === '.' ? 'root-' + role : 'app-' + role);
    if (!existsSync(archive)) {
      if (process.env.WORKBENCH_OFFLINE === '1') throw Error('missing prepared dependency: ' + role);
      writeFileSync(archive, 'verified tool bytes');
      record({ download: role, path });
    }
  }
  }
}
`,
  );
  const run = (builder: string, verify = false, extra = {}) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/prepare-development.mjs"), builder, ...(verify ? ["--verify"] : [])],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          WORKBENCH_OFFLINE: verify ? "1" : "0",
          TMPDIR: join(root, "temporary logs"),
          TEMP: join(root, "temporary logs"),
          TMP: join(root, "temporary logs"),
          ...extra,
        },
      },
    );
  const events = () =>
    readFileSync(join(root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (text) =>
          JSON.parse(text) as {
            args?: string[];
            download?: string;
            offline?: boolean;
            metadata?: Record<string, string>;
          },
      );
  return { root, run, events };
}

test("native preparation acquires configured check tools and verifies them without network access", () => {
  const f = fixture();
  const prepared = f.run("native");
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  expect(readdirSync(join(f.root, "temporary logs"))).toEqual([]);
  expect(f.events().filter((event) => event.download)).toHaveLength(6);
  expect(f.events().some(({ args }) => args?.includes("alternate"))).toBe(true);
  expect(f.events().some(({ args }) => args?.some((value) => value.startsWith("foreign-")))).toBe(false);
  const verified = f.run("native", true);
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  expect(f.events().filter((event) => event.download)).toHaveLength(6);
  const checks = f
    .events()
    .flatMap((event) => (event.offline && event.args?.includes("--role") ? [{ args: event.args }] : []));
  for (const path of [".", "app"]) {
    const selected = checks.filter(({ args }) => args[args.indexOf("--path") + 1] === path);
    expect(selected).toHaveLength(2);
    expect(
      selected.flatMap(({ args }) => args.flatMap((value, index) => (value === "--role" ? [args[index + 1]] : []))),
    ).toEqual(["build", "format", "analysis", "coverage"]);
    expect(selected.every(({ args }) => args.includes("--no-cache"))).toBe(true);
  }
  rmSync(join(f.root, "inputs/app-coverage"));
  const missing = f.run("native", true);
  expect(missing.status).not.toBe(0);
  expect(missing.stdout + missing.stderr).toContain("missing prepared dependency: coverage");
});

test.each(["nix", "guix"])("%s verification uses its declared closure without native tool preparation", (builder) => {
  const f = fixture();
  const result = f.run(builder, true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(f.events().filter((event) => event.download)).toEqual([]);
  expect(f.events().some(({ args }) => args?.[0] === "tools")).toBe(false);
  const checks = f.events().flatMap(({ args }) => (args?.includes("--role") ? [{ args }] : []));
  expect(checks.map(({ args }) => args[args.indexOf("--role") + 1])).toEqual([
    "build",
    "test",
    "build",
    "test",
    "build",
    "test",
  ]);
  expect(checks.map(({ args }) => args[args.indexOf("--path") + 1])).toEqual([
    ".",
    ".",
    "app",
    "app",
    "managed-only",
    "managed-only",
  ]);
});

test("failed native check preparation prevents acceptance", () => {
  const f = fixture();
  const result = f.run("native", false, { FAIL_ROLE: "coverage" });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("fixture check failed: coverage");
  expect(f.events().some(({ args }) => args?.includes("app"))).toBe(false);
});

test("failed tool installation reports its cause and cleans private platform temporary logs", () => {
  const f = fixture();
  const result = f.run("native", false, { FAIL_TOOLS: "1" });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("fixture native installation failed");
  expect(result.stdout + result.stderr).toContain("status=17");
  expect(readdirSync(join(f.root, "temporary logs"))).toEqual([]);
  expect(f.events()).toHaveLength(2);
});

test("native preparation retains transitive policy metadata without changing project locks or querying offline", () => {
  const f = fixture();
  linkDependencies(join(repository, "node_modules"), join(f.root, "node_modules"), ["yaml"]);
  writeFileSync(join(f.root, "package.json"), '{"packageManager":"pnpm@12.15.0"}');
  const lock =
    'lockfileVersion: "9.0"\npackages:\n  direct@1.0.0: {}\n---\nlockfileVersion: "9.0"\npackages:\n  "@scope/transitive@2.0.0": {}\n';
  writeFileSync(join(f.root, "pnpm-lock.yaml"), lock);
  const result = f.run("native");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(
    f
      .events()
      .filter((event) => event.metadata)
      .map((event) => event.metadata),
  ).toEqual([{ direct: "1.0.0", "@scope/transitive": "2.0.0" }]);
  expect(f.events().find((event) => event.args?.[0] === "package-manager-exec")?.args).toEqual([
    "package-manager-exec",
    "--",
    "outdated",
    "--long",
    "--json",
  ]);
  expect(readFileSync(join(f.root, "pnpm-lock.yaml"), "utf8")).toBe(lock);
  expect(readdirSync(join(f.root, "temporary logs"))).toEqual([]);
  expect(f.run("native", true).status).toBe(0);
  expect(f.events().filter((event) => event.metadata)).toHaveLength(1);
  const failed = f.run("native", false, { FAIL_METADATA: "1" });
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("metadata registry unavailable");
  expect(readdirSync(join(f.root, "temporary logs"))).toEqual([]);
});

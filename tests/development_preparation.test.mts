import { copyScriptClosure } from "./fixtures/script-closure.mjs";
import { linkDependencies } from "../scripts/link-dependencies.mjs";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const distribution = realpathSync(mkdtempSync(join(tmpdir(), "workbench-development-preparation-")));
  temporary.push(distribution);
  const root = join(distribution, "consuming project 雪");
  mkdirSync(root);
  for (const directory of ["scripts", "bin"]) mkdirSync(join(distribution, directory));
  for (const directory of ["scripts", "inputs", "temporary logs"]) mkdirSync(join(root, directory));
  copyScriptClosure(repository, distribution, "scripts/prepare-development.mjs");
  writeFileSync(
    join(distribution, "bin/workbench.mjs"),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
const args = process.argv.slice(2);
const distribution = resolve(import.meta.dirname, '..');
const root = resolve(process.env.WORKBENCH_PROJECT_ROOT);
if(process.env.WORKBENCH_DISTRIBUTION_ROOT !== distribution || (args[0] !== 'package-manager-exec' && process.cwd() !== root)) throw Error('project and distribution must remain separate');
const record = (event) => appendFileSync(join(root, 'events.jsonl'), JSON.stringify(event) + '\\n');
if (args[0] === 'project' && args[1] === 'add') process.exit(0);
record({ args, offline: process.env.WORKBENCH_OFFLINE === '1' });
if (args[0] === 'image-roots') {
  const selected = args.flatMap((value,index) => value === '--path' ? [args[index+1]] : []);
  const paths = selected.length ? selected : ['.', 'app'];
  if(new Set(paths).size !== paths.length || paths.some(path => !['.','app'].includes(path))) throw Error('Select distinct registered roots');
  console.log(JSON.stringify(paths)); process.exit(0);
}
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
    ...(process.env.NO_CI === '1' ? [] : [{ ...host, path: '.' }, { ...host, path: '.', toolchain: 'alternate' }]),
    { ...host, os: host.os === 'windows' ? 'linux' : 'windows', path: 'foreign-os', toolchain: 'foreign-os-profile' },
    { ...host, architecture: host.architecture === 'x64' ? 'arm64' : 'x64', path: 'foreign-architecture', toolchain: 'foreign-architecture-profile' },
  ] }, environments: { include: ['nix', 'guix'].flatMap(environment => ['.', 'app', 'managed-only'].map(path => ({ path, environment }))) } }));
} else if (args.includes('--role')) {
  const roles = args.flatMap((value,index) => value === '--role' ? [args[index+1]] : []);
  const workspace=mkdtempSync(join(root,'check-session-'));
  try {
  for (const role of roles) {
  const path = args[args.indexOf('--path') + 1];
  if (role === 'advisory') throw Error('live advisory query must not run during preparation');
  if (process.env.FAIL_ROLE === role) throw Error('fixture check failed: ' + role);
  if (role === 'acquire') {
    if(process.env.WORKBENCH_OFFLINE === '1') throw Error('acquisition cannot run offline');
    const archive=join('inputs',path==='.'?'root-tools':'app-tools');
    writeFileSync(archive,'pinned analysis and test inputs'); record({download:'tools',path});
  }
  if (role === 'build' && args[args.indexOf('--environment')+1] === 'native') {
    const archive = join('inputs', path === '.' ? 'root-' + role : 'app-' + role);
    if (!existsSync(archive)) {
      if (process.env.WORKBENCH_OFFLINE === '1') throw Error('missing prepared dependency: ' + role);
      writeFileSync(archive, 'verified tool bytes');
      record({ download: role, path });
    }
  }
  if(role === 'build') writeFileSync(join(workspace,'compiled-program'),'fresh program');
  if(role === 'smoke' && !existsSync(join(workspace,'compiled-program'))) throw Error('compiled program missing from the check session');
  }
  } finally {rmSync(workspace,{recursive:true,force:true});}
}
`,
  );
  const run = (builder: string, verify = false, extra = {}, paths: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        join(distribution, "scripts/prepare-development.mjs"),
        builder,
        ...(verify ? ["--verify"] : []),
        ...paths.flatMap((path) => ["--path", path]),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          WORKBENCH_OFFLINE: verify ? "1" : "0",
          WORKBENCH_PROJECT_ROOT: root,
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
  return { root, distribution, run, events };
}

test("registered roots are prepared without CI coverage and selections apply to acquisition and verification", () => {
  const f = fixture();
  const prepared = f.run("native", false, { NO_CI: "1" }, ["app"]);
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  expect(readdirSync(join(f.root, "inputs")).sort()).toEqual(["app-build", "app-tools"]);
  const verified = f.run("native", true, {}, ["app"]);
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  const checks = f.events().flatMap(({ args }) => (args?.includes("--role") ? [args] : []));
  expect(checks.every((args) => args[args.indexOf("--path") + 1] === "app")).toBe(true);
  for (const paths of [["missing"], ["app", "app"]]) {
    const rejected = f.run("native", true, {}, paths);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("distinct registered roots");
  }
});

test("a failed smoke execution prevents offline acceptance after a successful build", () => {
  const f = fixture();
  expect(f.run("native").status).toBe(0);
  const result = f.run("native", true, { FAIL_ROLE: "smoke" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("fixture check failed: smoke");
});

test("native acquisition is separate from fresh offline builds and executable examples", () => {
  const f = fixture();
  const prepared = f.run("native");
  expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
  expect(readdirSync(join(f.root, "temporary logs"))).toEqual([]);
  expect(f.events().filter((event) => event.download)).toHaveLength(4);
  expect(f.events().some(({ args }) => args?.includes("alternate"))).toBe(true);
  expect(f.events().some(({ args }) => args?.some((value) => value.startsWith("foreign-")))).toBe(false);
  const verified = f.run("native", true);
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  expect(f.events().filter((event) => event.download)).toHaveLength(4);
  const checks = f
    .events()
    .flatMap((event) => (event.offline && event.args?.includes("--role") ? [{ args: event.args }] : []));
  for (const path of [".", "app"]) {
    const selected = checks.filter(({ args }) => args[args.indexOf("--path") + 1] === path);
    expect(selected).toHaveLength(1);
    expect(
      selected.flatMap(({ args }) => args.flatMap((value, index) => (value === "--role" ? [args[index + 1]] : []))),
    ).toEqual(["build", "smoke"]);
    expect(selected.every(({ args }) => args.includes("--no-cache"))).toBe(true);
  }
  const online = f.events().filter(({ args, offline }) => !offline && args?.includes("--role"));
  expect(online.map(({ args }) => args?.[args.indexOf("--role") + 1])).toEqual([
    "acquire",
    "build",
    "acquire",
    "build",
  ]);
  expect(f.events().some(({ args }) => args?.includes("--stage"))).toBe(false);
  rmSync(join(f.root, "inputs/app-build"));
  const missing = f.run("native", true);
  expect(missing.status).not.toBe(0);
  expect(missing.stdout + missing.stderr).toContain("missing prepared dependency: build");
});

test.each(["nix", "guix"])("%s verification uses its declared closure without native tool preparation", (builder) => {
  const f = fixture();
  const result = f.run(builder, true);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(f.events().filter((event) => event.download)).toEqual([]);
  expect(f.events().some(({ args }) => args?.[0] === "tools")).toBe(false);
  const checks = f.events().flatMap(({ args }) => (args?.includes("--role") ? [{ args }] : []));
  expect(
    checks.flatMap(({ args }) => args.flatMap((value, index) => (value === "--role" ? [args[index + 1]] : []))),
  ).toEqual(["build", "smoke", "build", "smoke"]);
  expect(checks.map(({ args }) => args[args.indexOf("--path") + 1])).toEqual([".", "app"]);
});

test("failed native check preparation prevents acceptance", () => {
  const f = fixture();
  const result = f.run("native", false, { FAIL_ROLE: "build" });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("fixture check failed: build");
  expect(readdirSync(join(f.root, "inputs"))).toEqual(["root-tools"]);
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
  linkDependencies(join(repository, "node_modules"), join(f.distribution, "node_modules"), ["yaml"]);
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

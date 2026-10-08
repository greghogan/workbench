import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ciMatrix } from "../src/ci.ts";
import { runChecks } from "../src/checks.ts";

const temporary = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-ci-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "web"));
  mkdirSync(join(root, "service"));
  const registry = `[[project]]
id = "app"
path = "."
[[language_root]]
language = "typescript"
path = "web"
[[language_root]]
language = "python"
path = "service"
ci_environments = []
`;
  const base = `schema_version = 1
[markdown]
wrap_width = 120
[compatibility]
required = false
[checks]
environment = "native"
nix_docker_image = "nixos/nix@sha256:${"a".repeat(64)}"
[ci]
operating_systems = ["linux", "macos", "windows"]
environments = ["guix", "nix-docker"]
`;
  const checks = `[[check]]
name = "web setup"
role = "setup"
path = "web"
command = ["node", "setup.cjs"]
[[check]]
name = "web test"
role = "test"
path = "web"
command = ["node", "check.cjs"]
[[check]]
name = "service test"
role = "test"
path = "service"
command = ["node", "check.cjs"]
`;
  const config = base + checks;
  writeFileSync(join(root, "workbench/projects.toml"), registry);
  writeFileSync(join(root, "workbench/config.toml"), config);
  writeFileSync(join(root, "web/.node-version"), "24.18.0");
  writeFileSync(join(root, "web/package.json"), JSON.stringify({ engines: { node: ">=22.13.0" } }));
  for (const file of ["channels.scm", "manifest.scm", "flake.nix", "flake.lock"])
    writeFileSync(join(root, "web", file), "fixture\n");
  writeFileSync(join(root, "web/setup.cjs"), 'require("node:fs").writeFileSync("dependency", "installed");\n');
  writeFileSync(
    join(root, "web/check.cjs"),
    'const fs = require("node:fs"); fs.writeFileSync("result", fs.readFileSync("dependency"));\n',
  );
  writeFileSync(join(root, "service/check.cjs"), 'require("node:fs").writeFileSync("result", "unselected");\n');
  return { root, registry, config };
}

test("CI derives root coverage, native pins and minima without duplicating language selections", () => {
  const { root, registry } = fixture();
  const matrix = ciMatrix(root);
  writeFileSync(join(root, "workbench/local.toml"), '[checks]\nenvironment = "guix"\n');
  expect(ciMatrix(root)).toEqual(matrix);
  writeFileSync(join(root, "workbench/local.toml"), "invalid local configuration [");
  expect(ciMatrix(root)).toEqual(matrix);
  expect(matrix.native.include.map(({ path, os }) => [path, os])).toEqual([
    ["web", "linux"],
    ["web", "macos"],
    ["web", "windows"],
    ["service", "linux"],
    ["service", "macos"],
    ["service", "windows"],
  ]);
  expect(matrix.environments.include.map(({ path, environment }) => [path, environment])).toEqual([
    ["web", "guix"],
    ["web", "nix-docker"],
  ]);
  expect(matrix.native.include.find(({ path }) => path === "web").node).toBe("24.18.0");
  expect(matrix.compatibility.include).toEqual([{ path: "web", runtime: "node", version: "22.13.0" }]);
  // Multiple languages sharing one build root must not duplicate jobs.
  writeFileSync(join(root, "workbench/projects.toml"), registry + '\n[[language_root]]\nlanguage="rust"\npath="web"\n');
  expect(ciMatrix(root).native.include).toEqual(matrix.native.include);
  writeFileSync(join(root, "web/.node-version"), "24.19.0\n");
  expect(ciMatrix(root).native.include.find(({ path }) => path === "web").node).toBe("24.19.0");
});

test("invalid coverage and missing definitions fail instead of silently omitting jobs", () => {
  const { root, config } = fixture();
  const path = join(root, "workbench/config.toml");
  for (const [before, after, error] of [
    ['["linux", "macos", "windows"]', '["windows", "windows"]', /duplicate/],
    ['["linux", "macos", "windows"]', "[]", /at least one/],
    ['["linux", "macos", "windows"]', '["windoze"]', /operating_systems/],
    ['["guix", "nix-docker"]', '["nix:latest"]', /ci.environments/],
    [`nix_docker_image = "nixos/nix@sha256:${"a".repeat(64)}"`, "", /nix_docker_image/],
  ]) {
    writeFileSync(path, config.replace(before, after));
    expect(() => ciMatrix(root)).toThrow(error);
  }
  writeFileSync(path, config);
  rmSync(join(root, "web/flake.lock"));
  expect(() => ciMatrix(root)).toThrow(/flake.lock/);
});

test("native CI selects explicit OS architectures and keeps managed environments independent", () => {
  const { root, config } = fixture();
  const path = join(root, "workbench/config.toml");
  const configure = (architectures) =>
    writeFileSync(path, config.replace("[ci]", `[ci]\narchitectures = ${architectures}`));
  configure('{linux = ["x64", "arm64"], macos = ["arm64"], windows = ["x64"]}');
  const matrix = ciMatrix(root);
  expect(
    matrix.native.include
      .filter(({ path }) => path === "web")
      .map(({ os, architecture, runner }) => ({ os, architecture, runner })),
  ).toEqual([
    { os: "linux", architecture: "x64", runner: "ubuntu-24.04" },
    { os: "linux", architecture: "arm64", runner: "ubuntu-24.04-arm" },
    { os: "macos", architecture: "arm64", runner: "macos-15" },
    { os: "windows", architecture: "x64", runner: "windows-2025" },
  ]);
  expect(matrix.native.include.filter(({ path }) => path === "service")).toHaveLength(4);
  expect(matrix.environments.include.map(({ path, environment }) => [path, environment])).toEqual([
    ["web", "guix"],
    ["web", "nix-docker"],
  ]);
  for (const [value, error] of [
    ["{linux = []}", /at least one/],
    ['{windows = ["x64", "x64"]}', /duplicate/],
    ['{windows = ["arm64"]}', /x64/],
    ['{windows = ["arm"]}', /x64/],
    ['{macos = ["x64"]}', /arm64/],
    ['{freebsd = ["arm64"]}', /unknown field/],
  ]) {
    configure(value);
    expect(() => ciMatrix(root)).toThrow(error);
  }
});

test("compiler compatibility includes each family and exact minima while native coverage removes duplicates", () => {
  const { root, registry } = fixture();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    registry.replace('language = "python"', 'language = "cpp"') +
      `
standard = "20"
compiler = "clang"
compilers.clang = { minimum = "21.1.8", ci_versions = ["21.1.8", "23.1.2"] }
compilers.gcc = { minimum = "14.4.0", ci_versions = ["15.3.0", "16.2.0"] }
`,
  );
  writeFileSync(join(root, "service/.llvm-version"), "23.1.2");
  writeFileSync(join(root, "service/.gcc-version"), "16.2.0");
  const targets = () => ciMatrix(root).compatibility.include.filter(({ path }) => path === "service");
  expect(
    targets().every(({ node }) => node === ciMatrix(root).native.include.find(({ path }) => path === "service").node),
  ).toBe(true);
  expect(targets().map(({ path, runtime, version }) => ({ path, runtime, version }))).toEqual([
    { path: "service", runtime: "clang", version: "21.1.8" },
    { path: "service", runtime: "gcc", version: "14.4.0" },
    { path: "service", runtime: "gcc", version: "15.3.0" },
    { path: "service", runtime: "gcc", version: "16.2.0" },
  ]);
  const path = join(root, "workbench/projects.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace('compiler = "clang"', 'compiler = "gcc"'));
  expect(targets().map(({ path, runtime, version }) => ({ path, runtime, version }))).toEqual([
    { path: "service", runtime: "clang", version: "21.1.8" },
    { path: "service", runtime: "clang", version: "23.1.2" },
    { path: "service", runtime: "gcc", version: "14.4.0" },
    { path: "service", runtime: "gcc", version: "15.3.0" },
  ]);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('minimum = "14.4.0"', 'ci_architectures = ["x64", "arm64"], minimum = "14.4.0"'),
  );
  const gcc = targets().filter(({ runtime }) => runtime === "gcc");
  expect(gcc.map(({ architecture, version, runner }) => ({ architecture, version, runner }))).toEqual([
    { architecture: "x64", version: "14.4.0", runner: "ubuntu-24.04" },
    { architecture: "arm64", version: "14.4.0", runner: "ubuntu-24.04-arm" },
    { architecture: "x64", version: "15.3.0", runner: "ubuntu-24.04" },
    { architecture: "arm64", version: "15.3.0", runner: "ubuntu-24.04-arm" },
    { architecture: "arm64", version: "16.2.0", runner: "ubuntu-24.04-arm" },
  ]);
  const config = join(root, "workbench/config.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace("[ci]", '[ci]\narchitectures = {linux = ["x64", "arm64"]}'),
  );
  expect(targets().some(({ runtime, version }) => runtime === "gcc" && version === "16.2.0")).toBe(false);
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      'architectures = {linux = ["x64", "arm64"]}',
      'architectures = {linux = ["arm64"]}',
    ),
  );
  expect(targets()).toContainEqual(expect.objectContaining({ runtime: "gcc", version: "16.2.0", architecture: "x64" }));
});

test("a selected root runs setup before checks, isolates siblings, and stops after failure", () => {
  const { root } = fixture();
  writeFileSync(join(root, "workbench/local.toml"), '[checks]\nenvironment = "guix"\n');
  writeFileSync(join(root, "web/.node-version"), process.versions.node);
  runChecks(root, { path: "web", environment: "native" });
  expect(readFileSync(join(root, "web/result"), "utf8")).toBe("installed");
  expect(existsSync(join(root, "service/result"))).toBe(false);
  rmSync(join(root, "web/result"));
  writeFileSync(join(root, "web/setup.cjs"), "process.exit(41);\n");
  expect(() => runChecks(root, { path: "web", environment: "native" })).toThrow(/failed/);
  expect(existsSync(join(root, "web/result"))).toBe(false);

  expect(() => runChecks(root, { path: "missing", environment: "native" })).toThrow(/registered language root/);
});

test("Dev Container CI uses one workspace and only the explicitly enabled roots", () => {
  const { root, config } = fixture();
  writeFileSync(
    join(root, "workbench/config.toml"),
    config.replace('["guix", "nix-docker"]', '["guix", "nix-docker", "devcontainer"]'),
  );
  expect(() => ciMatrix(root)).toThrow(/devcontainer.json/);
  mkdirSync(join(root, ".devcontainer"));
  writeFileSync(join(root, ".devcontainer/devcontainer.json"), '{"image":"test"}');
  const matrix = ciMatrix(root);
  expect(matrix.devcontainer.paths).toEqual(["web"]);
  expect(matrix.environments.include.map(({ environment }) => environment)).toEqual(["guix", "nix-docker"]);
  expect(matrix.native.include).toHaveLength(6);
});

test("Python CI retains minimum-version coverage independently of its native pin", () => {
  const { root } = fixture();
  writeFileSync(join(root, "service/.python-version"), "3.14.1\n");
  writeFileSync(join(root, "service/pyproject.toml"), '[project]\nrequires-python = ">=3.11.14"\n');
  expect(ciMatrix(root).compatibility.include).toContainEqual({
    path: "service",
    runtime: "python",
    version: "3.11.14",
  });
  writeFileSync(join(root, "service/.python-version"), "3.11.14\n");
  expect(ciMatrix(root).compatibility.include.some(({ runtime }) => runtime === "python")).toBe(false);
  writeFileSync(join(root, "service/pyproject.toml"), '[project]\nrequires-python = ">=3.11,<4"\n');
  expect(() => ciMatrix(root)).toThrow(/requires-python/);
});

test("Python compatibility covers every minor line, retains the exact floor, and avoids duplicate native jobs", () => {
  const { root, registry } = fixture();
  const path = join(root, "workbench/projects.toml");
  const configure = (versions) => writeFileSync(path, registry + `ci_versions = ${JSON.stringify(versions)}\n`);
  writeFileSync(join(root, "service/.python-version"), "3.14.8\n");
  writeFileSync(join(root, "service/pyproject.toml"), '[project]\nrequires-python = ">=3.11.14"\n');
  configure(["3.11.17", "3.12.15", "3.13.16", "3.14.8"]);
  expect(ciMatrix(root).compatibility.include.filter(({ runtime }) => runtime === "python")).toEqual([
    { path: "service", runtime: "python", version: "3.11.14" },
    { path: "service", runtime: "python", version: "3.11.17" },
    { path: "service", runtime: "python", version: "3.12.15" },
    { path: "service", runtime: "python", version: "3.13.16" },
  ]);
  configure(["3.11.14", "3.12.15", "3.13.16", "3.14.8"]);
  expect(ciMatrix(root).compatibility.include.filter(({ runtime }) => runtime === "python")).toEqual([
    { path: "service", runtime: "python", version: "3.11.14" },
    { path: "service", runtime: "python", version: "3.12.15" },
    { path: "service", runtime: "python", version: "3.13.16" },
  ]);
  for (const [versions, error] of [
    [[], /nonempty/],
    [["3.12.15", "3.12.15"], /duplicates/],
    [["3.12", "3.13.16"], /exact/],
    [["3.11.13", "3.12.15", "3.13.16"], /below/],
    [["3.13.16"], /omits Python 3.12/],
    [["3.12.15", "3.13.16", "4.0.0"], /supported Python major/],
  ]) {
    configure(versions);
    expect(() => ciMatrix(root)).toThrow(error);
  }
  configure(["3.12.15", "3.13.16", "3.14.8"]);
  rmSync(join(root, "service/.python-version"));
  expect(() => ciMatrix(root)).toThrow(/native python pin/);
});

test("Node and Go compatibility pins supplement their minima and development versions", () => {
  const { root, registry } = fixture();
  writeFileSync(
    join(root, "workbench/projects.toml"),
    registry.replace('path = "web"', 'path = "web"\nci_versions = ["22.23.3", "24.18.0", "26.5.0"]') +
      '\n[[language_root]]\nlanguage = "go"\npath = "service"\nci_environments = []\nci_versions = ["1.26.8", "1.27.1"]\n',
  );
  writeFileSync(join(root, "service/.go-version"), "1.27.1\n");
  writeFileSync(join(root, "service/go.mod"), "module example.test/service\n\ngo 1.26.7\n");
  expect(ciMatrix(root).compatibility.include).toEqual([
    { path: "web", runtime: "node", version: "22.13.0" },
    { path: "web", runtime: "node", version: "22.23.3" },
    { path: "web", runtime: "node", version: "26.5.0" },
    { path: "service", runtime: "go", version: "1.26.7" },
    { path: "service", runtime: "go", version: "1.26.8" },
  ]);
});

test("compatibility selections require CI configuration and an applicable runtime", () => {
  const { root, registry, config } = fixture();
  const path = join(root, "workbench/projects.toml");
  writeFileSync(path, registry + 'ci_versions = ["3.14.8"]\n');
  writeFileSync(
    join(root, "workbench/config.toml"),
    config.replace(
      '[ci]\noperating_systems = ["linux", "macos", "windows"]\nenvironments = ["guix", "nix-docker"]\n',
      "",
    ),
  );
  expect(() => ciMatrix(root)).toThrow(/CI selections require/);
  writeFileSync(join(root, "workbench/config.toml"), config);
  writeFileSync(path, registry.replace('language = "python"', 'language = "rust"') + 'ci_versions = ["1.99.0"]\n');
  expect(() => ciMatrix(root)).toThrow(/supports TypeScript, Python, and Go/);
});

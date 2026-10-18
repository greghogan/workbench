import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  assertBuildOutput,
  buildEnvironment,
  buildPaths,
  cleanBuilds,
  prepareBuild,
  withBuildLock,
} from "../src/builds.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(languages = ["typescript"]) {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "workbench-builds-")));
  temporary.push(temporaryRoot);
  const root = join(temporaryRoot, "project");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "library"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="fixture"\npath="."\n' +
      languages.map((language) => `[[language_root]]\nlanguage="${language}"\npath="."\n`).join("") +
      '[[language_root]]\nlanguage="rust"\npath="library"\n',
  );
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(temporaryRoot, "cache"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", join(import.meta.dirname, ".."));
  vi.stubEnv("WORKBENCH_LOCAL_CONFIG_ROOT", undefined);
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", undefined);
  vi.stubEnv("WORKBENCH_CONTAINER_CHECKOUT", undefined);
  const paths = buildPaths(root, root, "native");
  return { root, temporaryRoot, paths };
}

test.each(
  (
    [
      ["typescript"],
      ["javascript"],
      ["rust"],
      ["python"],
      ["java"],
      ["php"],
      ["typescript", "rust", "python", "java"],
      ["ruby"],
      [],
    ] satisfies string[][]
  ).map((languages) => [languages] as const),
)("storage controls apply only to languages registered at this root: %j", (languages) => {
  const { paths } = fixture(languages);
  const env = buildEnvironment(paths);
  expect(paths.languages).toEqual(languages);
  expect(env.WORKBENCH_BUILD_DIR).toBe(paths.directory);
  expect(env.WORKBENCH_DIST_DIR).toBe(join(paths.directory, "dist"));
  expect(env.WORKBENCH_DEPENDENCIES_DIR).toBe(paths.dependencies);
  expect(env.PNPM_CONFIG_STORE_DIR).toBe(
    languages.some((language) => language === "typescript" || language === "javascript") ? paths.pnpmStore : undefined,
  );
  expect(env.PNPM_CONFIG_VIRTUAL_STORE_DIR).toBe(
    env.PNPM_CONFIG_STORE_DIR ? join(paths.dependencies, "pnpm") : undefined,
  );
  expect(env.CARGO_TARGET_DIR).toBe(languages.includes("rust") ? join(paths.directory, "cargo") : undefined);
  expect(env.WORKBENCH_MAVEN_REPOSITORY).toBe(
    languages.includes("java") ? join(paths.storageRoot, "downloads/maven") : undefined,
  );
  expect(env.WORKBENCH_COMPOSER_CACHE).toBe(
    languages.includes("php") ? join(paths.storageRoot, "downloads/composer") : undefined,
  );
  const python = languages.includes("python");
  expect(env.UV_PROJECT_ENVIRONMENT).toBe(python ? join(paths.dependencies, "venv") : undefined);
  expect(env.PYTHONPYCACHEPREFIX).toBe(python ? join(paths.directory, "pycache") : undefined);
  expect(env.MYPY_CACHE_DIR).toBe(python ? join(paths.directory, "mypy") : undefined);
  expect(env.RUFF_CACHE_DIR).toBe(python ? join(paths.directory, "ruff") : undefined);
  expect(env.PYTEST_ADDOPTS).toBe(
    python ? `-o cache_dir=${JSON.stringify(join(paths.directory, "pytest"))}` : undefined,
  );
  expect(env.COVERAGE_FILE).toBe(python ? join(paths.directory, ".coverage") : undefined);
  expect(env.UV_BUILD_OUT_DIR).toBe(python ? join(paths.directory, "python-dist") : undefined);
});

test("build storage separates checkouts, language roots, toolchains and environments; source edits reuse it", () => {
  const { root, temporaryRoot, paths } = fixture();
  expect(existsSync(paths.base)).toBe(false);
  writeFileSync(join(root, "source.txt"), "changed source");
  expect(buildPaths(root, root, "native").directory).toBe(paths.directory);
  writeFileSync(join(root, ".node-version"), "24.21.0");
  expect(buildPaths(root, root, "native").directory).not.toBe(paths.directory);
  expect(buildPaths(root, join(root, "library"), "native").roots).not.toBe(paths.roots);
  expect(buildPaths(root, root, "guix").directory).not.toBe(paths.directory);
  expect(paths.pnpmStore).toBe(join(temporaryRoot, "cache/downloads/pnpm"));
  expect(buildEnvironment(paths).PNPM_CONFIG_STORE_DIR).toBe(paths.pnpmStore);
  expect(buildPaths(root, join(root, "library"), "native").pnpmStore).toBe(paths.pnpmStore);
  expect(buildPaths(root, root, "guix").pnpmStore).toBe(paths.pnpmStore);
  const other = join(temporaryRoot, "worktree");
  mkdirSync(other);
  expect(buildPaths(other, other, "native").roots).not.toBe(paths.roots);
  expect(buildPaths(other, other, "native").pnpmStore).toBe(paths.pnpmStore);
  const override = join(temporaryRoot, "fast disk");
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", override);
  expect(buildPaths(root, root, "native").base).toBe(join(override, "builds"));
  expect(buildPaths(root, root, "native").pnpmStore).toBe(join(override, "downloads/pnpm"));
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", "relative");
  expect(() => buildPaths(root, root, "native")).toThrow(/absolute/);
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", join(root, "output"));
  expect(() => buildPaths(root, root, "native")).toThrow(/outside/);
});

test("build inputs follow registered languages and retain watches for absent applicable files", () => {
  const { root, paths } = fixture(["typescript", "python"]);
  expect(paths.inputs).toEqual(
    [
      ".node-version",
      ".python-version",
      ".tool-versions",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "pyproject.toml",
      "uv.lock",
    ]
      .sort()
      .map((file) => join(root, file)),
  );
  writeFileSync(join(root, "Cargo.lock"), "unrelated Rust lock");
  expect(buildPaths(root, root, "native").directory).toBe(paths.directory);
  writeFileSync(join(root, "uv.lock"), "new Python lock");
  expect(buildPaths(root, root, "native").directory).not.toBe(paths.directory);
  const rust = buildPaths(root, join(root, "library"), "native");
  expect(rust.inputs).toContain(join(root, "library/Cargo.lock"));
  expect(rust.inputs).not.toContain(join(root, "library/uv.lock"));
  expect(rust.inputs).not.toContain(join(root, "library/package.json"));
});

test.each([
  ["c", ".llvm-version"],
  ["cpp", "vcpkg.json"],
  ["go", "go.sum"],
  ["ruby", "Gemfile.lock"],
  ["java", "pom.xml"],
  ["php", "tools/composer.lock"],
])("%s cache identity watches its own inputs without unrelated Node locks", (language, file) => {
  const { root, paths } = fixture([language]);
  expect(paths.inputs).toContain(join(root, file));
  expect(paths.inputs).not.toContain(join(root, "pnpm-lock.yaml"));
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), "changed pin or lock");
  expect(buildPaths(root, root, "native").directory).not.toBe(paths.directory);
});

test("cleanup removes only owned products across environments and refuses active or unowned storage", () => {
  const { root, paths } = fixture();
  const managed = buildPaths(root, root, "guix");
  const library = buildPaths(root, join(root, "library"), "native");
  for (const location of [paths, managed, library]) {
    prepareBuild(location);
    prepareBuild(location);
    writeFileSync(join(location.directory, "product"), "built");
  }
  withBuildLock(paths, () => {
    expect(() => {
      cleanBuilds(paths);
    }).toThrow(/active/);
  });
  expect(readFileSync(join(paths.directory, "product"), "utf8")).toBe("built");
  cleanBuilds(paths);
  expect(existsSync(paths.directory)).toBe(false);
  expect(existsSync(managed.directory)).toBe(false);
  expect(readFileSync(join(library.directory, "product"), "utf8")).toBe("built");
  prepareBuild(paths);
  rmSync(join(paths.directory, ".workbench-build.json"));
  writeFileSync(join(paths.directory, "foreign"), "keep");
  expect(() => {
    prepareBuild(paths);
  }).toThrow(/unowned/);
  expect(() => {
    cleanBuilds(paths);
  }).toThrow(/unowned/);
  expect(readFileSync(join(paths.directory, "foreign"), "utf8")).toBe("keep");
});

test("local storage is the default and ordinary cleanup preserves external dependencies", () => {
  const { root, paths } = fixture();
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", undefined);
  const local = buildPaths(root, root, "native");
  expect(local.external).toBe(false);
  prepareBuild(local);
  expect(existsSync(local.directory)).toBe(false);
  expect(buildEnvironment(local).CARGO_TARGET_DIR).toBeUndefined();
  expect(buildEnvironment(local).UV_PROJECT_ENVIRONMENT).toBeUndefined();
  expect(buildEnvironment(local).PNPM_CONFIG_STORE_DIR).toBeUndefined();
  prepareBuild(paths);
  writeFileSync(join(paths.pnpmStore, "cached-package"), "download");
  writeFileSync(join(paths.directory, "binary"), "built");
  writeFileSync(join(paths.dependencies, "installed-package"), "dependency");
  cleanBuilds(local);
  expect(existsSync(paths.directory)).toBe(false);
  expect(readFileSync(join(paths.dependencies, "installed-package"), "utf8")).toBe("dependency");
  cleanBuilds(local, true);
  expect(existsSync(paths.dependencies)).toBe(false);
  expect(readFileSync(join(paths.pnpmStore, "cached-package"), "utf8")).toBe("download");
});

test("external pnpm stores reject symlinks and preparation preserves existing shared downloads", () => {
  const { root, temporaryRoot, paths } = fixture();
  prepareBuild(paths);
  writeFileSync(join(paths.pnpmStore, "cached-package"), "shared download");
  prepareBuild(paths);
  expect(readFileSync(join(paths.pnpmStore, "cached-package"), "utf8")).toBe("shared download");
  rmSync(paths.pnpmStore, { recursive: true });
  const foreign = join(temporaryRoot, "foreign-store");
  mkdirSync(foreign);
  symlinkSync(foreign, paths.pnpmStore, "junction");
  expect(() => buildPaths(root, root, "native")).toThrow(/symlink/);
  expect(() => {
    prepareBuild(paths);
  }).toThrow(/symlink/);
});

test("ownership receipts and symlink boundaries prevent foreign or redirected cleanup", () => {
  const { root, temporaryRoot, paths } = fixture();
  prepareBuild(paths);
  const receipt = join(paths.directory, ".workbench-build.json");
  writeFileSync(receipt, JSON.stringify({ ...paths.identity, checkout: "foreign" }));
  expect(() => {
    prepareBuild(paths);
  }).toThrow(/ownership/);
  expect(() => {
    cleanBuilds(paths);
  }).toThrow(/ownership/);
  rmSync(paths.directory, { recursive: true });
  const outside = join(temporaryRoot, "unrelated");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "keep");
  symlinkSync(outside, paths.directory, "junction");
  expect(() => buildPaths(root, root, "native")).toThrow(/symlink/);
  expect(() => {
    prepareBuild(paths);
  }).toThrow(/symlink/);
  expect(() => {
    cleanBuilds(paths);
  }).toThrow(/symlink/);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
});

test("vcpkg rejects output outside owned storage and cleanup preserves linked source files", () => {
  const { paths, root } = fixture();
  prepareBuild(paths);
  mkdirSync(join(paths.directory, "cargo"));
  writeFileSync(join(paths.directory, "cargo/product"), "compiled");
  vi.stubEnv("WORKBENCH_BUILD_DIR", paths.directory);
  assertBuildOutput(join(paths.directory, "debug"));
  expect(() => {
    assertBuildOutput(root);
  }).toThrow(/child/);
  expect(() => {
    assertBuildOutput(paths.directory);
  }).toThrow(/child/);
  const linked = join(paths.directory, "linked");
  symlinkSync(root, linked, "junction");
  expect(() => {
    assertBuildOutput(join(linked, "build"));
  }).toThrow(/symlink/);
  cleanBuilds(paths);
  expect(existsSync(join(paths.directory, "cargo/product"))).toBe(false);
  expect(existsSync(root)).toBe(true);
});

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeProject } from "../src/initialization.ts";
import { readConfig, readLanguageRoots } from "../src/project-configuration.ts";
import { catalog, detected } from "../src/languages.ts";
import { ProjectEdits } from "../src/project-edits.ts";
import { checkCommit } from "../src/commit.ts";
import * as fs from "node:fs";
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), linkSync: vi.fn(actual.linkSync) };
});

const distribution = resolve(import.meta.dirname, "..");
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "workbench-init-"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test.each(["typescript", "javascript", "java", "rust", "python", "c", "cpp", "go", "ruby", "php"])(
  "%s can preview and initialize a new consuming project without prerequisites or authored policy",
  (language) => {
    const root = join(base, language);
    initializeProject(root, { language, plan: true });
    expect(existsSync(root)).toBe(false);
    initializeProject(root, { language });
    expect(readLanguageRoots(root)).toEqual([expect.objectContaining({ language, path: "." })]);
    expect(readConfig(root).check_suite).toEqual([{ language, path: "." }]);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(existsSync(join(root, ".githooks"))).toBe(false);
    expect(existsSync(join(root, "workbench/CHARTER.md"))).toBe(false);
    const definition = catalog(root).find((entry) => entry.id === language);
    for (const file of definition?.starter ?? []) expect(existsSync(join(root, file)), file).toBe(true);
    if (language === "ruby") expect(existsSync(join(root, "test/coverage_helper.rb"))).toBe(true);
    if (["c", "cpp"].includes(language)) {
      expect(readLanguageRoots(root)[0]?.compilers?.clang?.minimum).toBe("21.1.8");
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain("```console");
    }
    const message = join(base, "message");
    writeFileSync(message, "Retain my existing commit conventions\n");
    expect(() => {
      checkCommit(root, message);
    }).not.toThrow();
  },
);
test("setup ignore additions compose with a root starter and a second independent language root", () => {
  const root = join(base, "mixed");
  initializeProject(root, { recordsOnly: true });
  writeFileSync(join(root, ".gitignore"), "# User policy\n/private/\n");
  initializeProject(root, { language: "typescript" });
  initializeProject(root, { language: "go", root: "worker" });
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("# User policy\n/private/\n");
  expect(readLanguageRoots(root).map((entry) => [entry.language, entry.path])).toEqual([
    ["typescript", "."],
    ["go", "worker"],
  ]);
  expect(() => {
    initializeProject(root, { language: "typescript" });
  }).toThrow(/already registered/);
});
test("a conflict is diagnosed before Git, scaffold or other starter files are published", () => {
  const root = join(base, "existing");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  expect(() => {
    initializeProject(root, { language: "typescript" });
  }).toThrow(/package.json already exists/);
  expect(existsSync(join(root, ".git"))).toBe(false);
  expect(existsSync(join(root, "workbench"))).toBe(false);
  expect(existsSync(join(root, "LICENSE"))).toBe(false);
  expect(() => {
    initializeProject(root, { language: "bogus" });
  }).toThrow(/unsupported language/);
  expect(() => {
    initializeProject(root, { language: "go", root: "../elsewhere" });
  }).toThrow(/unsafe language root/);
  expect(() => {
    initializeProject(root, { language: "java", root: "package.json", adopt: true });
  }).toThrow(/language root must be a real directory/);
  expect(existsSync(join(root, "workbench"))).toBe(false);
});
test("adoption preserves guidance, hooks, manifests and TOML comments while adding explicit checks", () => {
  const root = join(base, "adoption");
  mkdirSync(root);
  expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "core.hooksPath", ".custom-hooks"]).status).toBe(0);
  writeFileSync(join(root, "AGENTS.md"), "# Existing guidance\n\nKeep this exact text.\n");
  writeFileSync(join(root, "pyproject.toml"), '[project]\nname="existing"\n');
  initializeProject(root, { adopt: true, language: "python", check: ["python -m unittest"] });
  expect(readFileSync(join(root, "pyproject.toml"), "utf8")).toBe('[project]\nname="existing"\n');
  expect(readConfig(root).check?.[0]?.command).toEqual(["sh", "-c", "python -m unittest"]);
  const configPath = join(root, "workbench/config.toml");
  writeFileSync(configPath, "# Retain this comment\n" + readFileSync(configPath, "utf8"));
  copyFileSync(join(distribution, "tests/fixtures/records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  initializeProject(root, { adopt: true, commitStyle: "conventional" });
  expect(readFileSync(configPath, "utf8")).toContain("# Retain this comment");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toMatch(
    /^# Existing guidance\n\nKeep this exact text\.\n\n<!-- workbench:context:start -->/,
  );
  expect(spawnSync("git", ["-C", root, "config", "core.hooksPath"], { encoding: "utf8" }).stdout.trim()).toBe(
    ".custom-hooks",
  );
  expect(() => {
    initializeProject(root, { adopt: true, hooks: true });
  }).toThrow(/core.hooksPath/);
});
test.each(["c", "cpp"])("CMake short and explicit declarations detect %s independently", (language) => {
  const root = join(base, "cmake");
  mkdirSync(root);
  for (const form of [language === "c" ? "C" : "CXX", language === "c" ? "LANGUAGES C" : "LANGUAGES CXX"]) {
    writeFileSync(join(root, "CMakeLists.txt"), `# project(decoy LANGUAGES C CXX)\nproject(consumer ${form})\n`);
    expect(detected(root, ".").map(([id]) => id)).toEqual([language]);
  }
});
test("a file plan detects concurrent changes and unsafe destination parents", () => {
  const edits = new ProjectEdits(base);
  edits.write("one.txt", "first\n");
  edits.write("one.txt", "second\n");
  edits.apply();
  expect(readFileSync(join(base, "one.txt"), "utf8")).toBe("second\n");
  const concurrent = new ProjectEdits(base);
  concurrent.write("one.txt", "third\n");
  writeFileSync(join(base, "one.txt"), "user edit\n");
  expect(() => {
    concurrent.apply();
  }).toThrow(/changed during initialization/);
  expect(readFileSync(join(base, "one.txt"), "utf8")).toBe("user edit\n");
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(base, "linked"), "junction");
  expect(() => {
    edits.create("linked/wrong.txt", "wrong");
  }).toThrow(/real project path/);
});

test("a failed file publication rolls back owned writes and retains the original error", () => {
  const first = join(base, "first.bin"),
    second = join(base, "second.bin");
  const original = Buffer.from([0, 255, 128, 10]);
  writeFileSync(first, original);
  const edits = new ProjectEdits(base);
  edits.write("first.bin", Buffer.from([1, 254]));
  edits.create("second.bin", "second");
  const failure = new Error("disk full during publication");
  const link = vi.mocked(fs.linkSync).getMockImplementation();
  if (!link) throw new Error("missing filesystem fixture implementation");
  vi.mocked(fs.linkSync).mockImplementation((source, destination) => {
    if (destination === second) throw failure;
    link(source, destination);
  });
  expect(() => {
    edits.apply();
  }).toThrow(failure);
  expect(readFileSync(first)).toEqual(original);
  expect(existsSync(second)).toBe(false);
});

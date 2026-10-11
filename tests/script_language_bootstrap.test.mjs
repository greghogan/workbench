import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execute, download, extractArchive } from "../src/tool-downloads.ts";
import { executeBundler } from "../src/ruby-manager.ts";
import { executeComposer } from "../src/php-manager.ts";
import { executePhpCoverage } from "../src/php-coverage.ts";
import { buildRuby, buildPhp } from "../src/runtime-builds.ts";
vi.mock("../src/tool-downloads.ts", async (original) => ({
  ...(await original()),
  execute: vi.fn(),
  download: vi.fn(),
  extractArchive: vi.fn(),
}));
const repository = resolve(import.meta.dirname, "..");
const temporary = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-script-bootstrap-"));
  temporary.push(root);
  return root;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WORKBENCH_CACHE_HOME", fixture());
  vi.stubEnv("WORKBENCH_CPUS", "4");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("verified Bundler bootstrap uses RubyGems once per runtime and fails closed on incomplete installs", async () => {
  const root = fixture();
  writeFileSync(join(root, "Gemfile.lock"), "\nCHECKSUMS\n\nBUNDLED WITH\n   4.0.22\n");
  vi.mocked(download).mockResolvedValue("/verified/bundler.gem");
  let runtime = "ruby:4.0.7:linux";
  let version = "4.0.22";
  vi.mocked(execute).mockImplementation((_cmd, args) =>
    args.includes(`print [RUBY_ENGINE, RUBY_VERSION, RUBY_PLATFORM, RbConfig::CONFIG.fetch("prefix")].join(':')`)
      ? runtime
      : args.includes("--version")
        ? version
        : "",
  );
  await executeBundler(root, repository, ["install"]);
  await executeBundler(root, repository, ["check"]);
  expect(download).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith("ruby", expect.arrayContaining(["--local", "/verified/bundler.gem"]));
  const invocation = vi.mocked(execute).mock.calls.at(-1);
  expect(invocation[2].env.BUNDLE_FROZEN).toBe("true");
  expect(invocation[2].env.BUNDLE_DISABLE_CHECKSUM_VALIDATION).toBe("false");
  expect(invocation[2].env.BUNDLE_GLOBAL_GEM_CACHE).toBe("true");
  const firstPath = invocation[2].env.BUNDLE_PATH;
  const firstDownloads = invocation[2].env.BUNDLE_USER_CACHE;
  runtime = "ruby:3.3.12:linux";
  await executeBundler(root, repository, ["check"]);
  expect(download).toHaveBeenCalledTimes(2);
  expect(vi.mocked(execute).mock.calls.at(-1)[2].env.BUNDLE_PATH).not.toBe(firstPath);
  expect(vi.mocked(execute).mock.calls.at(-1)[2].env.BUNDLE_USER_CACHE).not.toBe(firstDownloads);
  runtime = "ruby:3.3.12:linux:/different-sdk";
  await executeBundler(root, repository, ["check"]);
  expect(download).toHaveBeenCalledTimes(3);
  version = "4.0.21";
  await expect(executeBundler(root, repository, ["check"])).rejects.toThrow(/expected Bundler/);
});

test("a failed bootstrap leaves no partial installation and can retry", async () => {
  const root = fixture();
  writeFileSync(join(root, "Gemfile.lock"), "\nCHECKSUMS\n\nBUNDLED WITH\n   4.0.22\n");
  vi.mocked(download).mockResolvedValue("/verified/bundler.gem");
  vi.mocked(execute).mockImplementation((_cmd, args) => {
    if (args.includes("install")) throw new Error("fixture install failed");
    return "ruby:4.0.7:linux";
  });
  await expect(executeBundler(root, repository, ["check"])).rejects.toThrow(/fixture install/);
  const parent = join(process.env.WORKBENCH_CACHE_HOME, "package-managers/bundler/4.0.22");
  expect(readdirSync(parent)).toEqual([]);
  vi.mocked(execute).mockImplementation((_cmd, args) => (args.includes("--version") ? "4.0.22" : "ruby:4.0.7:linux"));
  await executeBundler(root, repository, ["check"]);
  expect(readdirSync(parent)).toHaveLength(1);
  expect(readdirSync(join(parent, readdirSync(parent)[0]))).toEqual([".workbench-bootstrap"]);
});

test("Composer bootstrap follows a root pin and refuses an incorrect executable version", async () => {
  const root = fixture();
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, ".composer-version"), "2.10.3\n");
  vi.mocked(download).mockResolvedValue("/verified/composer.phar");
  vi.mocked(execute).mockReturnValue("Composer version 2.10.3 2026-08-27");
  await executeComposer(join(root, "tools"), repository, ["install", "--prefer-dist"]);
  expect(execute).toHaveBeenLastCalledWith(
    "php",
    ["/verified/composer.phar", "install", "--prefer-dist"],
    expect.objectContaining({ cwd: join(root, "tools") }),
  );
  vi.mocked(execute).mockReturnValue("Composer version 2.9.0");
  await expect(executeComposer(root, repository, [])).rejects.toThrow(/expected Composer/);
});

test("runtime source builds use all allotted CPUs and stage installs with the final prefix", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    for (const build of [buildRuby, buildPhp]) {
      const stage = fixture();
      const destination = join(fixture(), "runtime");
      const source = fixture();
      const image = build(source, stage, destination, execute);
      expect(image).toBe(join(stage, "image", destination));
      expect(execute).toHaveBeenCalledWith(
        join(source, "configure"),
        expect.arrayContaining([`--prefix=${destination}`]),
        expect.objectContaining({ cwd: join(stage, "compile") }),
      );
      expect(execute).toHaveBeenCalledWith("make", ["-j4"], expect.anything());
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("Xdebug builds once for the selected PHP executable, verifies receipts, and passes coverage settings", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    const root = fixture();
    writeFileSync(join(root, ".xdebug-version"), "3.5.3\n");
    vi.mocked(download).mockResolvedValue("/verified/xdebug.tgz");
    vi.mocked(extractArchive).mockImplementation(async (_archive, stage) => {
      const source = join(stage, "xdebug-3.5.3");
      mkdirSync(source);
      writeFileSync(join(source, "config.m4"), "source");
      mkdirSync(join(source, "modules"));
      writeFileSync(join(source, "modules/xdebug.so"), "verified-build");
      return stage;
    });
    vi.mocked(execute).mockImplementation((cmd, args) =>
      args.includes("echo PHP_BINARY;") ? "/runtime/bin/php" : cmd.endsWith("php-config") ? "--prefix=/runtime" : "",
    );
    await executePhpCoverage(root, repository, ["suite.php"]);
    await executePhpCoverage(root, repository, ["suite.php"]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith(
      "/runtime/bin/php",
      expect.arrayContaining(["-d", "xdebug.mode=coverage", "suite.php"]),
      expect.anything(),
    );
    const last = vi.mocked(execute).mock.calls.at(-1);
    const extension = join(last[2].env.PHP_INI_SCAN_DIR.split((await import("node:path")).delimiter)[0], "xdebug.so");
    expect(readFileSync(join(dirname(extension), ".workbench-extension"), "utf8")).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(dirname(extension), ".workbench-extension"), "changed");
    await expect(executePhpCoverage(root, repository, ["suite.php"])).rejects.toThrow(/incomplete/);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("ordinary Bundler use rejects a lock without archive checksum authority before downloading", async () => {
  const root = fixture();
  writeFileSync(join(root, "Gemfile.lock"), "\nBUNDLED WITH\n   4.0.22\n");
  await expect(executeBundler(root, repository, ["install"])).rejects.toThrow(/require a CHECKSUMS/);
  expect(download).not.toHaveBeenCalled();
});

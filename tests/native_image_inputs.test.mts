import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareNativeImageInputs } from "../src/native-image-inputs.ts";
import { download } from "../src/tool-downloads.ts";
import { runOwnedChild } from "../scripts/owned-child.mjs";

vi.mock("../src/tool-downloads.js", async (original) => ({
  ...(await original<typeof import("../src/tool-downloads.ts")>()),
  download: vi.fn(),
}));
vi.mock("../scripts/owned-child.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/owned-child.mjs")>()),
  runOwnedChild: vi.fn(),
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "workbench-image-inputs-"));
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(directory, "cache"));
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", join(directory, "repository"));
  vi.mocked(runOwnedChild).mockResolvedValue({ pid: 1, status: 0, signal: null });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("roots without additional acquisition inputs do not start tools or downloads", async () => {
  const listeners = process.listenerCount("SIGTERM");
  await prepareNativeImageInputs(directory, directory);
  expect(runOwnedChild).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(existsSync(join(directory, "cache"))).toBe(false);
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

test("locked source acquisition includes dev dependencies and loads the pinned coverage extension without tests", async () => {
  for (const file of ["Cargo.lock", "go.mod", ".xdebug-version"]) writeFileSync(join(directory, file), "locked");
  await prepareNativeImageInputs(directory, directory);
  expect(vi.mocked(runOwnedChild).mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["cargo", ["fetch", "--locked"]],
    ["go", ["mod", "download", "all"]],
    [
      process.execPath,
      [
        join(directory, "bin/workbench.mjs"),
        "php-coverage-exec",
        "--",
        "-r",
        'if (!extension_loaded("xdebug")) { exit(1); }',
      ],
    ],
  ]);
  for (const [, , options] of vi.mocked(runOwnedChild).mock.calls) expect(options.cwd).toBe(directory);
  for (const file of ["Cargo.lock", "go.mod", ".xdebug-version"])
    expect(readFileSync(join(directory, file), "utf8")).toBe("locked");
});

test("every pinned Maven artifact is verified before populating its canonical local repository", async () => {
  const bytes = Buffer.from("pinned Maven input");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const path = "org/example/tool/1.0/tool-1.0.jar";
  const archive = join(directory, "verified.jar");
  writeFileSync(archive, bytes);
  mkdirSync(join(directory, ".mvn/checksums"), { recursive: true });
  writeFileSync(join(directory, ".mvn/checksums/checksums.sha256"), checksum + "  " + path + "\n");
  vi.mocked(download).mockResolvedValue(archive);
  await prepareNativeImageInputs(directory, directory);
  expect(vi.mocked(download).mock.calls[0]?.[0]).toEqual({
    url: "https://maven-central.storage-download.googleapis.com/maven2/" + path,
    sha256: checksum,
  });
  expect(vi.mocked(download).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  const repository = join(directory, "repository");
  expect(readFileSync(join(repository, path))).toEqual(bytes);
  expect(readFileSync(join(repository, "org/example/tool/1.0/_remote.repositories"), "utf8")).toBe(
    "tool-1.0.jar>central-mirror=\n",
  );
  expect(existsSync(repository + ".lock")).toBe(false);
});

test("failed acquisition stops subsequent work and releases its signal handlers", async () => {
  writeFileSync(join(directory, "Cargo.lock"), "locked");
  writeFileSync(join(directory, "go.mod"), "locked");
  const listeners = process.listenerCount("SIGTERM");
  vi.mocked(runOwnedChild).mockResolvedValue({ pid: 1, status: 17, signal: null });
  await expect(prepareNativeImageInputs(directory, directory)).rejects.toThrow(/status=17/);
  expect(runOwnedChild).toHaveBeenCalledTimes(1);
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

test.each([true, false])("existing Maven inputs are checked before reuse (valid: %s)", async (valid) => {
  const expected = Buffer.from("pinned Maven input");
  const checksum = createHash("sha256").update(expected).digest("hex");
  const path = "org/example/tool/1.0/tool-1.0.jar";
  const target = join(directory, "repository", path);
  mkdirSync(join(directory, ".mvn/checksums"), { recursive: true });
  writeFileSync(join(directory, ".mvn/checksums/checksums.sha256"), checksum + "  " + path + "\n");
  mkdirSync(join(directory, "repository/org/example/tool/1.0"), { recursive: true });
  const original = valid ? expected : Buffer.from("unexpected bytes");
  writeFileSync(target, original);
  if (valid) await prepareNativeImageInputs(directory, directory);
  else await expect(prepareNativeImageInputs(directory, directory)).rejects.toThrow(/Maven cache checksum mismatch/);
  expect(download).not.toHaveBeenCalled();
  expect(readFileSync(target)).toEqual(original);
});

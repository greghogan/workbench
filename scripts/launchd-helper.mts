import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isMainScript } from "./script-entry.mjs";

const source = "scripts/service-native/workbench-launchd.c";
const inputName = "workbench-launchd";
const receiptName = "launchd-helper.json";
const maximumBytes = 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function readArtifact(path: string, maximum: number): Buffer {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const fd = openSync(path, flags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maximum || info.size === 0)
      throw new Error(`${path}: invalid macOS helper build artifact`);
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used !== info.size) throw new Error(`${path}: macOS helper build artifact changed during verification`);
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}

function revision(root: string): string {
  const value = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error("Invalid macOS helper source revision");
  return value;
}

function identity(root: string, bytes: Buffer) {
  return {
    version: 1,
    revision: revision(root),
    source: digest(readFileSync(join(root, source))),
    sha256: digest(bytes),
  };
}

function compile(root: string, target: string): Buffer {
  if (process.platform !== "darwin") throw new Error("The launchd helper requires a native macOS build host");
  execFileSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-std=c17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=11.0",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      join(root, source),
      "-o",
      target,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/xcrun", ["lipo", target, "-verify_arch", "arm64", "x86_64"], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", target], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", target], { stdio: "inherit" });
  return readArtifact(target, maximumBytes);
}

export function launchdHelperBytes(root: string): Buffer | undefined {
  const input = process.env.WORKBENCH_LAUNCHD_HELPER_INPUT;
  if (input) {
    if (!isAbsolute(input)) throw new Error("WORKBENCH_LAUNCHD_HELPER_INPUT must be an absolute directory");
    const bytes = readArtifact(join(input, inputName), maximumBytes);
    const receipt = readArtifact(join(input, receiptName), 4096);
    if (receipt.toString() !== JSON.stringify(identity(root, bytes)) + "\n")
      throw new Error("macOS service helper does not match its recorded source and artifact");
    return bytes;
  }
  if (process.platform !== "darwin") return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "workbench-launchd-build-"));
  try {
    return compile(root, join(scratch, inputName));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isMainScript(import.meta.url)) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error("Usage: node scripts/launchd-helper.mts OUTPUT_DIRECTORY");
  const directory = resolve(output);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const bytes = compile(process.cwd(), join(directory, inputName));
  writeFileSync(join(directory, receiptName), JSON.stringify(identity(process.cwd(), bytes)) + "\n", { flag: "wx" });
}

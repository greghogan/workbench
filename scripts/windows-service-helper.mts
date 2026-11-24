import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMainScript } from "./script-entry.mjs";
import { windowsNativeHelper } from "../app/src/core/distribution/windows-service-paths.mts";

export { windowsNativeHelper };

const directory = "scripts/service-native";
const sources = [
  "windows-browser-relay.c",
  "windows-control.c",
  "windows-coordinator.c",
  "windows-private.c",
  "windows-registration.c",
  "windows-service-path.c",
  "windows-worker.c",
  "workbench-scm.c",
];
const program = "workbench-scm.exe";
const receipt = "windows-service-helper.json";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function artifact(path: string, maximum: number): Buffer {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > maximum)
    throw new Error(`${path}: invalid Windows service artifact`);
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino || opened.size !== file.size)
      throw new Error(`${path}: Windows service artifact changed during opening`);
    const bytes = Buffer.alloc(file.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(descriptor, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used !== file.size) throw new Error(`${path}: Windows service artifact changed during verification`);
    return bytes.subarray(0, used);
  } finally {
    closeSync(descriptor);
  }
}

function identity(root: string, bytes: Buffer) {
  if (bytes.length < 512 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid Windows service PE image");
  const header = bytes.readUInt32LE(0x3c);
  if (
    header < 64 ||
    header > bytes.length - 6 ||
    bytes.toString("ascii", header, header + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(header + 4) !== 0x8664
  )
    throw new Error("Windows service helper must be an x64 PE image");
  const revision = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) throw new Error("Invalid Windows helper source revision");
  const headers = sources
    .filter((source) => source.startsWith("windows-"))
    .map((source) => source.replace(/\.c$/, ".h"));
  const code = [...sources, ...headers].map((name) => [name, digest(readFileSync(join(root, directory, name)))]);
  return { version: 1, revision, code, sha256: digest(bytes) };
}

export function windowsServiceHelperBytes(root: string): Buffer | undefined {
  const input = process.env.WORKBENCH_WINDOWS_SERVICE_HELPER_INPUT;
  if (!input) return undefined;
  if (!isAbsolute(input)) throw new Error("WORKBENCH_WINDOWS_SERVICE_HELPER_INPUT must be an absolute directory");
  const bytes = artifact(join(input, program), 4 * 1024 * 1024);
  if (artifact(join(input, receipt), 4096).toString() !== JSON.stringify(identity(root, bytes)) + "\n")
    throw new Error("Windows service helper does not match its recorded source and artifact");
  return bytes;
}

if (isMainScript(import.meta.url)) {
  const output = process.argv[2];
  if (process.platform !== "win32" || process.arch !== "x64" || !output || process.argv.length !== 3)
    throw new Error("Run on Windows x64 using the native compiler environment and supply an output directory");
  const root = process.cwd(),
    target = resolve(output);
  mkdirSync(target, { mode: 0o700 });
  execFileSync(
    "cl.exe",
    [
      "/nologo",
      "/std:c17",
      "/W4",
      "/WX",
      "/O2",
      "/DUNICODE",
      "/D_UNICODE",
      ...sources.map((source) => join(root, directory, source)),
      "/Fe:" + join(target, program),
      "advapi32.lib",
      "userenv.lib",
      "ws2_32.lib",
      "iphlpapi.lib",
      "bcrypt.lib",
    ],
    { cwd: target, stdio: "inherit" },
  );
  const bytes = artifact(join(target, program), 4 * 1024 * 1024);
  writeFileSync(join(target, receipt), JSON.stringify(identity(root, bytes)) + "\n", { flag: "wx", mode: 0o600 });
}

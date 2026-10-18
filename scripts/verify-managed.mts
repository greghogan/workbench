import { record, required, string, isStringArray } from "./values.mjs";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [artifact, source, nixImage, builder] = process.argv.slice(2);
const directory = resolve(required(artifact, "Missing release artifact"));
const sourceRoot = resolve(required(source, "Missing release source"));
const metadata = record(
  JSON.parse(readFileSync(join(directory, "managed-release.json"), "utf8")),
  "Invalid managed release metadata",
);
const checkMetadata = record(metadata.check, "Invalid release check contract");
const packagePath = string(metadata.package, "Missing release package");
if (metadata.version !== 1 || (builder !== "guix" && builder !== "nix") || metadata.builder !== builder)
  throw new Error("Invalid managed release metadata");
const expected = record(
  JSON.parse(readFileSync(join(sourceRoot, "managed-release-check.json"), "utf8")),
  "Invalid expected release contract",
);
assert.deepEqual(checkMetadata, expected, "Release behavior must match the source-owned verification contract");
const executableRuntime =
  checkMetadata.runtime === undefined ? undefined : string(checkMetadata.runtime, "Invalid runtime name");
if (executableRuntime && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(executableRuntime))
  throw new Error("Invalid managed runtime executable");
const prefix = metadata.builder === "nix" ? "nix" : "gnu";
if (!new RegExp(`^/${prefix}/store/[a-z0-9]{32}-[A-Za-z0-9+._-]+$`).test(packagePath))
  throw new Error("Invalid package store identity");
const base = metadata.builder === "nix" ? nixImage : string(expected.image, "Missing verification image");
if (!base || !/@sha256:[a-f0-9]{64}$/.test(base)) throw new Error("Verification requires a digest-pinned base image");
const docker = process.env.WORKBENCH_CI_DOCKER ?? "docker";
function execute(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${String(result.error ?? (result.stderr || result.status))}`);
  return result.stdout.trim();
}
function container(args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}) {
  return execute(docker, args, options);
}
const name = `workbench-release-${randomUUID()}`;
const temporary = mkdtempSync(join(tmpdir(), "workbench-managed-verify-"));
let created = false;
try {
  container(["pull", base]);
  container([
    "create",
    "--name",
    name,
    "--network=none",
    "--mount",
    `type=bind,src=${directory},dst=/artifacts,readonly`,
    base,
    "sleep",
    "infinity",
  ]);
  created = true;
  container(["start", name]);
  const bin = metadata.builder === "nix" ? `${packagePath}/bin` : "/tmp/package/bin";
  let runtime = bin;
  if (metadata.builder === "nix") {
    const input = openSync(join(directory, "closure.nar"), "r");
    try {
      container(["exec", "-i", name, "nix-store", "--import"], { stdio: [input, "pipe", "pipe"] });
    } finally {
      closeSync(input);
    }
    container(["exec", name, "test", "-d", packagePath]);
    if (executableRuntime) {
      const propagated = container(["exec", name, "cat", `${packagePath}/nix-support/propagated-build-inputs`]).split(
        /\s+/,
      );
      const candidates = propagated.filter(
        (path) => spawnSync(docker, ["exec", name, "test", "-x", `${path}/bin/${executableRuntime}`]).status === 0,
      );
      assert.equal(candidates.length, 1, "Expected one selected runtime in the release closure");
      runtime = `${String(candidates[0])}/bin`;
    }
  } else {
    container([
      "exec",
      name,
      "sh",
      "-eu",
      "-c",
      "mkdir /tmp/package; tar -xzf /artifacts/package.tar.gz -C /tmp/package",
    ]);
  }
  if (checkMetadata.site) {
    if (checkMetadata.site !== "share/site") throw new Error("Unsupported static-site output path");
    const path = `${metadata.builder === "guix" ? "/tmp/package" : ""}${packagePath}/${checkMetadata.site}`;
    const site = join(temporary, "site");
    container([
      "exec",
      name,
      "sh",
      "-eu",
      "-c",
      'mkdir /tmp/verified-site; cp -r "$1"/. /tmp/verified-site/; chmod -R u+rwX /tmp/verified-site',
      "verify-site",
      path,
    ]);
    container(["cp", `${name}:/tmp/verified-site`, site]);
    execute(process.execPath, [join(sourceRoot, "scripts/check-site.mjs"), site], { cwd: temporary });
  } else {
    if (!Array.isArray(checkMetadata.commands) || !checkMetadata.commands.length)
      throw new Error("Release verification must contain behavioral commands");
    for (const value of checkMetadata.commands) {
      const check = record(value, "Invalid release command");
      if (!isStringArray(check.argv) || !check.argv.length) throw new Error("Invalid release verification arguments");
      const args = check.argv.map((value: string) =>
        value.replace(/\{(package|bin|runtime)\}/g, (_, key: string) =>
          key === "package" ? packagePath : key === "bin" ? bin : runtime,
        ),
      );
      const result = spawnSync(
        docker,
        ["exec", "--workdir", "/tmp", "--env", "GUIX_EXECUTION_ENGINE=proot", name, ...args],
        { encoding: "utf8" },
      );
      if (result.error) throw result.error;
      assert.ok(Number.isInteger(result.status), `Release command did not complete: ${String(result.signal)}`);
      if (check.status === "nonzero") assert.notEqual(result.status, 0, result.stdout);
      else assert.equal(result.status, check.status ?? 0, result.stderr || result.stdout || JSON.stringify(args));
      if (check.stdout !== undefined) assert.equal(result.stdout, check.stdout);
    }
  }
  console.log(`Verified ${String(metadata.builder)} release offline outside the checkout and host stores.`);
} finally {
  if (created) container(["rm", "--force", name]);
  rmSync(temporary, { recursive: true, force: true });
}

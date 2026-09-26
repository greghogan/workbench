import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

const distribution = resolve(import.meta.dirname, "..");
const executable = join(distribution, "bundle/main.cjs");

test("host Nix and Docker Nix use distinct runners and require an image digest", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-nix-runners-"));
  const root = join(temporary, "project");
  const stubs = join(temporary, "bin");
  mkdirSync(root);
  mkdirSync(stubs);
  const dockerArguments = join(temporary, "docker-args");
  const nixArguments = join(temporary, "nix-args");
  const environment = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH ?? ""}`,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    TEST_DOCKER_ARGS: dockerArguments,
    TEST_NIX_ARGS: nixArguments,
  };
  const invoke = (...args) =>
    spawnSync(process.execPath, [executable, ...args], { cwd: root, env: environment, encoding: "utf8" });
  try {
    for (const name of ["docker", "nix"]) {
      const script = join(stubs, name);
      writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "$TEST_${name.toUpperCase()}_ARGS"\n`);
      chmodSync(script, 0o755);
    }
    assert.equal(invoke("setup-project", root).status, 0);
    writeFileSync(join(root, "flake.nix"), "{}\n");
    writeFileSync(join(root, "flake.lock"), "{}\n");
    const configPath = join(root, "workbench/config.toml");
    const initial = readFileSync(configPath, "utf8");
    writeFileSync(
      configPath,
      `${initial}\n[[check]]\nname = "container"\nrole = "test"\nenvironment = "nix-docker"\ncommand = ["node", "--version"]\n`,
    );
    const container = invoke("checks", "run");
    assert.equal(container.status, 0, container.stderr);
    const args = readFileSync(dockerArguments, "utf8").trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 5), [
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${root},dst=/source,readonly`,
      "--mount",
    ]);
    assert.ok(args.includes("WORKBENCH_PROJECT_ROOT=/work"));
    assert.ok(args.some((arg) => arg.startsWith("type=volume,src=workbench-nix-")));
    assert.ok(args.some((arg) => arg.startsWith("nixos/nix@sha256:")));
    assert.deepEqual(args.slice(-3), ["/work", "node", "--version"]);

    mkdirSync(join(root, "web"));
    writeFileSync(join(root, "web/flake.nix"), "{}\n");
    writeFileSync(join(root, "web/flake.lock"), "{}\n");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n[[check]]\nname = "web"\nrole = "lint"\npath = "web"\nenvironment = "nix-docker"\ncommand = ["node", "--version"]\n`,
    );
    const nested = invoke("checks", "run", "--role", "lint");
    assert.equal(nested.status, 0, nested.stderr);
    assert.deepEqual(readFileSync(dockerArguments, "utf8").trimEnd().split("\n").slice(-3), [
      "/work/web",
      "node",
      "--version",
    ]);

    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace('environment = "nix-docker"', 'environment = "nix"'),
    );
    const host = invoke("checks", "run");
    assert.equal(host.status, 0, host.stderr);
    assert.deepEqual(readFileSync(nixArguments, "utf8").trimEnd().split("\n").slice(0, 3), [
      "--extra-experimental-features",
      "nix-command flakes",
      "develop",
    ]);

    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(/nixos\/nix@sha256:[0-9a-f]{64}/, "nixos/nix:latest"),
    );
    assert.match(invoke("checks", "list").stderr, /checks\.nix_docker_image must be an image pinned/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

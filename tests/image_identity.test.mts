import { readConfig } from "../src/core.ts";
import { required } from "../src/invariants.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { offlineInputs, offlineInputManifest } from "../src/offline-profiles.ts";

const distribution = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(builder: string) {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-identity-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const profiles = required(readConfig(distribution).development?.profiles, "Configured development profiles");
  const selected = required(
    profiles.find((p) => p.name === builder),
    "Selected profile",
  );
  const profile = {
    ...selected,
    container_config: required(selected.container_config, "Container configuration"),
    offline: required(selected.offline, "Offline configuration"),
  };
  for (const path of new Set([
    "workbench/config.toml",
    "workbench/projects.toml",
    profile.container_config,
    ...profile.offline.inputs,
  ])) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(distribution, path), join(root, path), { recursive: true });
  }
  return { root, profile };
}

test.each(["nix", "guix"])(
  "%s image identity survives orchestration, builder-cache, workspace and executable changes",
  (builder) => {
    const { root, profile } = fixture(builder);
    const before = offlineInputs(root, profile);
    for (const path of [
      "scripts/prepare-managed-development.mjs",
      "scripts/managed-process.mjs",
      "scripts/managed-contract.mjs",
      "scripts/prepare-host-managed-development.mjs",
      `scripts/prepare-${builder}-profiles.mjs`,
      "scripts/container-tools/buildkit-image.txt",
      ".devcontainer/managed-build.sh",
      `.devcontainer/${builder}/Dockerfile`,
      `.devcontainer/${builder}/prepare.sh`,
      "bundle/main.cjs.br",
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), "different orchestration or cache settings\n");
      expect(offlineInputs(root, profile), path).toBe(before);
    }
    writeFileSync(
      join(root, profile.container_config),
      JSON.stringify({
        workspaceFolder: "/different-workspace",
        remoteUser: "another-user",
        containerEnv: { CACHE_LOCATION: "/tmp/cache" },
      }),
    );
    expect(offlineInputs(root, profile)).toBe(before);
    const execution = {
      ...profile,
      workspace: "devcontainer" as const,
      offline: {
        ...profile.offline,
        prepare: ["new-preparation-entrypoint"],
        verify: ["new-verification-command"],
        registry: "registry.example.com/team/development",
      },
    };
    expect(offlineInputs(root, execution)).toBe(before);
    expect(
      offlineInputManifest(root, profile).files.some(
        ([name]) => name.startsWith("scripts/") || name.endsWith("/Dockerfile") || name.endsWith("/prepare.sh"),
      ),
    ).toBe(false);
  },
);

test.each(["nix", "guix"])(
  "%s image identity changes with actual image layout, package declarations and environment pins",
  (builder) => {
    const { root, profile } = fixture(builder);
    const files =
      builder === "nix"
        ? [".devcontainer/nix/image.nix", "examples/languages/cpp/package.nix", "flake.lock"]
        : [
            ".devcontainer/guix/image.scm",
            ".devcontainer/guix/environments.scm",
            ".devcontainer/guix/image.json",
            "examples/languages/cpp/package.scm",
            "channels.scm",
          ];
    for (const path of files) {
      const before = offlineInputs(root, profile);
      const original = readFileSync(join(root, path));
      writeFileSync(join(root, path), Buffer.concat([original, Buffer.from("\nchanged image input\n")]));
      expect(offlineInputs(root, profile), path).not.toBe(before);
      writeFileSync(join(root, path), original);
      expect(offlineInputs(root, profile)).toBe(before);
    }
    const metadata = join(root, "examples/languages/python/managed-check-inputs.json");
    expect(existsSync(metadata)).toBe(true);
    const before = offlineInputs(root, profile);
    const declaration = JSON.parse(readFileSync(metadata, "utf8")) as { source_hashes: Record<string, string> };
    declaration.source_hashes["pyproject.toml"] = "a".repeat(64);
    writeFileSync(metadata, JSON.stringify(declaration));
    expect(offlineInputs(root, profile)).not.toBe(before);
  },
);

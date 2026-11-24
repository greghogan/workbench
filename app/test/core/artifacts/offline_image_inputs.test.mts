import { readConfig, readLanguageRoots } from "../../../src/core/projects/project-configuration.ts";
import { projectPaths } from "../../../src/core/projects/project-paths.ts";
import { required } from "../../../src/core/runtime/invariants.ts";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse, stringify } from "smol-toml";
import { validateManagedImageInputs } from "../../../src/core/artifacts/image-input-validation.ts";
import { offlineInputManifest, offlineInputs } from "../../../src/core/artifacts/offline-profiles.ts";
import type { DevelopmentProfile } from "../../../src/core/artifacts/profile-schema.ts";

const repository = resolve(import.meta.dirname, "../../../..");
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-inputs-"));
  temporary.push(root);
  const config = readConfig(repository);
  const files = new Set<string>([projectPaths.config, projectPaths.projects, projectPaths.profiles]);
  for (const profile of required(
    required(config.development, "Expected fixture value: config.development").profiles,
    "Expected fixture value",
  ))
    for (const [file] of offlineInputManifest(repository, profile).files) files.add(file);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repository, file), join(root, file));
  }
  for (const entry of readLanguageRoots(repository)) mkdirSync(join(root, entry.path), { recursive: true });
  return { root, config };
}

test("reference dependency images survive checkout edits and invalidate on their own dependency authorities", () => {
  const { root, config } = fixture();
  expect(() => {
    validateManagedImageInputs(root);
  }).not.toThrow();
  const profiles = required(config.development?.profiles, "Development profiles");
  const development = profiles.filter((profile) => profile.offline?.kind !== "toolchain");
  const toolchains = profiles.filter((profile) => profile.offline?.kind === "toolchain");
  const identities = (selected: readonly DevelopmentProfile[] = development) =>
    selected.map((profile) => offlineInputs(root, profile));
  const baseline = identities();
  for (const file of [
    "src/main.ts",
    "bundle/main.cjs",
    "scripts/ci-hosted.mts",
    "app/src/core/toolchains/pnpm-lock.mjs",
    "scripts/pnpm-metadata.mjs",
    "scripts/prepare-development.mjs",
    "scripts/split-prepared-inputs.mjs",
    "tests/app.test.mjs",
    "workbench/decisions/ADR-00.md",
    "languages/c/automation.toml",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "ordinary checkout edit");
    expect(identities(), file).toEqual(baseline);
  }
  const configPath = join(root, projectPaths.config);
  const declarations = parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, stringify({ ...declarations, markdown: { ...config.markdown, wrap_width: 100 } }));
  const offline = required(required(development[1], "Second profile").offline, "Offline configuration");
  offline.verify = ["updated-verification"];
  offline.registry = "ghcr.io/example/another-repository";
  expect(identities()).toEqual(baseline);

  for (const [file, builder] of [
    ["channels.scm", "guix"],
    ["flake.lock", "nix"],
    [".node-version", "native"],
    ["examples/languages/php/.xdebug-version", "native"],
    ["examples/languages/c/guix-toolchain.scm", "guix"],
    ["examples/languages/c/package.nix", "nix"],
  ] as const) {
    const path = join(root, required(file, "Expected fixture value")),
      original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\nchanged dependency input\n")]));
    for (const [index, identity] of identities().entries()) {
      if (required(development[index], "Prepared development profile").builder === builder)
        expect(identity, file).not.toBe(baseline[index]);
      else expect(identity, file).toBe(baseline[index]);
    }
    writeFileSync(path, original);
    expect(identities()).toEqual(baseline);
  }
  const toolchainBaseline = identities(toolchains);
  for (const [file, toolchainChanges] of [
    ["pnpm-lock.yaml", []],
    [".tool-versions", ["native"]],
    ["scripts/native-assets.json", ["native", "nix", "guix"]],
  ] as const) {
    const path = join(root, file),
      original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\nchanged dependency input\n")]));
    expect(
      identities().every((identity, index) => identity !== baseline[index]),
      file,
    ).toBe(true);
    expect(
      toolchains
        .filter((profile, index) => offlineInputs(root, profile) !== toolchainBaseline[index])
        .map(({ builder }) => builder),
      file,
    ).toEqual(toolchainChanges);
    writeFileSync(path, original);
  }
});

import { configFromData, languageRootsFromData } from "../src/core.ts";
import { required } from "../src/invariants.ts";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse, stringify } from "smol-toml";
import { validateManagedImageInputs } from "../src/image-input-validation.ts";
import { offlineInputManifest, offlineInputs } from "../src/offline-profiles.ts";
import type { DevelopmentProfile } from "../src/profile-schema.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-image-inputs-"));
  temporary.push(root);
  const config = configFromData(
    parse(readFileSync(join(repository, "workbench/config.toml"), "utf8")),
    undefined,
    "fixture",
  );
  const registry = parse(readFileSync(join(repository, "workbench/projects.toml"), "utf8"));
  const files = new Set(["workbench/config.toml", "workbench/projects.toml"]);
  for (const profile of required(
    required(config.development, "Expected fixture value: config.development").profiles,
    "Expected fixture value",
  ))
    for (const [file] of offlineInputManifest(repository, profile).files) files.add(file);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repository, file), join(root, file));
  }
  for (const entry of languageRootsFromData(registry, "fixture"))
    mkdirSync(join(root, entry.path), { recursive: true });
  return { root, config, registry };
}

test("reference dependency images survive checkout edits and invalidate on their own dependency authorities", () => {
  const { root, config } = fixture();
  expect(() => {
    validateManagedImageInputs(root);
  }).not.toThrow();
  const profiles = required(config.development, "Expected fixture value: config.development").profiles;
  const identities = () =>
    required(profiles, "Expected fixture value").map((profile: DevelopmentProfile) => offlineInputs(root, profile));
  const baseline = identities();
  for (const file of [
    "src/main.ts",
    "bundle/main.cjs.br",
    "scripts/ci-hosted.mjs",
    "tests/app.test.mjs",
    "workbench/decisions/ADR-00.md",
    "languages/c/automation.toml",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "ordinary checkout edit");
    expect(identities(), file).toEqual(baseline);
  }
  required(config.markdown, "Expected fixture value: config.markdown").wrap_width = 100;
  const offline = required(
    required(required(profiles, "Expected fixture value")[1], "Second profile").offline,
    "Offline configuration",
  );
  offline.verify = ["updated-verification"];
  offline.registry = "ghcr.io/example/another-repository";
  writeFileSync(join(root, "workbench/config.toml"), stringify(config));
  expect(identities()).toEqual(baseline);

  for (const [file, builder] of [
    ["channels.scm", "guix"],
    ["flake.lock", "nix"],
    [".node-version", "native"],
    ["examples/languages/php/.xdebug-version", "native"],
    ["scripts/native-assets.json", "native"],
    ["scripts/prepare-development.mjs", "native"],
    ["examples/languages/c/guix-toolchain.scm", "guix"],
    ["examples/languages/c/package.nix", "nix"],
  ] as const) {
    const path = join(root, required(file, "Expected fixture value")),
      original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\nchanged dependency input\n")]));
    for (const [index, identity] of identities().entries()) {
      if (required(required(profiles, "Expected fixture value")[index], "Expected fixture value").builder === builder)
        expect(identity, file).not.toBe(baseline[index]);
      else expect(identity, file).toBe(baseline[index]);
    }
    writeFileSync(path, original);
    expect(identities()).toEqual(baseline);
  }
  writeFileSync(join(root, "pnpm-lock.yaml"), "changed dependencies");
  expect(identities().every((identity, index) => identity !== baseline[index])).toBe(true);
});

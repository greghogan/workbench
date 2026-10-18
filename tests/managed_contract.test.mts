import { required } from "../src/invariants.ts";
import { expect, test } from "vitest";
import { resolve } from "node:path";
import { builderDirectory, builderVolumes, builderOwner, validateManagedPlan } from "../scripts/managed-contract.mjs";
import { managedDeclaration } from "../scripts/managed-source-contract.mjs";
const digest = "sha256-" + Buffer.alloc(32).toString("base64");
const source = () => ({ url: "https://example.test/source", hash: digest, destination: "npm/source.tgz" });
const plan = () => ({
  builder: "nix",
  cores: 2,
  maxJobs: 1,
  output: resolve("output"),
  imageRoot: resolve("image-root"),
  runtimeOwner: resolve("dependencies"),
  roots: [{ path: ".", profile: resolve("profile") }],
});
test("builder identity supplies the same namespace and paired volume layout to preparation and pruning", () => {
  expect(builderDirectory("cache", "checkout", "guix")).toContain(builderOwner("checkout"));
  expect(builderDirectory("cache", "checkout", "native")).toMatch(/native$/);
  expect(builderVolumes("guix", "a".repeat(24)).map((v) => v.destination)).toEqual(["/gnu", "/var/guix"]);
  expect(builderVolumes("nix", "a".repeat(24)).map((v) => v.destination)).toEqual(["/nix"]);
  expect(() => builderVolumes("native", "a".repeat(24))).toThrow(/identity/);
});
test.each([
  null,
  { cores: 0 },
  { maxJobs: 1.5 },
  { builder: "native" },
  { output: "relative" },
  { roots: [] },
  { roots: [{ path: "../bad", profile: resolve("profile") }] },
  {
    roots: [
      { path: ".", profile: resolve("profile") },
      { path: ".", profile: resolve("another") },
    ],
  },
  { builder: "guix" },
])("invalid preparation plans fail before commands run: %j", (change) => {
  expect(() => validateManagedPlan(change === null ? null : { ...plan(), ...change })).toThrow(
    /Invalid managed preparation plan/,
  );
});
test("a plan binds each selected root to its profile and gives Guix an explicit retained runtime", () => {
  expect(
    required(validateManagedPlan(plan()).roots[0], "Expected fixture value: validateManagedPlan(plan()).roots[0]").path,
  ).toBe(".");
  expect(
    validateManagedPlan({
      ...plan(),
      builder: "guix",
      runtime: resolve("runtime"),
      guix: [
        {
          channels: resolve("channels.scm"),
          runtime: resolve("runtime"),
          imageRoot: resolve("image-root"),
          roots: [0],
        },
      ],
    }).runtime,
  ).toBe(resolve("runtime"));
});
test.each([
  { guix: [] },
  { runtime: resolve("wrong-runtime") },
  { guix: [{ channels: "relative", runtime: resolve("runtime"), imageRoot: resolve("image"), roots: [0] }] },
  {
    guix: [{ channels: resolve("channels.scm"), runtime: resolve("runtime"), imageRoot: resolve("image"), roots: [1] }],
  },
  {
    guix: [
      { channels: resolve("channels.scm"), runtime: resolve("runtime"), imageRoot: resolve("image"), roots: [0, 0] },
    ],
  },
])("invalid Guix channel groups fail before activation: %j", (change) => {
  const guix = {
    ...plan(),
    builder: "guix",
    runtime: resolve("runtime"),
    guix: [{ channels: resolve("channels.scm"), runtime: resolve("runtime"), imageRoot: resolve("image"), roots: [0] }],
  };
  expect(() => validateManagedPlan({ ...guix, ...change })).toThrow(/Guix channel groups/);
});
test.each([
  null,
  { inputs: [null] },
  { source_hashes: { "../escape": "a".repeat(64) } },
  { source_hashes: { file: "bad" } },
  { registry: "yes" },
  { inputs: [{ ...source(), url: "http://example.test/source" }] },
  { inputs: [{ ...source(), url: "https://user:secret@example.test/source" }] },
  { inputs: [{ ...source(), hash: "sha256-eA==" }] },
  { inputs: [{ ...source(), destination: "C:\\escape" }] },
  { inputs: [{ ...source(), platforms: ["linux-riscv64"] }] },
  { inputs: [source(), source()] },
])("invalid source declarations fail with a useful diagnostic: %j", (change) => {
  expect(() =>
    managedDeclaration(
      change === null ? null : { schema_version: 1, source_hashes: {}, inputs: [source()], ...change },
    ),
  ).toThrow(/managed/i);
});

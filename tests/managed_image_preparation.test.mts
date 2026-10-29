import { promised } from "./fixtures/promised.mjs";
import { validateManagedPlan } from "../scripts/managed-contract.mjs";
import { required } from "../src/invariants.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { imageRoots, prepareHostManagedImage } from "../src/managed-image.ts";
import { CheckCancellation } from "../src/check-cancellation.ts";
import { inspectBuildCache, pruneBuildCache } from "../src/build-cache.ts";
import { guixProfileRegistrations } from "../src/managed-profiles.ts";
import { managedSystem } from "../scripts/managed-system.mjs";
import { buildPaths } from "../src/builds.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
test
  .skipIf(process.platform !== "linux")
  .each(
    (["guix", "nix"] as const).flatMap((builder) =>
      ["x64", "arm64"].map((architecture) => ({ builder, architecture })),
    ),
  )(
  "$builder host preparation for $architecture retains every root and holds dependency locks through assembly",
  async ({ builder, architecture }) => {
    const base = mkdtempSync(join(tmpdir(), "workbench-host-image-"));
    temporary.push(base);
    const root = join(base, "project"),
      output = join(base, "output");
    mkdirSync(join(root, "workbench"), { recursive: true });
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "channels.scm"), "root pin");
    writeFileSync(join(root, "other/channels.scm"), "independent pin");
    mkdirSync(join(root, "languages"));
    writeFileSync(join(root, "languages/index.toml"), "schema_version=1\nlanguages=[]\n");
    mkdirSync(output);
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    writeFileSync(
      join(root, "workbench/projects.toml"),
      '[[project]]\nid="probe"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="other"\n',
    );
    const roots = join(output, "roots.json");
    writeFileSync(roots, JSON.stringify([".", "other"]));
    expect(imageRoots(root)).toEqual([".", "other"]);
    expect(imageRoots(root, ["other"])).toEqual(["other"]);
    expect(() => imageRoots(root, ["unknown"])).toThrow(/registered/);
    expect(() => imageRoots(root, [".", "."])).toThrow(/distinct/);
    vi.stubEnv("WORKBENCH_CACHE_HOME", join(base, "cache"));
    vi.stubEnv("WORKBENCH_STORAGE_ROOT", join(base, "cache"));
    vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
    vi.stubEnv("GUIX_STATE_DIRECTORY", join(base, "guix"));
    vi.stubEnv("WORKBENCH_MANAGED_CORES", "2");
    vi.stubEnv("WORKBENCH_MANAGED_JOBS", "2");
    let plan: import("../scripts/managed-contract.mjs").ManagedPreparationPlan | undefined;
    vi.spyOn(CheckCancellation.prototype, "execute").mockImplementation((_command, _directory, env) =>
      promised(() => {
        plan = validateManagedPlan(
          JSON.parse(
            readFileSync(
              join(required(env.WORKBENCH_MANAGED_OUTPUT, "Expected fixture value"), "host-profiles.json"),
              "utf8",
            ),
          ),
        );
        expect(plan.system).toBe(managedSystem(architecture));
        expect(plan.runtimeOwner).not.toBe(
          buildPaths(root, root, builder, { architecture: architecture === "arm64" ? "x64" : "arm64" }).dependencies,
        );
        expect(plan.roots.map((root) => root.profile)).toHaveLength(2);
        const report = inspectBuildCache(root);
        expect(report.entries).toHaveLength(2);
        expect(report.entries.every((entry) => entry.blockedBy && existsSync(entry.blockedBy))).toBe(true);
        const target = join(base, "store-profile");
        mkdirSync(target);
        if (builder === "guix")
          expect(required(plan.guix, "Expected fixture value").map((group) => group.roots)).toEqual([[0], [1]]);
        for (const profile of [
          ...plan.roots.map((root) => root.profile),
          ...(plan.guix?.map((group) => group.runtime) ?? []),
          ...(plan.guix?.map((group) => group.manager) ?? []),
        ])
          symlinkSync(target, profile);
      }),
    );
    await prepareHostManagedImage(root, builder, "probe-image", roots, output, architecture);
    const report = inspectBuildCache(root);
    expect(report.entries.every((entry) => !entry.blockedBy)).toBe(true);
    if (builder === "guix")
      expect(
        existsSync(required(required(plan, "Expected fixture value: plan").runtime, "Expected fixture value")),
      ).toBe(true);
    else expect(required(plan, "Expected fixture value: plan").runtime).toBeUndefined();
    if (builder === "guix") {
      const selected = required(plan, "Managed plan");
      const environment = required(selected.roots[0], "Environment profile").profile;
      expect(guixProfileRegistrations(selected.runtimeOwner).map((entry) => entry.role)).toEqual([
        "environment",
        "runtime",
        "manager",
        "image",
      ]);
      expect(existsSync(environment)).toBe(true);
      expect(existsSync(required(selected.runtime, "Runtime profile"))).toBe(true);
      expect(existsSync(required(selected.roots[1], "Other environment profile").profile)).toBe(true);
    }
    await pruneBuildCache({ report: report, dependencies: true, apply: true });
    expect(
      required(plan, "Expected fixture value: plan")
        .roots.map((root) => root.profile)
        .every((profile: string) => !existsSync(profile)),
    ).toBe(true);
    if (required(plan, "Expected fixture value: plan").runtime)
      expect(
        existsSync(required(required(plan, "Expected fixture value: plan").runtime, "Expected fixture value")),
      ).toBe(false);
  },
);

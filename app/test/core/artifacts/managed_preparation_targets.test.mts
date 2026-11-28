import { required } from "../../../src/core/runtime/invariants.ts";
import { PreparationStore } from "../../../src/core/execution/environments/managed/managed-contract.mts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { managedPreparationFixtures } from "../../fixtures/managed-preparation.mjs";

const { fixture, run } = managedPreparationFixtures();

test.skipIf(process.platform !== "linux").each([false, true])(
  "Guix reuses the bootstrap manager for matching channels with foreign target %s",
  async (foreign) => {
    const f = fixture();
    const selected = "authenticated bootstrap channels";
    const manager = join(f.base, "manager"),
      output = join(f.base, "output");
    mkdirSync(join(manager, "bin"), { recursive: true });
    mkdirSync(output);
    for (const path of [join(f.bin, "guix"), join(manager, "bin", "guix")])
      writeFileSync(path, readFileSync(f.tool), { mode: 0o755 });
    writeFileSync(join(f.root, "channels.scm"), selected);
    const independent = join(f.root, "other/channels.scm");
    writeFileSync(independent, "different authenticated channels");
    const roots = join(output, "roots.json");
    writeFileSync(roots, JSON.stringify([".", "other"]));
    Object.assign(f.env, {
      WORKBENCH_ROOTS_FILE: roots,
      WORKBENCH_MANAGED_OUTPUT: output,
      WORKBENCH_GUIX_BOOTSTRAP_CHANNELS: createHash("sha256").update(selected).digest("hex"),
      WORKBENCH_GUIX_TIME_MACHINE_PROFILE: manager,
      WORKBENCH_IMAGE_ARCHITECTURE: foreign ? (process.arch === "arm64" ? "x64" : "arm64") : process.arch,
    });
    const result = await run(f, "guix", ["scripts/prepare-guix-profiles.mjs"]);
    expect(result.code, result.output).toBe(0);
    const lookups = result.calls.filter(({ args }) => args[0] === "time-machine");
    expect(lookups.map(({ args }) => args[2])).toEqual([independent]);
    const runtimeLookups = result.calls.filter(({ args }) => args[2] === "profile-for-system");
    expect(runtimeLookups).toHaveLength(foreign ? 2 : 0);
    const profiles = JSON.parse(readFileSync(join(output, "guix-profiles.json"), "utf8")) as {
      manager: string;
      runtime: string;
    }[];
    expect(profiles[0]?.manager).toBe(manager);
    if (foreign) expect(profiles[0]?.runtime).not.toBe(manager);
    else expect(profiles[0]?.runtime).toBe(manager);
  },
);

test.skipIf(process.platform !== "linux")(
  "Guix assembly materializes account files after importing its closure",
  async () => {
    const f = fixture();
    f.env.FIXTURE_BUILDER = "guix";
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    const result = await run(f, "guix");
    expect(result.code, result.output).toBe(0);
    const imported = result.calls.findIndex(
      (call) => call.name === "docker" && call.args[0] === "tag" && call.args.at(-1) === "fixture-output",
    );
    const finalized = result.calls.findIndex((call) => call.name === "docker" && call.args[0] === "commit");
    expect(imported).toBeGreaterThan(-1);
    expect(finalized).toBeGreaterThan(imported);
    expect(result.calls.filter((call) => call.args[0] === "cp" && call.args.includes("--follow-link"))).toHaveLength(2);
    expect(required(result.calls[finalized], "Expected fixture value").args.at(-1)).toBe("fixture-output");
    expect(existsSync((JSON.parse(readFileSync(f.state, "utf8")) as { output: string }).output)).toBe(false);
  },
);

test.skipIf(process.platform !== "linux").each(["nix", "guix"])(
  "%s foreign preparation reuses the host manager with target-specific profiles",
  async (builder) => {
    const f = fixture();
    f.env.WORKBENCH_PREPARATION_STORE = PreparationStore.System;
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    f.env.WORKBENCH_IMAGE_ARCHITECTURE = architecture;
    f.env.FIXTURE_BUILDER = builder;
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    writeFileSync(join(f.bin, builder), readFileSync(f.tool), { mode: 0o755 });
    const result = await run(f, builder);
    expect(result.code, result.output).toBe(0);
    expect(result.calls.some((call) => call.name === builder)).toBe(true);
    expect(result.output).toContain("host store");
    expect(
      result.calls.some(
        (call) =>
          call.name === builder &&
          call.args.some((arg) => arg.includes(architecture === "x64" ? "x86_64-linux" : "aarch64-linux")),
      ),
    ).toBe(true);
    expect(
      result.calls.some((call) => call.name === "docker" && call.args[0] === "buildx" && call.args[1] === "build"),
    ).toBe(false);
  },
);

test.skipIf(process.platform !== "linux").each(["nix", "guix"])(
  "%s missing-manager preparation keeps the Docker manager native and passes the foreign target",
  async (builder) => {
    const f = fixture();
    const architecture = process.arch === "arm64" ? "x64" : "arm64";
    f.env.WORKBENCH_IMAGE_ARCHITECTURE = architecture;
    f.env.FIXTURE_BUILDER = builder;
    writeFileSync(join(f.root, "channels.scm"), "fixture channel pin");
    const result = await run(f, builder);
    expect(result.code, result.output).toBe(0);
    const create = required(
      result.calls.find(
        (call) =>
          call.name === "docker" &&
          call.args[0] === "create" &&
          call.args.some((arg) => arg.startsWith("WORKBENCH_PRIVATE_BUILDER=")),
      ),
      "Builder container",
    );
    expect(create.args).toContain(`linux/${process.arch === "x64" ? "amd64" : "arm64"}`);
    expect(create.args).toContain(`WORKBENCH_IMAGE_ARCHITECTURE=${architecture}`);
  },
);

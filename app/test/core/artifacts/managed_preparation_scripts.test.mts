import { required } from "../../../src/core/runtime/invariants.ts";
import { PreparationStore } from "../../../src/core/execution/environments/managed/managed-contract.mts";
import { selectPreparationStore } from "../../../src/core/artifacts/preparation-store.ts";
import { pendingManagedPreparations } from "../../../src/core/storage/managed-preparation.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  importManagedProfiles,
  readManagedProfileArchive,
} from "../../../src/core/execution/environments/managed/profile-transfer.mjs";
import { managedPreparationFixtures } from "../../fixtures/managed-preparation.mjs";

const { temporary, fixture, run } = managedPreparationFixtures();

test("a managed transfer matches the requested roots before any payload reaches a manager", async () => {
  const folder = mkdtempSync(join(tmpdir(), "workbench-manager-transfer-"));
  temporary.push(folder);
  const file = join(folder, "dev.archive");
  const expected = { builder: "nix", architecture: "x64", kind: "development", roots: [".", "apps/client"] } as const;
  const profiles = [
    { path: ".", profile: `/nix/store/${"a".repeat(32)}-root` },
    { path: "apps/client", profile: `/nix/store/${"b".repeat(32)}-client` },
  ];
  const payload = Buffer.from([0, 148, 255]);
  const writeArchive = (selected: typeof profiles) => {
    const metadata = Buffer.from(JSON.stringify({ version: 1, ...expected, profiles: selected }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(metadata.length);
    writeFileSync(file, Buffer.concat([prefix, metadata, payload]));
  };

  writeArchive(profiles);
  const selection = { ...expected, roots: [...expected.roots] };
  const opened = await readManagedProfileArchive(file, selection);
  expect(opened.profiles).toEqual(profiles);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.payload()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks)).toEqual(payload);
  const isolated = { env: { PATH: folder } };
  await expect(importManagedProfiles(file, { ...selection, architecture: "arm64" }, isolated)).rejects.toThrow(
    /manager, architecture, and kind/,
  );
  await expect(importManagedProfiles(file, { ...selection, roots: ["."] }, isolated)).rejects.toThrow(/project roots/);
  writeArchive([{ path: ".", profile: `/gnu/store/${"a".repeat(32)}-wrong-store` }]);
  await expect(importManagedProfiles(file, selection, isolated)).rejects.toThrow(/immutable store output/);
});

test.skipIf(process.platform !== "linux")(
  "local preparation reports a missing selected daemon with its startup command",
  async () => {
    const { base, bin, root } = fixture();
    const config = join(base, "config");
    mkdirSync(config);
    vi.stubEnv("WORKBENCH_CONFIG_HOME", config);
    vi.stubEnv("PATH", bin);
    await expect(selectPreparationStore("guix", root)).rejects.toThrow("Guix image preparation is disabled");
    expect(await selectPreparationStore("native", root)).toBeUndefined();
    writeFileSync(join(config, "config.toml"), '[preparation]\nguix_store = "system"\n');
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf 'loaded\\n'\n", { mode: 0o755 });
    await expect(selectPreparationStore("guix", root)).rejects.toThrow(
      /sudo systemctl start guix-daemon\.service[\s\S]+preparation\.guix_store managed/,
    );
    writeFileSync(join(bin, "guix"), '#!/bin/sh\n[ "$*" = "gc --list-roots" ]\n', { mode: 0o755 });
    expect(await selectPreparationStore("guix", root)).toBe(PreparationStore.System);
    writeFileSync(join(config, "config.toml"), '[preparation]\nguix_store = "managed"\n');
    expect(await selectPreparationStore("guix", root)).toBe(PreparationStore.Managed);
  },
);

test.skipIf(process.platform !== "linux").each(["system", "managed", "broken", "cleanup-fails"])(
  "preparation honors the selected %s store",
  async (condition) => {
    const f = fixture();
    writeFileSync(join(f.bin, "nix"), readFileSync(f.tool), { mode: 0o755 });
    if (["system", "broken"].includes(condition)) f.env.WORKBENCH_PREPARATION_STORE = PreparationStore.System;
    if (condition === "broken") f.env.BROKEN_MANAGER = "1";
    if (condition === "cleanup-fails") f.env.FAIL_CLEANUP = "1";
    const result = await run(f);
    if (condition === "broken") {
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("status=7");
      expect(result.calls.some((c) => c.name === "docker")).toBe(false);
    } else if (condition === "cleanup-fails") {
      expect(result.code).not.toBe(0);
      expect(result.calls.some((c) => c.name === "docker" && c.args[0] === "image" && c.args[1] === "rm")).toBe(true);
      const state = JSON.parse(readFileSync(f.state, "utf8")) as { output: string };
      expect(existsSync(state.output)).toBe(false);
    } else {
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(condition === "system" ? "host store" : "managed Docker store");
      expect(
        result.calls.some((c) => c.name === "docker" && c.args[0] === "tag" && c.args.at(-1) === "fixture-output"),
      ).toBe(true);
      if (condition === "system")
        expect(result.calls.filter((c) => c.name === "nix" && c.args.includes("--profile"))).toHaveLength(2);
      else {
        expect(result.calls.some((c) => c.name === "nix")).toBe(false);
        expect(existsSync((JSON.parse(readFileSync(f.state, "utf8")) as { output: string }).output)).toBe(false);
      }
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a failed Docker start leaves the exact preparation scope for recovery",
  async () => {
    const f = fixture();
    const cache = required(f.env.WORKBENCH_CACHE_HOME, "Missing fixture cache");
    f.env.WORKBENCH_PREPARATION_PROFILE = "linux";
    f.env.FAIL_MANAGED_CREATE = "1";
    vi.stubEnv("WORKBENCH_CACHE_HOME", cache);
    const result = await run(f);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("fixture builder could not start");
    const issues: string[] = [];
    const data = pendingManagedPreparations(f.root, issues);
    const [receipt] = data;
    expect(issues).toEqual([]);
    expect(data).toHaveLength(1);
    expect(receipt?.value).toMatchObject({
      checkout: f.root,
      profile: "linux",
      builder: "nix",
      inputs: f.env.WORKBENCH_IMAGE_INPUTS,
      architecture: process.arch,
    });
    const mountedStore = join(
      cache,
      "managed-stores",
      "nix",
      required(receipt, "Missing preparation receipt").value.key,
      "store",
    );
    expect(result.calls.some(({ args }) => args.includes(`device=${mountedStore}`))).toBe(true);
  },
);

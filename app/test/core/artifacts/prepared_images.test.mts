import { RegistryProvider } from "../../../src/core/artifacts/registry-management-contract.ts";
import { completedProcess } from "../../fixtures/process.mjs";
import { required } from "../../../src/core/runtime/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { autoPrunePreparedImages } from "../../../src/core/artifacts/image-retention.ts";
import { imageProfileLock, imageProfileReceipt, preparedImageTag } from "../../../src/core/artifacts/image-contract.ts";
import {
  forgetPreparedStorePin,
  preparedImageEvidence,
  storePinForImage,
} from "../../../src/core/artifacts/local-images.ts";
import { offlineInputs, offlineProfile } from "../../../src/core/artifacts/offline-profiles.ts";
import { setUserOption } from "../../../src/core/configuration/user-config.ts";
import {
  managedProfileOwner,
  partialManagedStorePin,
  type ManagedStorePin,
} from "../../../src/core/execution/environments/managed/managed-contract.mjs";
import { inspectManagedStorePins } from "../../../src/core/storage/managed-store-pins.ts";
import { pruneBuilderCache } from "../../../src/core/storage/builder-cache.ts";
import { recordManagedPreparation } from "../../../src/core/storage/managed-preparation.ts";
import { keepCacheAsset } from "../../../src/core/projects/project-registry.ts";
import {
  recordPreparedImage,
  inspectPreparedImages,
  registryImageStatus,
  inspectRegistryImages,
  prunePreparedImages,
  preparedImageSource,
} from "../../../src/core/artifacts/prepared-images.ts";

const state = vi.hoisted(() => ({
  images: new Map<string, { Id: string; Size: number; Config: { Labels: Record<string, string> } }>(),
  attached: false,
  manifest: "",
  versions: [] as { id: number; name: string; created_at: string; metadata: { container: { tags: string[] } } }[],
  fail: "",
  removed: [] as (string | undefined)[],
}));
vi.mock("../../../src/core/toolchains/acquisition/network-command.mts", async (original) => ({
  ...(await original<typeof import("../../../src/core/toolchains/acquisition/network-command.mts")>()),
  acquireCommand: vi.fn<typeof import("../../../src/core/toolchains/acquisition/network-command.mts").acquireCommand>(
    async (_operation, command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      if (result.error || result.status !== 0) {
        const { AcquisitionRejected } = await import("../../../src/core/toolchains/acquisition/network-retry.mts");
        const { classifyAcquisitionOutput } =
          await import("../../../src/core/toolchains/acquisition/network-command.mts");
        throw new AcquisitionRejected(result.stderr, { cause: result.error }, classifyAcquisitionOutput(result.stderr));
      }
      return result.stdout;
    },
  ),
}));
vi.mock("../../../src/core/artifacts/docker-query.js", () => ({
  dockerQuery: (args: string[]) => {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.error || result.status !== 0) return Promise.reject(new Error(result.stderr, { cause: result.error }));
    return Promise.resolve(result.stdout.trim());
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (
      command: string,
      args: string[],
      options: import("node:child_process").SpawnSyncOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const result = spawnSync(command, args, options);
      callback(
        result.status === 0 ? null : new Error(String(result.stderr)),
        String(result.stdout),
        String(result.stderr),
      );
    },
  ),
  spawnSync: vi.fn((command: string, args: string[]) => {
    let output: unknown = "";
    if (state.fail && args.some((arg: string | string[]) => arg.includes(state.fail)))
      return completedProcess({ status: 1, stderr: "permission denied (HTTP 403)" });
    if (command === "docker") {
      if (args[0] === "info") output = "fixture-engine";
      else if (args[0] === "manifest") {
        if (state.manifest) return completedProcess({ status: 1, stderr: state.manifest });
        output = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" };
      } else if (args[1] === "ls") output = [...state.images.keys()].join("\n");
      else if (args[1] === "inspect") output = args.slice(2).map((reference) => state.images.get(reference));
      else if (args[0] === "ps") output = state.attached ? "container-id" : "";
      else if (args[1] === "rm") {
        state.removed.push(args.at(-1));
        state.images.delete(required(args.at(-1), "Expected fixture value"));
      } else throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
    } else if (command === "gh") {
      if (args.includes("DELETE")) state.removed.push(args.at(-1));
      else if (args.at(-1) === "users/owner") output = { type: "User" };
      else if (args.at(-1)?.includes("/versions?")) output = state.versions;
      else
        output = state.versions.find((version) =>
          required(args.at(-1), "Expected fixture value").endsWith(`/${String(version.id)}`),
        );
    } else throw new Error(`Unexpected executable: ${command}`);
    return completedProcess({ stdout: typeof output === "string" ? output : JSON.stringify(output) });
  }),
}));
vi.mock("../../../src/core/artifacts/registry-api.ts", () => ({
  registryRequest: (
    management: import("../../../src/core/artifacts/registry-management-contract.ts").RegistryManagement,
    endpoint: string,
    options?: { method?: string },
  ) => {
    const result = spawnSync(
      management.provider === RegistryProvider.GHCR ? "gh" : "glab",
      ["api", "--hostname", management.host, ...(options?.method ? ["--method", options.method] : []), endpoint],
      { encoding: "utf8" },
    );
    if (result.status !== 0 || result.error) throw new Error(result.stderr, { cause: result.error });
    return Promise.resolve(options?.method === "DELETE" ? undefined : (JSON.parse(result.stdout) as unknown));
  },
}));
const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-images-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  state.images.clear();
  state.attached = false;
  state.manifest = "";
  state.fail = "";
  state.removed = [];
  const inputs = "a".repeat(64),
    image = `sha256:${"b".repeat(64)}`;
  const tag = `linux-x64-${inputs}`,
    reference = `ghcr.io/owner/project/development-guix:${tag}`;
  const receipt = { inputs, image, platform: "linux-x64", verified: "2026-10-20T00:00:00Z" };
  state.images.set(reference, { Id: image, Size: 1234000, Config: { Labels: { "org.workbench.inputs": inputs } } });
  state.versions = [{ id: 42, name: image, created_at: receipt.verified, metadata: { container: { tags: [tag] } } }];
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    `schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[[development.profiles]]\nname="guix"\nbuilder="guix"\nworkspace="host"\ncontainer_config=".devcontainer/guix/devcontainer.json"\n[development.profiles.offline]\nregistry="ghcr.io/owner/project/development-guix"\ninputs=["manifest.scm"]\nverify=["verify"]\n`,
  );
  recordPreparedImage(root, "guix", reference, receipt);
  return { root, image, inputs, reference, receipt };
}

test("verified image history provides local ownership, sizes, and survives explicit Docker deletion", async () => {
  const { root, reference } = fixture();
  const report = inspectPreparedImages(root);
  expect(report.issues).toEqual([]);
  expect(report.entries).toHaveLength(1);
  const [entry] = report.entries;
  expect(required(entry, "Expected fixture value: entry").bytes).toBe(1234000);
  const catalog = readFileSync(required(entry, "Expected fixture value: entry").catalog);
  const events: string[] = [];
  await prunePreparedImages(report, {
    begin: () => undefined,
    start: (label) => {
      events.push(label);
    },
    complete: () => {
      events.push("complete");
    },
  });
  expect(state.removed).toEqual([reference]);
  expect(events).toHaveLength(2);
  expect(inspectPreparedImages(root).entries).toEqual([]);
  expect(readFileSync(required(entry, "Expected fixture value: entry").catalog)).toEqual(catalog);
});

test.skipIf(process.platform !== "linux")(
  "an interrupted preparation protects its roots until the matching store generation is catalogued",
  async () => {
    const { root, image, inputs, reference } = fixture();
    vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "user-config"));
    setUserOption("preparation.guix_store", "managed");
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
    const key = "b".repeat(24);
    const owner = managedProfileOwner(root, "guix");
    const generation = join(
      root,
      "cache",
      "managed-stores",
      "guix",
      key,
      "state",
      "gcroots",
      "workbench",
      owner,
      inputs,
    );
    const stage = join(dirname(generation), partialManagedStorePin(inputs));
    mkdirSync(stage, { recursive: true });
    recordManagedPreparation({ checkout: root, profile: "guix", architecture: "x64", inputs, builder: "guix", key });
    let report = await inspectManagedStorePins(root);
    expect(report.issues).toEqual([]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ status: "preparation pending", checkout: root });
    expect(report.entries[0]?.blockedBy).toContain("prepare guix --build");
    renameSync(stage, generation);
    const pin: ManagedStorePin = {
      builder: "guix",
      key,
      roots: [`/gnu/store/${"a".repeat(32)}-profile`],
      archive: `/gnu/store/${"b".repeat(32)}-image`,
    };
    recordPreparedImage(root, "guix", reference, {
      image,
      inputs,
      platform: "linux-x64",
      assembled: "2026-10-20T00:00:00Z",
      storePin: pin,
    });
    report = await inspectManagedStorePins(root);
    expect(report.issues).toEqual([]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.status).not.toBe("preparation pending");
    expect(report.entries[0]?.blockedBy).toBe("image verification is pending");
  },
);

test.skipIf(process.platform !== "linux")(
  "a same-tag store replacement releases old roots only after exact profile verification",
  async () => {
    const { root, receipt } = fixture();
    vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "user-config"));
    vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
    setUserOption("preparation.guix_store", "managed");
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="probe"\npath="."\n');
    const config = join(root, ".devcontainer/guix/devcontainer.json");
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "{}");
    writeFileSync(join(root, "manifest.scm"), "fixture");
    const inputs = offlineInputs(root, offlineProfile(root, "guix"), "x64");
    const reference = `ghcr.io/owner/project/development-guix:${preparedImageTag("x64", inputs)}`;
    const makePin = (digit: string): ManagedStorePin => {
      const pin: ManagedStorePin = {
        builder: "guix",
        key: digit.repeat(24),
        roots: [`/gnu/store/${digit.repeat(32)}-profile`],
        archive: `/gnu/store/${digit.repeat(32)}-image.tar`,
      };
      const store = join(root, "cache/managed-stores/guix", pin.key);
      const generation = join(store, "state/gcroots/workbench", managedProfileOwner(root, "guix"), inputs);
      mkdirSync(generation, { recursive: true });
      writeFileSync(join(store, ".workbench-maintenance-image"), receipt.image + "\n");
      symlinkSync(pin.archive, join(generation, "archive"), "file");
      const [target] = pin.roots;
      if (!target) throw new Error("Fixture profile has no root");
      mkdirSync(join(store, "store", target.slice("/gnu/".length)), { recursive: true });
      symlinkSync(target, join(generation, "0"), "dir");
      return pin;
    };
    const previous = { ...receipt, inputs, storePin: makePin("a") };
    const accepted = imageProfileReceipt(root, "guix", "x64");
    mkdirSync(dirname(accepted), { recursive: true });
    writeFileSync(accepted, JSON.stringify({ ...previous, version: 1, profile: "guix" }));
    recordPreparedImage(root, "guix", reference, previous);
    const replacement = { ...previous, storePin: makePin("b"), verified: "2026-10-22T00:00:00Z" };
    const { verified, ...staged } = replacement;
    state.images.set(reference, { Id: replacement.image, Size: 21, Config: { Labels: {} } });
    recordPreparedImage(root, "guix", reference, { ...staged, assembled: verified });
    expect(storePinForImage(root, "guix", reference, receipt.image, inputs)).toEqual(replacement.storePin);
    expect(
      preparedImageEvidence([], root).find(({ record }) => record.reference === reference)?.record.priorStorePins,
    ).toMatchObject([{ profile: "guix", inputs, storePin: previous.storePin, verified: previous.verified }]);
    const before = await inspectManagedStorePins(root);
    expect(before.issues).toEqual([]);
    expect(before.entries.map(({ cleanup, blockedBy }) => [cleanup?.pin.key, cleanup?.release, blockedBy])).toEqual([
      [previous.storePin.key, "archive", undefined],
      [replacement.storePin.key, "archive", "image verification is pending"],
    ]);

    recordPreparedImage(root, "guix", reference, replacement);
    writeFileSync(accepted, JSON.stringify({ ...replacement, version: 1, profile: "guix" }));
    const after = await inspectManagedStorePins(root);
    expect(after.issues).toEqual([]);
    expect(after.entries.map(({ cleanup, blockedBy }) => [cleanup?.pin.key, cleanup?.release, blockedBy])).toEqual([
      [previous.storePin.key, "generation", undefined],
      [replacement.storePin.key, "archive", undefined],
    ]);
    const retirement = required(after.entries[0], "Superseded managed profile");
    await expect(
      pruneBuilderCache(
        { entries: [retirement], issues: [] },
        {
          begin: () => undefined,
          start: () => {
            setUserOption("preparation.guix_store", "disabled");
          },
          complete: () => undefined,
        },
      ),
    ).rejects.toThrow("preparation store is disabled");
    expect(existsSync(required(retirement.cleanup, "Managed retirement").journal)).toBe(false);
    setUserOption("preparation.guix_store", "managed");
    expect((await inspectManagedStorePins(root)).entries[0]?.cleanup?.release).toBe("generation");
    rmSync(join(root, "cache/managed-stores/guix", replacement.storePin.key, "store"), { recursive: true });
    const missing = await inspectManagedStorePins(root);
    expect(missing.entries.find(({ cleanup }) => cleanup?.pin.key === previous.storePin.key)?.cleanup?.release).toBe(
      "archive",
    );
    const catalog = () =>
      required(
        preparedImageEvidence([], root).find(({ record }) => record.reference === reference),
        "Prepared image",
      );
    forgetPreparedStorePin(catalog().path, managedProfileOwner(root, "unrelated"), inputs, previous.storePin);
    expect(catalog().record.priorStorePins).toHaveLength(1);
    forgetPreparedStorePin(catalog().path, managedProfileOwner(root, "guix"), inputs, previous.storePin);
    expect(catalog().record.priorStorePins).toBeUndefined();
    expect(catalog().record.verified).toBe(replacement.verified);
    expect(storePinForImage(root, "guix", reference, replacement.image, inputs)).toEqual(replacement.storePin);
  },
);

test("automatic image maintenance retires superseded local images after activation and respects explicit keeps", async () => {
  const { root, reference, receipt } = fixture();
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  const inputs = "c".repeat(64),
    image = `sha256:${"d".repeat(64)}`;
  const replacement = `ghcr.io/owner/project/development-guix:linux-x64-${inputs}`;
  state.images.set(replacement, { Id: image, Size: 1234, Config: { Labels: { "org.workbench.inputs": inputs } } });
  const verified = { ...receipt, image, inputs, verified: "2026-10-21T00:00:00Z" };
  recordPreparedImage(root, "guix", replacement, verified);
  const current = imageProfileReceipt(root, "guix", receipt.platform.slice("linux-".length));
  mkdirSync(dirname(current), { recursive: true });
  writeFileSync(current, JSON.stringify({ version: 1, profile: "guix", ...verified }));
  const retained = required(
    inspectPreparedImages(root).entries.find((entry) => entry.reference === reference),
    "old image",
  );
  keepCacheAsset(retained.catalog, true);
  await autoPrunePreparedImages(root);
  expect(state.removed).toEqual([]);
  keepCacheAsset(retained.catalog, false);
  await autoPrunePreparedImages(root);
  expect(state.removed).toEqual([reference]);
  expect(state.images.has(replacement)).toBe(true);
});

test("both platform receipts retain their images under separate operation locks", async () => {
  const { root } = fixture();
  const replacements: string[] = [];
  for (const [architecture, digit] of [
    ["x64", "c"],
    ["arm64", "d"],
  ] as const) {
    const inputs = digit.repeat(64),
      image = `sha256:${digit.repeat(64)}`;
    const reference = `ghcr.io/owner/project/development-guix:linux-${architecture}-${inputs}`;
    const receipt = { inputs, image, platform: `linux-${architecture}`, verified: "2026-10-21T00:00:00Z" };
    state.images.set(reference, { Id: image, Size: 1234, Config: { Labels: { "org.workbench.inputs": inputs } } });
    recordPreparedImage(root, "guix", reference, receipt);
    const path = imageProfileReceipt(root, "guix", architecture);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, profile: "guix", ...receipt }));
    replacements.push(reference);
  }
  const report = inspectPreparedImages(root);
  expect(new Set(report.entries.map((entry) => entry.lock))).toEqual(
    new Set([imageProfileLock(root, "guix", "x64"), imageProfileLock(root, "guix", "arm64")]),
  );
  expect(new Set(report.entries.map((entry) => entry.receipt)).size).toBe(2);
  await autoPrunePreparedImages(root);
  expect(replacements.every((reference) => state.images.has(reference))).toBe(true);
  expect(
    inspectPreparedImages(root)
      .entries.map((entry) => entry.reference)
      .sort(),
  ).toEqual(replacements.sort());
});

test("local pruning never claims unrecorded images or another checkout's verified image", () => {
  const { root, reference, receipt } = fixture();
  state.images.set("unrelated:latest", required(state.images.get(reference), "Expected fixture value"));
  expect(inspectPreparedImages(join(root, "other")).entries).toEqual([]);
  recordPreparedImage(join(root, "other"), "guix", `${reference}-other`, receipt);
  expect(inspectPreparedImages(root).entries).toHaveLength(1);
});

test("assembled images remain removable after failed verification without claiming successful preparation", async () => {
  const { root, reference, receipt } = fixture();
  const next = {
    inputs: receipt.inputs,
    platform: receipt.platform,
    image: `sha256:${"c".repeat(64)}`,
    assembled: "2026-10-20T01:00:00Z",
  };
  required(state.images.get(reference), "Expected fixture value").Id = next.image;
  recordPreparedImage(root, "guix", reference, next);
  const report = inspectPreparedImages(root);
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").verified).toBeUndefined();
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").blockedBy).toBeUndefined();
  await prunePreparedImages(report);
  expect(state.removed).toEqual([reference]);
});

test("reusing an already verified image does not erase its accepted history before revalidation", () => {
  const { root, reference, receipt } = fixture();
  const before = inspectPreparedImages(root).entries[0];
  recordPreparedImage(root, "guix", reference, {
    inputs: receipt.inputs,
    image: receipt.image,
    platform: receipt.platform,
    assembled: "2026-10-21T00:00:00Z",
  });
  expect(
    required(inspectPreparedImages(root).entries[0], "Expected fixture value: inspectPreparedImages(root).entries[0]")
      .identity,
  ).toBe(required(before, "Expected fixture value: before").identity);
});

test("damaged verification metadata cannot turn an assembled image into accepted evidence", () => {
  const { root } = fixture();
  const path = required(
    inspectPreparedImages(root).entries[0],
    "Expected fixture value: inspectPreparedImages(root).entries[0]",
  ).catalog;
  const record = JSON.parse(readFileSync(path, "utf8")) as { verified?: unknown; assembled?: string };
  record.verified = true;
  record.assembled = "2026-10-20T00:00:00Z";
  writeFileSync(path, JSON.stringify(record));
  expect(inspectPreparedImages(root).issues.join("\n")).toMatch(/invalid prepared image ownership/);
});

test.each(["attached", "replaced", "locked", "catalog"])(
  "local image deletion rechecks %s after selection",
  async (condition) => {
    const { root, reference } = fixture();
    const report = inspectPreparedImages(root),
      [entry] = report.entries;
    if (condition === "attached") state.attached = true;
    else if (condition === "replaced")
      required(state.images.get(reference), "Expected fixture value").Id = `sha256:${"c".repeat(64)}`;
    else if (condition === "locked")
      mkdirSync(`${required(entry, "Expected fixture value: entry").lock}.lock`, { recursive: true });
    else {
      const record = JSON.parse(readFileSync(required(entry, "Expected fixture value: entry").catalog, "utf8")) as {
        verified?: string;
      };
      record.verified = "2026-10-21T00:00:00Z";
      writeFileSync(required(entry, "Expected fixture value: entry").catalog, JSON.stringify(record));
    }
    await expect(prunePreparedImages(report)).rejects.toThrow();
    expect(state.removed).toEqual([]);
  },
);

test("attached images and mismatched ownership stay visible but unavailable for pruning", async () => {
  const { root, reference } = fixture();
  state.attached = true;
  let report = inspectPreparedImages(root);
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").blockedBy).toMatch(
    /Docker container/,
  );
  await expect(prunePreparedImages(report)).rejects.toThrow(/not removable/);
  state.attached = false;
  required(state.images.get(reference), "Expected fixture value").Config.Labels["org.workbench.inputs"] = "f".repeat(
    64,
  );
  keepCacheAsset(required(report.entries[0], "owned image").catalog, true);
  report = inspectPreparedImages(root);
  expect(required(report.entries[0], "changed image").blockedReason).toBe("changed");
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").blockedBy).toMatch(/receipt/);
});

test("registry availability reads manifests without pulling, and distinguishes absence from authentication or transport failure", async () => {
  const { reference } = fixture();
  expect(await registryImageStatus(reference)).toEqual({ state: "available" });
  state.manifest = "manifest unknown";
  expect(await registryImageStatus(reference)).toEqual({ state: "missing" });
  state.manifest = "unauthorized: authentication required";
  expect(await registryImageStatus(reference)).toMatchObject({
    state: "unavailable",
    detail: expect.stringContaining(state.manifest) as unknown,
  });
  state.manifest = "TLS handshake timeout";
  expect((await registryImageStatus(reference)).state).toBe("unavailable");
  await expect(registryImageStatus("invalid")).rejects.toThrow(/reference/);
  expect(
    vi.mocked(spawnSync).mock.calls.some(([, args]) => required(args, "Expected fixture value: args")[0] === "pull"),
  ).toBe(false);
});

test("GHCR inventory offers only prepared-image tags and protects versions with unrelated tags", async () => {
  const { root } = fixture();
  state.versions.push({
    ...required(state.versions[0], "Registry version"),
    id: 43,
    metadata: { container: { tags: ["latest"] } },
  });
  const report = await inspectRegistryImages(root);
  expect(report.issues).toEqual([]);
  expect(report.entries).toHaveLength(1);
  expect(required(report.entries[0], "Expected fixture value: report.entries[0]").endpoint).toBe(
    "users/owner/packages/container/project%2Fdevelopment-guix/versions/42",
  );
  await prunePreparedImages(report);
  expect(state.removed).toEqual([required(report.entries[0], "Expected fixture value: report.entries[0]").endpoint]);
  required(state.versions[0], "Expected fixture value: state.versions[0]").metadata.container.tags.push("latest");
  const protected_ = await inspectRegistryImages(root);
  expect(required(protected_.entries[0], "Expected fixture value: protected_.entries[0]").blockedBy).toMatch(
    /outside Workbench/,
  );
  await expect(prunePreparedImages(protected_)).rejects.toThrow(/not removable/);
});

test("GHCR pruning detects changes to the complete selected version before deleting anything", async () => {
  const { root } = fixture();
  const report = await inspectRegistryImages(root);
  required(state.versions[0], "Expected fixture value: state.versions[0]").metadata.container.tags.push("release");
  await expect(prunePreparedImages(report)).rejects.toThrow(/changed/);
  expect(state.removed).toEqual([]);
});

test("registry inspection failures never produce an actionable deletion set", async () => {
  const { root } = fixture();
  state.fail = "/versions";
  const report = await inspectRegistryImages(root);
  expect(report.issues).toHaveLength(1);
  await expect(prunePreparedImages(report)).rejects.toThrow(/HTTP 403/);
  expect(state.removed).toEqual([]);
});

test("an unavailable repository cannot prevent explicit cleanup of independently revalidated registry versions", async () => {
  const { root } = fixture();
  const report = await inspectRegistryImages(root);
  report.issues.push("Another configured image repository is unavailable");
  await prunePreparedImages(report);
  expect(state.removed).toEqual([required(report.entries[0], "Expected fixture value: report.entries[0]").endpoint]);
});

test.each([
  ["git@github.com:owner/project.git", "https://github.com/owner/project"],
  ["https://github.com/owner/project.git", "https://github.com/owner/project"],
  ["https://user:secret@github.com/owner/project.git", undefined],
  ["https://github.com/owner/project\nLABEL injected=value", undefined],
  ["/local/checkout", undefined],
])("source annotation normalizes %s without exposing credentials or accepting recipe injection", (remote, expected) => {
  vi.mocked(spawnSync).mockReturnValueOnce(completedProcess({ stdout: remote }));
  expect(preparedImageSource("/project")).toBe(expected);
});

test("batched inventories scope references and share container probes for identical image IDs", () => {
  const { root, reference, receipt } = fixture();
  const alias = reference.replace(":linux-x64-", ":linux-arm64-");
  state.images.set(alias, required(state.images.get(reference), "Expected fixture value"));
  recordPreparedImage(root, "guix", alias, { ...receipt, platform: "linux-arm64" });
  vi.mocked(spawnSync).mockClear();
  expect(inspectPreparedImages(root).entries).toHaveLength(2);
  const calls = vi.mocked(spawnSync).mock.calls;
  expect(
    calls.filter(
      ([, args]) =>
        required(args, "Expected fixture value: args")[0] === "image" &&
        required(args, "Expected fixture value: args")[1] === "inspect",
    ),
  ).toHaveLength(1);
  expect(calls.filter(([, args]) => required(args, "Expected fixture value: args")[0] === "ps")).toHaveLength(1);
  vi.mocked(spawnSync).mockClear();
  expect(inspectPreparedImages(root, new Set([reference])).entries).toHaveLength(1);
  expect(
    required(
      vi
        .mocked(spawnSync)
        .mock.calls.find(([, args]) => required(args, "Expected fixture value: args")[1] === "inspect"),
      'Expected fixture value: vi.mocked(spawnSync).mock.calls.find(([, args]) => args[1] === "inspect")',
    )[1],
  ).toEqual(["image", "inspect", reference]);
});

test("damaged historical records produce diagnostics and prevent deletion of the remaining offered set", async () => {
  const { root, reference, receipt } = fixture();
  const other = reference.replace(":linux-x64-", ":linux-arm64-");
  state.images.set(other, required(state.images.get(reference), "Expected fixture value"));
  recordPreparedImage(root, "guix", other, receipt);
  const record = inspectPreparedImages(root).entries.find((entry) => entry.reference === other);
  writeFileSync(required(record, "Expected fixture value: record").catalog, "invalid json");
  const report = inspectPreparedImages(root);
  expect(report.entries.map((entry) => entry.reference)).toEqual([reference]);
  expect(report.issues.join("\n")).toContain(required(record, "Expected fixture value: record").catalog);
  await expect(prunePreparedImages(report)).rejects.toThrow(/Cannot revalidate/);
  expect(state.removed).toEqual([]);
});

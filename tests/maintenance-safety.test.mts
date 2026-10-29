import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { applyMaintenance } from "../scripts/maintenance/apply.mjs";
import { developmentDiscovery, discoverMaintenance } from "../scripts/maintenance/plan.mjs";
import { MaintenanceState, type Release } from "../scripts/maintenance/contract.mjs";
import { MaintenanceSources, metadataRequests } from "../scripts/maintenance/sources.mjs";

const owned: string[] = [];
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(additional: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "workbench-maintenance-safety-"));
  owned.push(root);
  const files = {
    "workbench/projects.toml": '[[language_root]]\npath="."\nlanguage="typescript"\n',
    "workbench/config.toml": "schema_version=1\n",
    "scripts/native-assets.json": "{}\n",
    "scripts/llvm-assets.json": "{}\n",
    ...additional,
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return {
    root,
    snapshot: () =>
      Object.fromEntries(Object.keys(files).map((path) => [path, readFileSync(join(root, path), "utf8")])),
  };
}
const release = (version: string): Release => ({ version, reference: `https://example.test/releases/${version}` });
const noCommands = (): Promise<string> => Promise.reject(new Error("Unexpected external command"));
function barrier() {
  const gate = Promise.withResolvers<undefined>();
  return {
    promise: gate.promise,
    resolve() {
      gate.resolve(undefined);
    },
  };
}

test("pre-aborted discovery and apply do not acquire metadata or change declarations", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"library":"1.0.0"}}\n' });
  const original = data.snapshot();
  const plan = await discoverMaintenance(data.root, () => Promise.resolve([release("2.0.0")]));
  const controller = new AbortController();
  controller.abort();
  let acquisitions = 0;
  const discover = () => {
    acquisitions++;
    return Promise.resolve([release("2.0.0")]);
  };
  await assert.rejects(discoverMaintenance(data.root, discover, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(applyMaintenance(data.root, plan, { discover, run: noCommands, signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(acquisitions, 0);
  assert.deepEqual(data.snapshot(), original);
});

test("cancelled discovery drains admitted workers and does not start another target", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"first":"1.0.0","second":"1.0.0","third":"1.0.0"}}\n' });
  const original = data.snapshot();
  const started = barrier();
  const releases = [barrier(), barrier()];
  const firstFinished = barrier();
  const controller = new AbortController();
  let admitted = 0,
    drained = 0;
  const pending = discoverMaintenance(
    data.root,
    async () => {
      const index = admitted++;
      if (admitted === 2) started.resolve();
      const gate = releases[index];
      assert.ok(gate, "Cancellation admitted an unexpected third request");
      await gate.promise;
      drained++;
      if (index === 0) firstFinished.resolve();
      return [release("2.0.0")];
    },
    { signal: controller.signal, concurrency: 2 },
  );
  let completed = false;
  const completion = pending.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await started.promise;
  controller.abort();
  releases[0]?.resolve();
  await firstFinished.promise;
  try {
    await nextTurn();
    assert.equal(completed, false, "Discovery returned before its other admitted request settled");
  } finally {
    releases[1]?.resolve();
  }
  await completion;
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(admitted, 2);
  assert.equal(drained, 2);
  assert.deepEqual(data.snapshot(), original);
});

test("cancellation during apply stops later metadata lookups and preserves every declaration", async () => {
  const data = fixture({ "package.json": '{"dependencies":{"first":"1.0.0","second":"1.0.0"}}\n' });
  const original = data.snapshot();
  const plan = await discoverMaintenance(data.root, () => Promise.resolve([release("2.0.0")]));
  const started = barrier(),
    finish = barrier();
  const controller = new AbortController();
  let acquisitions = 0;
  const pending = applyMaintenance(data.root, plan, {
    run: noCommands,
    signal: controller.signal,
    discover: async () => {
      acquisitions++;
      started.resolve();
      await finish.promise;
      return [release("2.0.0")];
    },
  });
  await started.promise;
  controller.abort();
  finish.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(acquisitions, 1);
  assert.deepEqual(data.snapshot(), original);
});

test("cancellation at artifact acquisition prevents final pin and catalog publication", async () => {
  const data = fixture({
    ".node-version": "10.1.0\n",
    "scripts/native-assets.json": JSON.stringify({
      node: {
        "10.1.0": {
          "linux-x64": { url: "https://nodejs.org/dist/v10.1.0/node-v10.1.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
        },
      },
    }),
  });
  const original = data.snapshot();
  const discover = () => Promise.resolve([release("10.2.0")]);
  const plan = await discoverMaintenance(data.root, discover);
  const started = barrier(),
    finish = barrier();
  const controller = new AbortController();
  const sources = new MaintenanceSources(async () => {
    started.resolve();
    await finish.promise;
    return `${"b".repeat(64)}  node-v10.2.0-linux-x64.tar.gz\n`;
  });
  const pending = applyMaintenance(data.root, plan, { discover, sources, run: noCommands, signal: controller.signal });
  await started.promise;
  controller.abort();
  finish.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(data.snapshot(), original);
});

test("metadata transport receives operation cancellation and cannot return a successful result afterward", async () => {
  const started = barrier(),
    finish = barrier();
  const controller = new AbortController();
  let cancelled = false;
  const fetcher: typeof fetch = async (_input, init) => {
    init?.signal?.addEventListener(
      "abort",
      () => {
        cancelled = true;
      },
      { once: true },
    );
    started.resolve();
    await finish.promise;
    init?.signal?.throwIfAborted();
    return new Response("metadata");
  };
  const request = metadataRequests(fetcher, controller.signal);
  const pending = request("https://registry.example.test/latest");
  await started.promise;
  controller.abort();
  finish.resolve();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.throws(() => request("https://registry.example.test/latest"), { name: "AbortError" });
});

test.each(["10.0.0", "11.0.0"])(
  "an edited plan cannot select published but ineligible native release %s",
  async (selected) => {
    const data = fixture({ ".node-version": "10.1.0\n" });
    const original = data.snapshot();
    const discover = () => Promise.resolve([release("10.2.0"), release("10.0.0"), release("11.0.0")]);
    const plan = await discoverMaintenance(data.root, discover);
    const edited = { ...plan, entries: plan.entries.map((entry) => ({ ...entry, selected: release(selected) })) };
    await assert.rejects(
      applyMaintenance(data.root, edited, { discover, run: noCommands }),
      /support|downgrade|constraint/i,
    );
    assert.deepEqual(data.snapshot(), original);
  },
);

test("nonregistry and unversioned npm authorities are constrained without registry acquisition", async () => {
  const data = fixture({
    "package.json": JSON.stringify({
      dependencies: {
        workspace: "workspace:*",
        local: "file:../local",
        remote: "git+https://example.test/project.git",
        floating: "latest",
      },
      packageManager: `pnpm@1.0.0+sha512.${"a".repeat(128)}`,
    }),
  });
  const original = data.snapshot();
  let requests = 0;
  const sources = new MaintenanceSources(() => {
    requests++;
    return Promise.resolve('{"version":"2.0.0"}');
  });
  const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
  assert.equal(plan.entries.length, 5);
  assert.ok(plan.entries.every((entry) => entry.state === MaintenanceState.Constrained));
  assert.ok(plan.entries.every((entry) => entry.reason));
  assert.equal(requests, 0);
  assert.deepEqual(data.snapshot(), original);
});

test("Composer tilde requirements retain Composer semantics and irrelevant older constraints do not block a refresh", async () => {
  const sources = new MaintenanceSources(() =>
    Promise.resolve(
      JSON.stringify({
        package: {
          versions: {
            "2.0.0": { version: "2.0.0", require: { php: "~8.1" } },
            "1.0.0": { version: "1.0.0", require: { php: "unsupported historical syntax" } },
          },
        },
      }),
    ),
  );
  assert.deepEqual(
    (await sources.composer("vendor/tool", "8.2.0", "2.0.0")).map((entry) => entry.version),
    ["2.0.0"],
  );
});

test("a Playwright upgrade cannot leave its separately pinned native browser behind", async () => {
  const data = fixture({
    "package.json": '{"devDependencies":{"playwright-core":"1.0.0"}}\n',
    ".tool-versions": "chromium-headless-shell 100.0.0\n",
  });
  const original = data.snapshot();
  const sources = new MaintenanceSources((url) =>
    Promise.resolve(
      url.includes("registry.npmjs.org")
        ? '{"versions":{"2.0.0":{}}}'
        : JSON.stringify({
            browsers: [
              { name: "chromium-headless-shell", browserVersion: url.includes("/v2.0.0/") ? "101.0.0" : "100.0.0" },
            ],
          }),
    ),
  );
  const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
  const playwright = plan.entries.find((entry) => entry.name === "playwright-core");
  assert.ok(playwright);
  assert.equal(playwright.state, MaintenanceState.Constrained);
  assert.match(playwright.reason, /101\.0\.0/);
  const baseline = await discoverMaintenance(data.root, () => Promise.resolve([release("1.0.0")]));
  const edited = {
    ...baseline,
    entries: baseline.entries.map((entry) =>
      entry.name === "playwright-core"
        ? { ...entry, state: MaintenanceState.Available, selected: release("2.0.0") }
        : entry,
    ),
  };
  await assert.rejects(
    applyMaintenance(data.root, edited, {
      sources,
      discover: () => Promise.resolve([release("2.0.0")]),
      run: noCommands,
    }),
    /Playwright.*requires Chromium/,
  );
  assert.deepEqual(data.snapshot(), original);
});

test.each([false, true])(
  "Miri availability covers every declared Linux architecture before selecting a new nightly (arm64=%s)",
  async (arm64) => {
    const data = fixture({
      "workbench/config.toml": '[ci.architectures]\nlinux=["x64","arm64"]\n',
      "rust-toolchain-miri.toml": '[toolchain]\nchannel="nightly-2026-01-01"\ncomponents=["miri","rust-src"]\n',
    });
    const manifest = `date="2026-02-01"\n[pkg.rust]\nversion="1.0.0 (build)"\n[pkg.miri-preview.target.x86_64-unknown-linux-gnu]\navailable=true\n[pkg.miri-preview.target.aarch64-unknown-linux-gnu]\navailable=${String(arm64)}\n[pkg.rust-src.target."*"]\navailable=true\n`;
    const sources = new MaintenanceSources(() => Promise.resolve(manifest));
    const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
    const entry = plan.entries[0];
    assert.ok(entry);
    assert.equal(entry.state, arm64 ? MaintenanceState.Available : MaintenanceState.Constrained);
    assert.equal(entry.selected?.version, arm64 ? "nightly-2026-02-01" : undefined);
  },
);

test("Docker metadata selects declared platform manifests while index consumers retain the index digest", async () => {
  const index = `sha256:${"a".repeat(64)}`,
    x64 = `sha256:${"b".repeat(64)}`,
    arm64 = `sha256:${"c".repeat(64)}`;
  const metadata = {
    digest: index,
    images: [
      { os: "windows", architecture: "amd64", digest: `sha256:${"d".repeat(64)}` },
      { os: "linux", architecture: "arm64", digest: arm64 },
      { os: "linux", architecture: "amd64", digest: x64 },
    ],
  };
  const sources = new MaintenanceSources(() => Promise.resolve(JSON.stringify(metadata)));
  assert.equal((await sources.docker("alpine:3.23"))[0]?.version, index);
  assert.equal((await sources.docker("alpine:3.23", "linux-x64"))[0]?.version, x64);
  assert.equal((await sources.docker("alpine:3.23", "linux-arm64"))[0]?.version, arm64);
  await assert.rejects(sources.docker("alpine:3.23", "darwin-arm64"), /platform/);
  const missing = new MaintenanceSources(() => Promise.resolve(JSON.stringify({ digest: index, images: [] })));
  await assert.rejects(missing.docker("alpine:3.23", "linux-arm64"), /no unique image/);
});

test("release-tool discovery updates opaque Cross revisions and platform images while retaining authenticated APT selection", async () => {
  const old = "a".repeat(40),
    next = "b".repeat(40);
  const index = `sha256:${"a".repeat(64)}`,
    x64 = `sha256:${"b".repeat(64)}`,
    arm64 = `sha256:${"c".repeat(64)}`,
    previous = `sha256:${"d".repeat(64)}`;
  const data = fixture({
    "Dockerfile.musl": `FROM ubuntu:26.04@${index}\nRUN echo https://snapshot.ubuntu.com/ubuntu/20260101T000000Z\n`,
    "release-musl.json": JSON.stringify({
      cross_revision: old,
      cross_version: "0.2.5",
      targets: {
        "x86_64-unknown-linux-musl": { platform: "linux-x64", verification_images: [`alpine:3.23@${previous}`] },
        "aarch64-unknown-linux-musl": { platform: "linux-arm64", verification_images: [`alpine:3.23@${previous}`] },
      },
    }),
  });
  const originalDockerfile = data.snapshot()["Dockerfile.musl"];
  const sources = new MaintenanceSources((url) => {
    if (url.includes("cross-rs/cross/git/ref/heads/main"))
      return Promise.resolve(JSON.stringify({ object: { sha: next } }));
    if (url.includes("hub.docker.com"))
      return Promise.resolve(
        JSON.stringify({
          digest: index,
          images: [
            { os: "linux", architecture: "amd64", digest: x64 },
            { os: "linux", architecture: "arm64", digest: arm64 },
          ],
        }),
      );
    return Promise.reject(new Error(`Unexpected metadata source ${url}`));
  });
  const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
  assert.equal(plan.entries.find((entry) => entry.name === "cross")?.selected?.version, next);
  assert.equal(plan.entries.find((entry) => entry.name === "apt-snapshot")?.state, MaintenanceState.Constrained);
  assert.match(plan.entries.find((entry) => entry.name === "apt-snapshot")?.reason ?? "", /authenticated/);
  assert.equal(plan.entries.find((entry) => entry.platform === "linux-x64")?.selected?.version, x64);
  assert.equal(plan.entries.find((entry) => entry.platform === "linux-arm64")?.selected?.version, arm64);
  await applyMaintenance(data.root, plan, { sources, run: noCommands, environments: true });
  const document: unknown = JSON.parse(readFileSync(join(data.root, "release-musl.json"), "utf8"));
  assert.deepEqual(document, {
    cross_revision: next,
    cross_version: "0.2.5",
    targets: {
      "x86_64-unknown-linux-musl": { platform: "linux-x64", verification_images: [`alpine:3.23@${x64}`] },
      "aarch64-unknown-linux-musl": { platform: "linux-arm64", verification_images: [`alpine:3.23@${arm64}`] },
    },
  });
  assert.equal(data.snapshot()["Dockerfile.musl"], originalDockerfile);
});

test.each(["current", "retagged", "new-version"])(
  "BuildKit discovery distinguishes version and pinned image changes: %s",
  async (state) => {
    const previous = `sha256:${"a".repeat(64)}`,
      digest = state === "current" ? previous : `sha256:${"b".repeat(64)}`;
    const version = state === "new-version" ? "0.2.0" : "0.1.0";
    const data = fixture({
      "scripts/container-tools/buildkit-image.txt": `docker.io/moby/buildkit:v0.1.0@${previous}\n`,
    });
    const sources = new MaintenanceSources((url) =>
      Promise.resolve(
        url.includes("api.github.com")
          ? JSON.stringify([
              { tag_name: "v1.0.0", html_url: "https://github.com/moby/buildkit/releases/tag/v1.0.0", assets: [] },
              {
                tag_name: `v${version}`,
                html_url: `https://github.com/moby/buildkit/releases/tag/v${version}`,
                assets: [],
              },
            ])
          : JSON.stringify({ digest }),
      ),
    );
    const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
    const selected = plan.entries.find((entry) => entry.name === "buildkit");
    assert.ok(selected);
    assert.equal(selected.state, state === "current" ? MaintenanceState.Current : MaintenanceState.Available);
    const candidate = selected.selected;
    assert.ok(candidate);
    assert.equal(candidate.version, version);
    assert.equal(candidate.revision, digest);
  },
);

test("applying BuildKit refuses an image retag or altered recorded digest before changing source", async () => {
  const previous = `sha256:${"a".repeat(64)}`,
    planned = `sha256:${"b".repeat(64)}`;
  let digest = planned;
  const data = fixture({
    "scripts/container-tools/buildkit-image.txt": `docker.io/moby/buildkit:v0.1.0@${previous}\n`,
  });
  const original = data.snapshot();
  const sources = new MaintenanceSources((url) =>
    Promise.resolve(
      url.includes("api.github.com")
        ? JSON.stringify([
            { tag_name: "v0.1.0", html_url: "https://github.com/moby/buildkit/releases/tag/v0.1.0", assets: [] },
          ])
        : JSON.stringify({ digest }),
    ),
  );
  const plan = await discoverMaintenance(data.root, developmentDiscovery(sources, data.root));
  digest = `sha256:${"c".repeat(64)}`;
  await assert.rejects(
    applyMaintenance(data.root, plan, { sources, run: noCommands }),
    /BuildKit image digest changed/,
  );
  assert.deepEqual(data.snapshot(), original);
  const altered = {
    ...plan,
    entries: plan.entries.map((entry) => ({
      ...entry,
      selected: { ...entry.selected, revision: "not-an-image-digest" },
    })),
  };
  await assert.rejects(
    applyMaintenance(data.root, altered, { sources, run: noCommands }),
    /Invalid selected BuildKit image digest/,
  );
  assert.deepEqual(data.snapshot(), original);
});

import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { additionalMaintenanceTargets } from "../scripts/maintenance/inventory.mjs";
import { MaintenanceKind, MaintenanceProvider } from "../scripts/maintenance/contract.mjs";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(files: Record<string, string> = {}, roots: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "workbench-maintenance-inventory-"));
  scratch.push(root);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  write(
    "workbench/projects.toml",
    roots.length
      ? roots.map((path) => `[[language_root]]\npath = ${JSON.stringify(path)}\nlanguage = "typescript"\n`).join("\n")
      : "language_root = []\n",
  );
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  return { root, write, read: (path: string) => readFileSync(join(root, path), "utf8") };
}

test("discovers bootstrap, root and nested Bundler, and builtin registry authorities independently", () => {
  const baseline = "a".repeat(40);
  const data = fixture(
    {
      "scripts/bootstrap-tools.json": '{"rustup-init":"1.2.3"}\n',
      "Gemfile.lock": "GEM\n  specs:\n\nBUNDLED WITH\n   4.1.2\n",
      "tools/ruby/Gemfile.lock": "GEM\r\n  specs:\r\n\r\nBUNDLED WITH\r\n   3.4.5\r\n",
      "tools/c/vcpkg-configuration.json": JSON.stringify({ "default-registry": { kind: "builtin", baseline } }),
    },
    ["tools/ruby", "tools/c", "tools/c"],
  );
  const targets = additionalMaintenanceTargets(data.root);
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((entry) => [entry.path, entry.name, entry.current, entry.kind]),
    [
      ["scripts/bootstrap-tools.json", "rustup-init", "1.2.3", MaintenanceKind.Toolchains],
      ["Gemfile.lock", "bundler", "4.1.2", MaintenanceKind.Toolchains],
      ["tools/ruby/Gemfile.lock", "bundler", "3.4.5", MaintenanceKind.Toolchains],
      ["tools/c/vcpkg-configuration.json", "vcpkg", baseline, MaintenanceKind.Dependencies],
    ],
  );
  assert.ok(targets.every((entry) => entry.provider === MaintenanceProvider.Tool));
  assert.deepEqual(targets[0]?.locator, { kind: "field", path: ["rustup-init"] });
  assert.deepEqual(targets[1]?.locator, { kind: "marker", name: "BUNDLED WITH" });
  assert.deepEqual(targets[3]?.locator, { kind: "field", path: ["default-registry", "baseline"] });
  assert.equal(new Set(targets.map((entry) => entry.id)).size, targets.length);
});

test("registry updates neither follow the tooling checkout nor alter other discovered pins", () => {
  const first = "a".repeat(40),
    next = "b".repeat(40),
    tooling = "c".repeat(40);
  const configuration = "native/vcpkg-configuration.json";
  const lock = "BUNDLED WITH\n   4.2.1\n";
  const data = fixture(
    {
      [configuration]: JSON.stringify({ "default-registry": { kind: "builtin", baseline: first } }),
      "native/.vcpkg-version": `${tooling}\n`,
      "Gemfile.lock": lock,
    },
    ["native"],
  );
  const before = additionalMaintenanceTargets(data.root);
  data.write(configuration, JSON.stringify({ "default-registry": { kind: "builtin", baseline: next } }));
  const after = additionalMaintenanceTargets(data.root);
  assert.equal(before.find((entry) => entry.name === "vcpkg")?.current, first);
  assert.equal(after.find((entry) => entry.name === "vcpkg")?.current, next);
  assert.deepEqual(
    before.filter((entry) => entry.name !== "vcpkg"),
    after.filter((entry) => entry.name !== "vcpkg"),
  );
  assert.equal(data.read("native/.vcpkg-version"), `${tooling}\n`);
  assert.equal(data.read("Gemfile.lock"), lock);
});

test("absent authorities and custom or disabled registries do not imply builtin registry targets", () => {
  const data = fixture(
    {
      "custom/vcpkg-configuration.json": JSON.stringify({
        "default-registry": { kind: "git", baseline: "a".repeat(40), repository: "https://example.test/ports.git" },
      }),
      "disabled/vcpkg-configuration.json": '{"default-registry":null}',
      Gemfile: 'source "https://rubygems.org"\n',
    },
    ["custom", "disabled", "missing"],
  );
  assert.deepEqual(additionalMaintenanceTargets(data.root), []);
});

test("container CLI and BuildKit retain independent manifest and complete image authorities", () => {
  const reference = `docker.io/moby/buildkit:v0.3.4@sha256:${"a".repeat(64)}`;
  const data = fixture({
    "package.json": '{"dependencies":{"@devcontainers/cli":"9.0.0"}}',
    "scripts/container-tools/package.json": JSON.stringify({ dependencies: { "@devcontainers/cli": "0.1.2" } }),
    "scripts/container-tools/buildkit-image.txt": `${reference}\n`,
  });
  const targets = additionalMaintenanceTargets(data.root);
  assert.equal(targets.length, 2);
  const container = targets.find((entry) => entry.name === "@devcontainers/cli");
  assert.ok(container);
  assert.equal(container.current, "0.1.2");
  assert.equal(container.path, "scripts/container-tools/package.json");
  assert.deepEqual(container.locator, { kind: "group", name: "dependencies" });
  assert.equal(container.kind, MaintenanceKind.Toolchains);
  assert.equal(container.provider, MaintenanceProvider.Npm);
  const buildkit = targets.find((entry) => entry.name === "buildkit");
  assert.ok(buildkit);
  assert.equal(buildkit.current, "0.3.4");
  assert.deepEqual(buildkit.locator, { kind: "image", reference });
  data.write("scripts/container-tools/buildkit-image.txt", `${reference.replace("a".repeat(64), "b".repeat(64))}\n`);
  const changed = additionalMaintenanceTargets(data.root).find((entry) => entry.name === "buildkit");
  assert.ok(changed);
  assert.equal(changed.current, buildkit.current);
  assert.notEqual(
    changed.id,
    buildkit.id,
    "A changed digest changes the complete BuildKit authority even when its tag is retained",
  );
});

test("musl release inventory preserves Git revision, snapshot, JSON locations, and per-architecture image selection", () => {
  const revision = "c".repeat(40);
  const node = `node:24-bookworm@sha256:${"a".repeat(64)}`;
  const ubuntu = `ubuntu:24.04@sha256:${"b".repeat(64)}`;
  const alpineX64 = `alpine:3.21@sha256:${"d".repeat(64)}`;
  const alpineArm64 = `alpine:3.21@sha256:${"e".repeat(64)}`;
  const releasePath = "service/release-musl.json";
  const data = fixture(
    {
      [releasePath]: JSON.stringify({
        cross_version: "0.9.0",
        cross_revision: revision,
        targets: {
          "x86_64-unknown-linux-musl": { platform: "linux-x64", verification_images: [ubuntu, alpineX64] },
          "aarch64-unknown-linux-musl": { platform: "linux-arm64", verification_images: [ubuntu, alpineArm64] },
        },
      }),
      "service/managed-release-check.json": JSON.stringify({ image: node }),
      "service/Dockerfile.musl": `FROM ${node} AS certificates\nFROM ${ubuntu}\nRUN echo https://snapshot.ubuntu.com/ubuntu/20250101T000000Z\n`,
    },
    ["service"],
  );
  const originalRelease = data.read(releasePath);
  const targets = additionalMaintenanceTargets(data.root);
  assert.equal(targets.length, 9);
  const cross = targets.find((entry) => entry.name === "cross");
  assert.ok(cross);
  assert.equal(cross.current, revision);
  assert.deepEqual(cross.locator, { kind: "field", path: ["cross_revision"] });
  assert.equal(cross.kind, MaintenanceKind.Toolchains);
  const snapshot = targets.find((entry) => entry.name === "apt-snapshot");
  assert.ok(snapshot);
  assert.equal(snapshot.current, "20250101T000000Z");
  assert.deepEqual(snapshot.locator, { kind: "marker", name: "snapshot" });
  assert.equal(snapshot.kind, MaintenanceKind.Environments);
  const images = targets.filter((entry) => entry.provider === MaintenanceProvider.Image);
  assert.equal(images.length, 7);
  assert.ok(images.every((entry) => entry.kind === MaintenanceKind.Automation));
  assert.deepEqual(images.find((entry) => entry.path === "service/managed-release-check.json")?.locator, {
    kind: "field",
    path: ["image"],
  });
  assert.equal(images.filter((entry) => entry.path === "service/Dockerfile.musl").length, 2);
  assert.deepEqual(
    images
      .filter((entry) => entry.name === "alpine:3.21")
      .map((entry) => [
        entry.locator?.kind === "field" ? entry.locator.path.join(".") : entry.locator,
        entry.platform,
        entry.current,
      ]),
    [
      ["targets.x86_64-unknown-linux-musl.verification_images.1", "linux-x64", `sha256:${"d".repeat(64)}`],
      ["targets.aarch64-unknown-linux-musl.verification_images.1", "linux-arm64", `sha256:${"e".repeat(64)}`],
    ],
  );
  assert.ok(
    images.filter((entry) => entry.name !== "alpine:3.21").every((entry) => entry.platform === undefined),
    "Index-pinned images retain index selection rather than inheriting a target architecture",
  );
  assert.equal(data.read(releasePath), originalRelease, "Inventory does not rewrite declared release data");
});

test("container APT snapshots are independently visible for authenticated environment review", () => {
  const data = fixture({
    ".devcontainer/Dockerfile": "RUN echo https://snapshot.ubuntu.com/ubuntu/20250101T000000Z\n",
    ".devcontainer/guix/Dockerfile": "RUN echo https://snapshot.ubuntu.com/ubuntu/20250201T000000Z\n",
  });
  assert.deepEqual(
    additionalMaintenanceTargets(data.root).map(({ path, name, current, kind }) => ({ path, name, current, kind })),
    [
      {
        path: ".devcontainer/Dockerfile",
        name: "apt-snapshot",
        current: "20250101T000000Z",
        kind: MaintenanceKind.Environments,
      },
      {
        path: ".devcontainer/guix/Dockerfile",
        name: "apt-snapshot",
        current: "20250201T000000Z",
        kind: MaintenanceKind.Environments,
      },
    ],
  );
});

test.each([
  ["scripts/bootstrap-tools.json", '{"rustup-init":42}', /bootstrap-tools\.json.*version string/],
  ["scripts/bootstrap-tools.json", '{"rustup-init":""}', /bootstrap-tools\.json.*nonempty/],
  ["scripts/bootstrap-tools.json", "not json", /bootstrap-tools\.json.*version authority/],
  ["Gemfile.lock", "GEM\n  specs:\n", /Gemfile\.lock.*BUNDLED WITH/],
  [
    "vcpkg-configuration.json",
    '{"default-registry":{"kind":"builtin","baseline":"main"}}',
    /vcpkg-configuration\.json.*complete Git revision/,
  ],
  [
    "scripts/container-tools/package.json",
    '{"dependencies":{"@devcontainers/cli":42}}',
    /container-tools\/package\.json.*version string/,
  ],
  [
    "scripts/container-tools/buildkit-image.txt",
    "docker.io/moby/buildkit:latest",
    /buildkit-image\.txt.*stable version and image digest/,
  ],
  ["managed-release-check.json", '{"image":"node:24-bookworm"}', /managed-release-check\.json.*immutable SHA-256/],
  ["release-musl.json", '{"cross_revision":"main"}', /release-musl\.json.*complete Git revision/],
  [
    "release-musl.json",
    JSON.stringify({
      cross_revision: "a".repeat(40),
      targets: { sample: { verification_images: [`alpine:3.21@sha256:${"b".repeat(64)}`] } },
    }),
    /release-musl\.json.*Alpine requires target\.platform/,
  ],
] as const)("rejects an invalid authority in %s with a useful diagnostic", (path, contents, message) => {
  const data = fixture({ [path]: contents });
  assert.throws(() => additionalMaintenanceTargets(data.root), message);
});

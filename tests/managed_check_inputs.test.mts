import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  cargoCheckInputs,
  composerCheckInputs,
  managedCheckInputs,
  mavenCheckInputs,
  npmCheckInputs,
  pythonCheckInputs,
  rubyCheckInputs,
} from "../scripts/managed-check-inputs.mjs";
import { managedInputRepository, managedInputSource } from "../src/managed-inputs.ts";
import { verifyAttestation } from "../src/attestation-verification.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
const digest = "a".repeat(64);
const integrity = `sha256-${Buffer.from(digest, "hex").toString("base64")}`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-managed-inputs-")));
  temporary.push(root);
  return root;
}
function file(root: string, name: string, contents: unknown) {
  mkdirSync(join(root, name, ".."), { recursive: true });
  writeFileSync(join(root, name), typeof contents === "string" ? contents : JSON.stringify(contents));
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("npm inputs combine lock documents and select Linux glibc targets without resolving versions", () => {
  const root = fixture();
  file(
    root,
    "pnpm-lock.yaml",
    `packages:\n  foo@1.2.3:\n    resolution: {integrity: ${integrity}}\n---\npackages:\n  '@scope/bar@2.0.0':\n    resolution: {integrity: ${integrity}}\n    os: [linux]\n    cpu: [arm64]\n  ignored@1.0.0:\n    resolution: {integrity: ${integrity}}\n    os: [darwin]\n  musl@1.0.0:\n    resolution: {integrity: ${integrity}}\n    libc: [musl]\n`,
  );
  expect(npmCheckInputs(root)).toEqual([
    {
      url: "https://registry.npmjs.org/foo/-/foo-1.2.3.tgz",
      hash: integrity,
      destination: "npm/foo-1.2.3.tgz",
      platforms: ["linux-x64", "linux-arm64"],
    },
    {
      url: "https://registry.npmjs.org/@scope/bar/-/bar-2.0.0.tgz",
      hash: integrity,
      destination: "npm/@scope-bar-2.0.0.tgz",
      platforms: ["linux-arm64"],
    },
  ]);
  for (const contents of [
    "packages: [",
    "packages:\n  git+unlocked: {}",
    "packages:\n  foo@1.0.0: {resolution: {integrity: bad}}",
  ]) {
    file(root, "pnpm-lock.yaml", contents);
    expect(() => npmCheckInputs(root)).toThrow();
  }
});

test("Ruby inputs include every checksummed gem and exclude foreign platform packages", () => {
  const root = fixture();
  file(
    root,
    "Gemfile.lock",
    `CHECKSUMS\n  a (1.0.0) sha256=${digest}\n  b (2.0.0) sha256=${digest}\n  ffi (1.0.0-x86_64-linux-gnu) sha256=${digest}\n  ffi (1.0.0-arm64-darwin) sha256=${digest}\n\nBUNDLED WITH\n  4.0.22\n`,
  );
  expect(rubyCheckInputs(root).map((input) => [input.destination, input.platforms])).toEqual([
    ["gems/a-1.0.0.gem", ["linux-x64", "linux-arm64"]],
    ["gems/b-2.0.0.gem", ["linux-x64", "linux-arm64"]],
    ["gems/ffi-1.0.0-x86_64-linux-gnu.gem", ["linux-x64"]],
  ]);
  file(root, "Gemfile.lock", "GEM\n");
  expect(() => rubyCheckInputs(root)).toThrow(/CHECKSUMS/);
});

test("Maven inputs preserve artifact paths and reject malformed or escaping records", () => {
  const root = fixture();
  file(root, ".mvn/checksums/checksums.sha256", `${digest}  org/example/a/1.0/a-1.0.jar\n`);
  expect(mavenCheckInputs(root)).toEqual([
    {
      url: "https://maven-central.storage-download.googleapis.com/maven2/org/example/a/1.0/a-1.0.jar",
      hash: integrity,
      destination: "maven/org/example/a/1.0/a-1.0.jar",
    },
  ]);
  for (const path of ["../escape", "bad space", "https://example.test/file"]) {
    file(root, ".mvn/checksums/checksums.sha256", `${digest}  ${path}\n`);
    expect(() => mavenCheckInputs(root)).toThrow();
  }
});

test("Cargo and Python inputs use lock digests and omit unsupported wheel platforms", () => {
  const root = fixture();
  file(
    root,
    "Cargo.lock",
    `[[package]]\nname="local"\nversion="0.1.0"\n[[package]]\nname="serde"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="${digest}"\n`,
  );
  expect(cargoCheckInputs(root)[0]).toEqual({
    url: "https://static.crates.io/crates/serde/serde-1.0.0.crate",
    hash: integrity,
    destination: "cargo/serde-1.0.0.crate",
  });
  file(root, "Cargo.lock", '[[package]]\nname="git"\nversion="1.0.0"\nsource="git+https://example.test"\n');
  expect(() => cargoCheckInputs(root)).toThrow(/Unsupported/);
  file(
    root,
    "uv.lock",
    `[[package]]\nname="tool"\nversion="1.0.0"\nsdist={url="https://example.test/tool.tar.gz",hash="sha256:${digest}"}\nwheels=[{url="https://example.test/tool-py3-none-any.whl",hash="sha256:${digest}"},{url="https://example.test/tool-cp313-manylinux_2_17_aarch64.whl",hash="sha256:${digest}"},{url="https://example.test/tool-cp313-win_amd64.whl",hash="sha256:${digest}"}]\n`,
  );
  expect(pythonCheckInputs(root).map((entry) => [entry.destination, entry.platforms])).toEqual([
    ["python/tool.tar.gz", ["linux-x64", "linux-arm64"]],
    ["python/tool-py3-none-any.whl", ["linux-x64", "linux-arm64"]],
    ["python/tool-cp313-manylinux_2_17_aarch64.whl", ["linux-arm64"]],
  ]);
});

test("Composer inputs use reviewed distributions and leave local plugins project-owned", () => {
  const root = fixture();
  file(root, "composer.lock", {
    packages: [
      { name: "a/b", version: "1.0.0", dist: { type: "zip", url: "https://example.test/a.zip", reference: "commit" } },
    ],
    "packages-dev": [{ name: "local", dist: { type: "path" } }],
  });
  file(root, ".composer/checksums.json", { "a/b@1.0.0#commit": digest });
  expect(composerCheckInputs(root)).toEqual([
    { url: "https://example.test/a.zip", hash: integrity, destination: `composer/application/a/b/${digest}.zip` },
  ]);
  file(root, ".composer/checksums.json", {});
  expect(() => composerCheckInputs(root)).toThrow(/Missing reviewed/);
});

test("generated inputs retain source identities and reject a stale supplemental declaration", () => {
  const root = fixture();
  file(root, "package.json", { name: "fixture" });
  file(root, "pnpm-lock.yaml", `packages:\n  a@1.0.0: {resolution: {integrity: ${integrity}}}`);
  const first = managedCheckInputs(root);
  expect(first.source_hashes["package.json"]).toBe(
    createHash("sha256")
      .update(readFileSync(join(root, "package.json")))
      .digest("hex"),
  );
  expect(managedCheckInputs(root)).toEqual(first);
  file(root, "managed-extra-inputs.json", { schema_version: 1, source_hashes: { "package.json": digest }, inputs: [] });
  expect(() => managedCheckInputs(root)).toThrow(/refresh derived/);
});

test("a realized input repository rejects changed declarations, corruption, and undeclared acquisition", () => {
  const root = fixture(),
    store = fixture();
  file(root, "pin", "locked");
  const bytes = "source bytes",
    hash = createHash("sha256").update(bytes).digest("base64");
  file(store, "sources/a", bytes);
  const declaration = {
    schema_version: 1,
    source_hashes: { pin: createHash("sha256").update("locked").digest("hex") },
    inputs: [{ url: "https://example.test/a", hash: `sha256-${hash}`, destination: "sources/a" }],
  };
  file(store, "manifest.json", declaration);
  expect(managedInputRepository(root)).toBeUndefined();
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", store);
  const selected = managedInputRepository(root);
  expect(managedInputSource(required(selected, "Expected fixture value"), "https://example.test/a")).toBe(
    join(store, "sources/a"),
  );
  expect(() => managedInputSource(required(selected, "Expected fixture value"), "https://example.test/other")).toThrow(
    /Missing/,
  );
  file(store, "sources/a", "corrupt");
  expect(() => managedInputSource(required(selected, "Expected fixture value"), "https://example.test/a")).toThrow(
    /integrity/,
  );
  file(root, "pin", "changed");
  expect(() => managedInputRepository(root)).toThrow(/stale/);
});

test("locked pnpm bootstrap provenance binds its SHA-512 source, identity, and subject offline", () => {
  const bootstrap = JSON.parse(readFileSync(join(repository, "tests/fixtures/pnpm-bootstrap.json"), "utf8")) as {
    proofs: { integrity: string; signer: string; subject: string; bundle: unknown }[];
  };
  const roots = readFileSync(join(repository, "scripts/keys/sigstore-trusted-root.jsonl"), "utf8");
  for (const proof of bootstrap.proofs) {
    const digest = Buffer.from(proof.integrity.slice(7), "base64").toString("hex");
    const policy = { signer: proof.signer, subject: proof.subject, roots };
    expect(() => {
      verifyAttestation(JSON.stringify(proof.bundle), digest, policy, "sha512");
    }).not.toThrow();
    expect(() => {
      verifyAttestation(JSON.stringify(proof.bundle), digest, { ...policy, subject: "wrong" }, "sha512");
    }).toThrow();
    expect(() => {
      verifyAttestation(JSON.stringify(proof.bundle), "0".repeat(128), policy, "sha512");
    }).toThrow();
    expect(() => {
      verifyAttestation(JSON.stringify(proof.bundle), digest, { ...policy, signer: "https://example.test" }, "sha512");
    }).toThrow();
  }
});

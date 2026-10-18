import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { managedInputEnvironment } from "../src/managed-input-environment.ts";
import { managedBootstrap, managedInputRepository, verifiedBootstrapSources } from "../src/managed-inputs.ts";
import { artifactResponse } from "../src/artifact-streams.ts";
import { artifactProof } from "../src/artifact-proofs.ts";
import type { BinaryLike } from "crypto";

const temporary: string[] = [];
const repository = resolve(import.meta.dirname, "..");
const hash = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("base64");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-managed-environment-")));
  temporary.push(root);
  return root;
}
function file(root: string, name: string, bytes: string | NodeJS.ArrayBufferView) {
  mkdirSync(join(root, name, ".."), { recursive: true });
  writeFileSync(join(root, name), bytes);
}
function inputs(sources: [string, string | Buffer][] = []) {
  const root = fixture(),
    store = fixture();
  const declaration = {
    schema_version: 1,
    source_hashes: {} as Record<string, string>,
    bootstrap: undefined as boolean | undefined,
    inputs: sources.map(([destination, bytes]) => {
      file(store, destination, bytes);
      return { url: `https://example.test/${destination}`, hash: `sha256-${hash(bytes)}`, destination };
    }),
  };
  file(store, "manifest.json", JSON.stringify(declaration));
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", store);
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(fixture(), "cache"));
  vi.stubEnv("WORKBENCH_CHECK_INPUT_ROOT", root);
  return { root, store, declaration };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("native commands retain their environment without managed setup", async () => {
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", undefined);
  expect(await managedInputEnvironment(fixture())).toEqual(process.env);
});

test("managed environments select public local-source interfaces and a writable Maven repository", async () => {
  const { root, store } = inputs([
    ["npm/a.tgz", "npm"],
    ["python/a.whl", "python"],
    ["go/a/@v/v1.zip", "go"],
    ["composer/a.zip", "php"],
    ["maven/org/a/1/a-1.jar", "jar"],
  ]);
  const maven = join(fixture(), "maven");
  vi.stubEnv("WORKBENCH_MAVEN_REPOSITORY", maven);
  vi.stubEnv("MAVEN_ARGS", "--batch-mode");
  const env = await managedInputEnvironment(root);
  expect(env).toMatchObject({
    WORKBENCH_CHECK_INPUT_ROOT: root,
    PNPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    UV_OFFLINE: "true",
    UV_NO_INDEX: "true",
    UV_FIND_LINKS: join(store, "python"),
    GOPROXY: pathToFileURL(join(store, "go")).href,
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
    COMPOSER_DISABLE_NETWORK: "1",
    WORKBENCH_MAVEN_REPOSITORY: maven,
    MAVEN_ARGS: "--batch-mode --offline",
  });
  expect(readFileSync(join(maven, "org/a/1/a-1.jar"), "utf8")).toBe("jar");
  expect(readFileSync(join(maven, "org/a/1/_remote.repositories"), "utf8")).toBe("a-1.jar>central-mirror=\n");
  await managedInputEnvironment(root);
  expect(readFileSync(join(maven, "org/a/1/_remote.repositories"), "utf8")).toBe("a-1.jar>central-mirror=\n");
  expect(existsSync(join(root, "maven"))).toBe(false);
});

test("artifact and proof acquisition use declared sources offline without an HTTP fallback", async () => {
  const { store } = inputs([["proof/signature.asc", "signature"]]);
  vi.stubEnv("WORKBENCH_OFFLINE", "1");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not run"));
  const bytes = [];
  for await (const chunk of await artifactResponse("https://example.test/proof/signature.asc")) bytes.push(chunk);
  expect(Buffer.concat(bytes).toString()).toBe("signature");
  const proof = await artifactProof("https://example.test/proof/signature.asc", 100, "signature");
  expect(proof.bytes.toString()).toBe("signature");
  proof.accept();
  await expect(artifactProof("https://example.test/proof/signature.asc", 2, "signature")).rejects.toThrow(/size limit/);
  await expect(artifactResponse("https://example.test/undeclared")).rejects.toThrow(/Missing/);
  file(store, "proof/signature.asc", "corrupted");
  await expect(artifactResponse("https://example.test/proof/signature.asc")).rejects.toThrow(/integrity/);
  expect(fetch).not.toHaveBeenCalled();
});

test("pnpm delegates frozen resolutions to declared tarballs and rejects missing sources", () => {
  const { store } = inputs([["npm/a.tgz", "archive"]]);
  const require = createRequire(import.meta.url);
  const path = require.resolve("../.pnpmfile.cjs");
  Reflect.deleteProperty(require.cache, path);
  const hook = require(path) as {
    fetchers: { canFetch: () => boolean; fetch: (store: unknown, resolution: { integrity: string }) => unknown }[];
  };
  expect(required(hook.fetchers[0], "Expected fixture value").canFetch()).toBe(true);
  expect(
    required(hook.fetchers[0], "Expected fixture value").fetch(null, { integrity: `sha256-${hash("archive")}` }),
  ).toEqual({
    delegate: { tarball: pathToFileURL(join(store, "npm/a.tgz")).href, integrity: `sha256-${hash("archive")}` },
  });
  expect(() => required(hook.fetchers[0], "Expected fixture value").fetch(null, { integrity: "undeclared" })).toThrow(
    /No declared/,
  );
  Reflect.deleteProperty(require.cache, path);
});

test("bootstrap metadata is bound to the realized declaration and requires every selected proof", async () => {
  const { root, store, declaration } = inputs();
  const bootstrap = JSON.parse(readFileSync(join(repository, "tests/fixtures/pnpm-bootstrap.json"), "utf8")) as {
    proofs: unknown[];
  };
  file(store, "bootstrap.json", JSON.stringify(bootstrap));
  declaration.bootstrap = true;
  declaration.source_hashes["managed-bootstrap.json"] = createHash("sha256")
    .update(JSON.stringify(bootstrap))
    .digest("hex");
  file(root, "managed-bootstrap.json", JSON.stringify(bootstrap));
  file(store, "manifest.json", JSON.stringify(declaration));
  expect(managedBootstrap(required(managedInputRepository(root), "Expected fixture value"))).toEqual(bootstrap);
  await expect(
    verifiedBootstrapSources(required(managedInputRepository(root), "Expected fixture value"), repository),
  ).rejects.toThrow(/Missing/);
  bootstrap.proofs = [];
  file(store, "bootstrap.json", JSON.stringify(bootstrap));
  await expect(
    verifiedBootstrapSources(required(managedInputRepository(root), "Expected fixture value"), repository),
  ).rejects.toThrow(/does not match/);
  const selected = managedInputRepository(root);
  required(selected, "Expected fixture value: selected").declaration.source_hashes["managed-bootstrap.json"] =
    createHash("sha256").update(JSON.stringify(bootstrap)).digest("hex");
  await expect(verifiedBootstrapSources(required(selected, "Expected fixture value"), repository)).rejects.toThrow(
    /no provenance/,
  );
  delete required(selected, "Expected fixture value: selected").declaration.bootstrap;
  expect(() => managedBootstrap(required(selected, "Expected fixture value"))).toThrow(/do not declare/);
});

test("Cargo sources use the archive root directly and retain Cargo's package and file checksums", async () => {
  const { default: tar } = await import("tar-stream");
  const { gzipSync } = await import("node:zlib");
  const pack = tar.pack();
  const parts: Buffer[] = [];
  const complete = new Promise<void>((resolve, reject) => {
    pack.on("data", (part) => {
      if (!Buffer.isBuffer(part)) throw new Error("Expected archive bytes");
      parts.push(part);
    });
    pack.on("end", () => {
      resolve();
    });
    pack.on("error", reject);
  });
  const manifest = '[package]\nname="fixture"\nversion="1.0.0"\n';
  pack.entry({ name: "fixture-1.0.0/Cargo.toml" }, manifest);
  pack.entry({ name: "fixture-1.0.0/src/lib.rs" }, "pub fn value() -> u8 { 42 }\n");
  pack.finalize();
  await complete;
  const archive = gzipSync(Buffer.concat(parts));
  const { root } = inputs([["cargo/fixture-1.0.0.crate", archive]]);
  vi.stubEnv("WORKBENCH_DEPENDENCIES_DIR", join(fixture(), "dependencies"));
  const env = await managedInputEnvironment(root);
  const target = join(required(env.CARGO_HOME, "Expected fixture value"), "vendor/fixture-1.0.0");
  expect(readFileSync(join(target, "Cargo.toml"), "utf8")).toBe(manifest);
  expect(existsSync(join(target, "fixture-1.0.0"))).toBe(false);
  expect(JSON.parse(readFileSync(join(target, ".cargo-checksum.json"), "utf8"))).toEqual({
    package: createHash("sha256").update(archive).digest("hex"),
    files: {
      "Cargo.toml": createHash("sha256").update(manifest).digest("hex"),
      "src/lib.rs": createHash("sha256").update("pub fn value() -> u8 { 42 }\n").digest("hex"),
    },
  });
  expect(await managedInputEnvironment(root)).toEqual(env);
  expect(readFileSync(join(required(env.CARGO_HOME, "Expected fixture value"), "config.toml"), "utf8")).toContain(
    'replace-with = "workbench-managed"',
  );
});

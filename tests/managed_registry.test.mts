import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { managedRegistry } from "../src/managed-registry.ts";
import { npmRegistrySnapshot } from "../scripts/refresh-managed-inputs.mjs";
const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-managed-registry-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the loopback registry serves only declared metadata and closes its listener", async () => {
  const directory = fixture();
  const metadata = { "@scope/example": { name: "@scope/example", versions: { "1.0.0": {} } } };
  const bytes = brotliCompressSync(Buffer.from(JSON.stringify(metadata)));
  writeFileSync(join(directory, "registry.json.br"), bytes);
  const repository = {
    directory,
    declaration: {
      schema_version: 1,
      source_hashes: { "managed-registry.json.br": createHash("sha256").update(bytes).digest("hex") },
      inputs: [],
    },
  };
  const server = await managedRegistry(repository);
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(existsSync(server.cacheDirectory)).toBe(true);
    writeFileSync(join(server.cacheDirectory, "metadata"), "temporary");
    expect(await (await fetch(server.url + "@scope%2Fexample")).json()).toEqual(metadata["@scope/example"]);
    const head = await fetch(server.url + "@scope%2Fexample", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(server.url + "undeclared")).status).toBe(404);
    expect((await fetch(server.url + "%")).status).toBe(400);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
  } finally {
    await server.close();
  }
  await expect(fetch(server.url)).rejects.toThrow();
  expect(existsSync(server.cacheDirectory)).toBe(false);
  writeFileSync(join(directory, "registry.json.br"), "changed");
  await expect(managedRegistry(repository)).rejects.toThrow(/does not match/);
});

test("registry snapshots preserve all publication times and historical trust evidence and full locked manifests", () => {
  const directory = fixture();
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    `packages:\n  example@2.0.0:\n    resolution: {integrity: ${integrity}}\n`,
  );
  const metadata = {
    example: {
      name: "example",
      time: { "1.0.0": "2000-01-01T00:00:00Z", "2.0.0": "2001-01-01T00:00:00Z" },
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": {
          name: "example",
          version: "1.0.0",
          readme: "unneeded history",
          _npmUser: { trustedPublisher: { id: "publisher" }, approver: { name: "reviewer" } },
          dist: {
            tarball: "https://example.test/old.tgz",
            attestations: { provenance: { predicateType: "slsa" } },
            revisions: [{ revision: 1 }],
            signatures: [{ sig: "unused historical signature" }],
          },
        },
        "2.0.0": {
          name: "example",
          version: "2.0.0",
          license: "Apache-2.0",
          dist: { integrity, tarball: "https://example.test/new.tgz", signatures: [{ sig: "locked signature" }] },
        },
      },
    },
  };
  const snapshot = JSON.parse(
    brotliDecompressSync(npmRegistrySnapshot(directory, metadata)).toString("utf8"),
  ) as typeof metadata;
  expect(snapshot.example.time).toEqual(metadata.example.time);
  expect(Object.keys(snapshot.example.versions)).toEqual(["1.0.0", "2.0.0"]);
  expect(snapshot.example.versions["2.0.0"]).toEqual(metadata.example.versions["2.0.0"]);
  expect(snapshot.example.versions["1.0.0"]).toMatchObject({
    _npmUser: metadata.example.versions["1.0.0"]._npmUser,
    dist: { attestations: metadata.example.versions["1.0.0"].dist.attestations, revisions: [{ revision: 1 }] },
  });
  expect(snapshot.example.versions["1.0.0"].dist.signatures).toBeUndefined();
  expect(snapshot.example.versions["1.0.0"].readme).toBeUndefined();
  expect(() => npmRegistrySnapshot(directory, {})).toThrow(/Incomplete/);
  metadata.example.versions["2.0.0"].dist.integrity = "wrong";
  expect(() => npmRegistrySnapshot(directory, metadata)).toThrow(/locked integrity/);
  expect(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8")).toContain(integrity);
});

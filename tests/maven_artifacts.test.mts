import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mavenDigest, retainMavenArtifacts, verifyMavenArtifact } from "../src/maven-artifacts.ts";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "maven-artifacts-")),
    path = "org/fixture/library/1/library-1.jar";
  roots.push(root);
  fs.mkdirSync(dirname(join(root, "proposal", path)), { recursive: true });
  fs.writeFileSync(join(root, "proposal", path), "verified library");
  return {
    root,
    path,
    source: join(root, "proposal"),
    cache: join(root, "cache"),
    checksums: new Map([[path, mavenDigest(Buffer.from("verified library"))]]),
  };
}
test("cancellation while waiting for the repository preserves the proposal and releases the waiter", async () => {
  const f = fixture(),
    controller = new AbortController();
  fs.mkdirSync(f.cache + ".lock");
  fs.writeFileSync(join(f.cache + ".lock", "owner.json"), "another writer");
  const work = retainMavenArtifacts(f.source, f.cache, f.checksums, controller.signal);
  controller.abort();
  await expect(work).rejects.toThrow(/abort/i);
  expect(fs.existsSync(f.cache)).toBe(false);
  expect(fs.readFileSync(join(f.source, f.path), "utf8")).toBe("verified library");
  expect(fs.readFileSync(join(f.cache + ".lock", "owner.json"), "utf8")).toBe("another writer");
});
test("mid-stream cancellation removes the partial copy and preserves the verified source", async () => {
  const f = fixture(),
    controller = new AbortController(),
    open = files.open;
  vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args),
      stream = handle.createReadStream.bind(handle);
    vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
      const input = stream(options);
      input.once("data", () => {
        controller.abort();
      });
      return input;
    });
    return handle;
  });
  const output = join(f.root, "copy.jar");
  await expect(verifyMavenArtifact(f.source, f.path, f.checksums, output, controller.signal)).rejects.toThrow(/abort/i);
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.readFileSync(join(f.source, f.path), "utf8")).toBe("verified library");
});
test("verification and cleanup failures remain available together and later cleanup still runs", async () => {
  const f = fixture(),
    open = files.open,
    closeFailure = new Error("descriptor close failed");
  vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args),
      close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      await close();
      throw closeFailure;
    });
    return handle;
  });
  const output = join(f.root, "rejected.jar");
  const failure: unknown = await verifyMavenArtifact(
    f.source,
    f.path,
    new Map([[f.path, "0".repeat(64)]]),
    output,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  const failures = (failure as AggregateError).errors as unknown[];
  expect(failures).toContain(closeFailure);
  expect(failures[0]).toHaveProperty("message", expect.stringContaining("checksum mismatch"));
  expect(fs.existsSync(output)).toBe(false);
});
test("retention preserves existing repository metadata and is idempotent for a POM/JAR pair", async () => {
  const f = fixture(),
    pom = f.path.replace(/jar$/u, "pom"),
    marker = join(f.cache, dirname(f.path), "_remote.repositories");
  fs.writeFileSync(join(f.source, pom), "<project/>");
  f.checksums.set(pom, mavenDigest(Buffer.from("<project/>")));
  fs.mkdirSync(dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "# existing repository ownership\nunrelated.jar>upstream=\n");
  await retainMavenArtifacts(f.source, f.cache, f.checksums);
  const before = fs.readFileSync(marker);
  expect(before.toString()).toContain("unrelated.jar>upstream=\n");
  for (const path of f.checksums.keys())
    expect(fs.readFileSync(join(f.cache, path))).toEqual(fs.readFileSync(join(f.source, path)));
  await retainMavenArtifacts(f.source, f.cache, f.checksums);
  expect(fs.readFileSync(marker)).toEqual(before);
});

test("a concurrent cache writer cannot be overwritten by publication", async () => {
  const f = fixture(),
    link = fs.linkSync,
    target = join(f.cache, f.path);
  vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
    fs.writeFileSync(target, "concurrent writer's bytes");
    link(source, destination);
  });
  await expect(retainMavenArtifacts(f.source, f.cache, f.checksums)).rejects.toThrow(/checksum mismatch/);
  expect(fs.readFileSync(target, "utf8")).toBe("concurrent writer's bytes");
  expect(fs.readFileSync(join(f.source, f.path), "utf8")).toBe("verified library");
});

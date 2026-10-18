import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import { afterEach, expect, test, vi } from "vitest";
import { prepareWorkbenchPackage } from "../src/package.ts";
import { readDistributionSource } from "../src/distribution-identity.ts";
import type { PathOrFileDescriptor } from "fs";

const temporary: string[] = [];
const repository = "https://example.invalid/workbench.git";
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-package-test-")));
  temporary.push(base);
  const root = join(base, "source");
  for (const path of ["bin", "docs", "src", "tests", "examples"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "bin/workbench.mjs"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
  chmodSync(join(root, "bin/workbench.mjs"), 0o755);
  for (const name of ["docs/readme.md", "src/reference.ts", "tests/reference.test.mjs", "examples/example.mjs"])
    writeFileSync(join(root, name), `Reference: ${name}\n`);
  chmodSync(join(root, "docs/readme.md"), 0o640);
  writeFileSync(join(root, "LICENSE"), "Fixture license\n");
  writeFileSync(join(root, ".gitignore"), "docs/ignored.txt\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@workbench/fixture",
      version: "0.1.0",
      license: "Apache-2.0",
      repository: { type: "git", url: repository },
      files: ["bin", "docs", "src", "tests", "examples", "LICENSE"],
      devDependencies: { absent: "1.0.0" },
      scripts: { unused: "must not execute" },
    }),
  );
  vi.stubEnv("WORKBENCH_RELEASE_OUTPUT", join(base, "output"));
  return { base, root };
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function commit(root: string) {
  git(root, "init", "--quiet");
  git(root, "add", ".");
  if (process.platform === "win32") git(root, "update-index", "--chmod=+x", "bin/workbench.mjs");
  git(
    root,
    "-c",
    "user.name=Package test",
    "-c",
    "user.email=package@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  );
  return git(root, "rev-parse", "HEAD");
}
async function unpack(path: PathOrFileDescriptor) {
  const extract = tar.extract();
  const entries = new Map<string, { header: tar.Header; bytes: Buffer }>();
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
      chunks.push(chunk);
    });
    stream.on("end", () => {
      entries.set(header.name, { header, bytes: Buffer.concat(chunks) });
      next();
    });
  });
  await pipeline(Readable.from(gunzipSync(readFileSync(path))), extract);
  return entries;
}

test("a committed package preserves references and modes with a reproducible archive and exact source identity", async () => {
  const { base, root } = fixture();
  if (process.platform !== "win32") symlinkSync("workbench.mjs", join(root, "bin/alias"));
  const revision = commit(root);
  const first = await prepareWorkbenchPackage(root);
  expect(readDistributionSource(first.directory)).toEqual({ repository, revision });
  const metadata = JSON.parse(readFileSync(join(first.directory, "package.json"), "utf8")) as Record<string, unknown>;
  expect(metadata.devDependencies).toBeUndefined();
  expect(metadata.scripts).toBeUndefined();
  expect(metadata.license).toBe("Apache-2.0");
  const bytes = readFileSync(first.archive);
  expect(bytes[9]).toBe(255);
  expect(readFileSync(join(base, "output/workbench-artifacts/SHA256SUMS"), "utf8")).toBe(
    `${createHash("sha256").update(bytes).digest("hex")}  workbench.tar.gz\n`,
  );
  const entries = await unpack(first.archive);
  for (const name of ["LICENSE", "src/reference.ts", "tests/reference.test.mjs", "examples/example.mjs"])
    expect(required(entries.get(`workbench/${name}`), "Expected fixture value").bytes).toEqual(
      readFileSync(join(root, name)),
    );
  expect(required(entries.get("workbench/bin/workbench.mjs"), "Expected fixture value").header.mode).toBe(0o755);
  expect(required(entries.get("workbench/docs/readme.md"), "Expected fixture value").header.mode).toBe(0o644);
  if (process.platform !== "win32") {
    expect(required(entries.get("workbench/bin/alias"), "Expected fixture value").header).toMatchObject({
      type: "symlink",
      linkname: "workbench.mjs",
    });
  }
  for (const { header } of entries.values()) {
    expect(required(header.mtime, "Expected fixture value").getTime()).toBe(0);
    expect(header.uid).toBe(0);
    expect(header.gid).toBe(0);
  }
  utimesSync(join(root, "docs/readme.md"), new Date(), new Date());
  if (process.platform !== "win32") {
    chmodSync(join(root, "docs/readme.md"), 0o600);
    chmodSync(join(root, "docs"), 0o700);
  }
  vi.stubEnv("WORKBENCH_RELEASE_OUTPUT", join(base, "again"));
  const second = await prepareWorkbenchPackage(root);
  expect(readFileSync(second.archive)).toEqual(bytes);
});

test.each(["uncommitted", "modified", "staged", "untracked"])(
  "%s source produces a usable development package without claiming a commit",
  async (state) => {
    const { root } = fixture();
    if (state !== "uncommitted") commit(root);
    if (state === "modified" || state === "staged") writeFileSync(join(root, "docs/readme.md"), "Changed\n");
    if (state === "staged") git(root, "add", "docs/readme.md");
    if (state === "untracked") writeFileSync(join(root, "new.txt"), "Uncommitted work\n");
    const result = await prepareWorkbenchPackage(root);
    expect(readDistributionSource(result.directory)).toBeUndefined();
    expect((await unpack(result.archive)).has("workbench/workbench-source.json")).toBe(false);
  },
);

test("ignored payload files cannot acquire the surrounding checkout's identity", async () => {
  const { root } = fixture();
  commit(root);
  writeFileSync(join(root, "docs/ignored.txt"), "Untracked contents\n");
  expect(git(root, "status", "--porcelain")).toBe("");
  await expect(prepareWorkbenchPackage(root)).rejects.toThrow(/not a committed file/);
});

test.each(["development", "committed"])("%s packages omit Python build metadata", async (state) => {
  const { root } = fixture();
  writeFileSync(join(root, ".gitignore"), "*.egg-info/\n");
  if (state === "committed") commit(root);
  const metadata = join(root, "examples/python/src/reference.egg-info");
  mkdirSync(metadata, { recursive: true });
  writeFileSync(join(metadata, "PKG-INFO"), "Generated by the Python dependency setup\n");
  const result = await prepareWorkbenchPackage(root);
  const entries = await unpack(result.archive);
  expect([...entries.keys()].some((name) => name.includes(".egg-info"))).toBe(false);
  expect(existsSync(join(result.directory, "examples/python/src/reference.egg-info"))).toBe(false);
  expect(required(entries.get("workbench/src/reference.ts"), "Expected fixture value").bytes).toEqual(
    readFileSync(join(root, "src/reference.ts")),
  );
  expect(Boolean(readDistributionSource(result.directory))).toBe(state === "committed");
});

test("assume-unchanged does not let changed payload bytes acquire a commit identity", async () => {
  const { root } = fixture();
  commit(root);
  git(root, "update-index", "--assume-unchanged", "docs/readme.md");
  writeFileSync(join(root, "docs/readme.md"), "Hidden working-tree change\n");
  expect(git(root, "status", "--porcelain")).toBe("");
  await expect(prepareWorkbenchPackage(root)).rejects.toThrow(/differs from its committed bytes/);
});

test.skipIf(process.platform === "win32")(
  "untracked executable-mode changes fail committed-input verification",
  async () => {
    const { root } = fixture();
    commit(root);
    git(root, "config", "core.filemode", "false");
    chmodSync(join(root, "bin/workbench.mjs"), 0o644);
    expect(git(root, "status", "--porcelain")).toBe("");
    await expect(prepareWorkbenchPackage(root)).rejects.toThrow(/executable mode/);
  },
);

test.skipIf(process.platform === "win32")("escaping links cannot replace a previously prepared package", async () => {
  const { base, root } = fixture();
  const first = await prepareWorkbenchPackage(root);
  const bytes = readFileSync(first.archive);
  writeFileSync(join(base, "outside"), "Outside package\n");
  symlinkSync("../../outside", join(root, "docs/escape"));
  await expect(prepareWorkbenchPackage(root)).rejects.toThrow(/link escapes/);
  expect(existsSync(join(first.directory, "docs/escape"))).toBe(false);
  expect(readFileSync(first.archive)).toEqual(bytes);
});

test.each([
  null,
  [],
  {},
  { schema_version: 2, repository, revision: "a".repeat(40) },
  { schema_version: 1, repository, revision: "main" },
  { schema_version: 1, repository, revision: "a".repeat(40), extra: true },
])("malformed package identity is rejected instead of falling back: %j", (value) => {
  const { root } = fixture();
  writeFileSync(join(root, "workbench-source.json"), JSON.stringify(value));
  expect(() => readDistributionSource(root)).toThrow(/source identity/);
});

test.skipIf(process.platform === "win32")("source identity cannot be redirected through a symbolic link", () => {
  const { base, root } = fixture();
  writeFileSync(join(base, "source.json"), JSON.stringify({ schema_version: 1, repository, revision: "a".repeat(40) }));
  symlinkSync("../source.json", join(root, "workbench-source.json"));
  expect(() => readDistributionSource(root)).toThrow(/source identity/);
});

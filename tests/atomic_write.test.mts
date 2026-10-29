import { describeError } from "../scripts/diagnostic-errors.mjs";
import { required } from "../src/invariants.ts";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { publishFile, writeAtomic, writeNew } from "../scripts/file-publication.mjs";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const temporary: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform");
function windows() {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-atomic-write-"));
  temporary.push(root);
  const path = join(root, "record.md");
  writeFileSync(path, "original\n");
  return { root, path };
}

test("atomic writes create parents and replace complete contents with the requested permissions", () => {
  const { root, path } = fixture();
  writeAtomic(path, "replacement é 🧪\n", 0o600);
  expect(readFileSync(path, "utf8")).toBe("replacement é 🧪\n");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const nested = join(root, "nested", "new.md");
  writeAtomic(nested, "new\n");
  expect(readFileSync(nested, "utf8")).toBe("new\n");
  expect(readdirSync(root).sort()).toEqual(["nested", "record.md"]);
  expect(readdirSync(join(root, "nested"))).toEqual(["new.md"]);
});

test("a partial write preserves the destination and removes its staging file", () => {
  const { root, path } = fixture();
  const actual = required(vi.mocked(writeFileSync).getMockImplementation(), "Installed mock implementation");
  const failure = new Error("simulated disk full");
  vi.mocked(writeFileSync).mockImplementationOnce((target, contents, options) => {
    if (typeof contents !== "string") throw new Error("Expected textual atomic write");
    actual(target, contents.slice(0, 4), options);
    throw failure;
  });
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("metadata publication can require an existing parent without recreating a removed directory", () => {
  const { root } = fixture();
  const missing = join(root, "removed-cache");
  expect(() => {
    writeAtomic(join(missing, "size.json"), "{}", 0o600, undefined, { createParent: false });
  }).toThrow(expect.objectContaining({ code: "ENOENT" }));
  expect(existsSync(missing)).toBe(false);
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("failed publication preserves the destination and removes its staging file", () => {
  const { root, path } = fixture();
  const failure = new Error("simulated rename failure");
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test.each(["EPERM", "EACCES", "EBUSY"])(
  "Windows retries transient %s replacement failures without deleting the destination",
  (code) => {
    const { root, path } = fixture();
    windows();
    const failure = Object.assign(new Error("sharing violation"), { code });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      expect(readFileSync(path, "utf8")).toBe("original\n");
      throw failure;
    });
    writeAtomic(path, "replacement\n");
    expect(readFileSync(path, "utf8")).toBe("replacement\n");
    expect(readdirSync(root)).toEqual(["record.md"]);
  },
);

test("Windows exhaustion retains the original cause, preserves the destination, and cleans the candidate", () => {
  const { root, path } = fixture();
  windows();
  const failure = Object.assign(new Error("persistent access denial"), { code: "EPERM" });
  vi.mocked(renameSync).mockImplementation(() => {
    throw failure;
  });
  let observed: unknown;
  try {
    writeAtomic(path, "replacement\n");
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({ cause: failure });
  expect(describeError(observed)).toMatch(/after \d+ attempts/);
  expect(describeError(observed)).toContain(failure.message);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("a conflicting edit during a Windows replacement retry prevents publication", () => {
  const { root, path } = fixture();
  windows();
  vi.mocked(renameSync).mockImplementationOnce(() => {
    writeFileSync(path, "concurrent edit\n");
    throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
  });
  expect(() => {
    publishFile(path, "replacement\n", Buffer.from("original\n"));
  }).toThrow("changed before replacement");
  expect(readFileSync(path, "utf8")).toBe("concurrent edit\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test.each(["ENOSPC", "ENOENT", "EIO"])("Windows does not retry permanent %s replacement failures", (code) => {
  const { root, path } = fixture();
  windows();
  const failure = Object.assign(new Error("permanent replacement failure"), { code });
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("a close failure prevents publication and preserves the destination", () => {
  const { root, path } = fixture();
  const actual = required(vi.mocked(closeSync).getMockImplementation(), "Installed mock implementation");
  const failure = new Error("simulated close failure");
  vi.mocked(closeSync).mockImplementationOnce((fd) => {
    actual(fd);
    throw failure;
  });
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("cleanup failure reports the original publication error and the retained staging file", () => {
  const { root, path } = fixture();
  const failure = new Error("simulated rename failure");
  const cleanup = new Error("simulated unlink failure");
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw failure;
  });
  vi.mocked(unlinkSync).mockImplementationOnce(() => {
    throw cleanup;
  });
  let observed: unknown;
  try {
    writeAtomic(path, "replacement\n");
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({ cause: failure });
  expect(describeError(observed)).toContain(cleanup.message);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  const retained = readdirSync(root).find((name) => name.endsWith(".tmp"));
  expect(retained).toBeDefined();
  expect((observed as Error).message).toContain(join(root, required(retained, "Fixture value retained")));
});

test("failure closing a partial write does not hide the write error", () => {
  const { root, path } = fixture();
  const actualWrite = required(vi.mocked(writeFileSync).getMockImplementation(), "Installed mock implementation");
  const actualClose = required(vi.mocked(closeSync).getMockImplementation(), "Installed mock implementation");
  const failure = new Error("simulated disk full");
  vi.mocked(writeFileSync).mockImplementationOnce((target, contents, options) => {
    if (typeof contents !== "string") throw new Error("Expected textual atomic write");
    actualWrite(target, contents.slice(0, 4), options);
    throw failure;
  });
  vi.mocked(closeSync).mockImplementationOnce((fd) => {
    actualClose(fd);
    throw new Error("simulated close failure");
  });
  let observed: unknown;
  try {
    writeAtomic(path, "replacement\n");
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({ cause: failure });
  expect(describeError(observed)).toContain("simulated close failure");
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("a staging-name collision preserves both the destination and the unrelated file", () => {
  const { root, path } = fixture();
  const collision = join(root, ".record.md.00000000-0000-4000-8000-000000000000.tmp");
  writeFileSync(collision, "other writer\n");
  vi.mocked(randomUUID).mockReturnValueOnce("00000000-0000-4000-8000-000000000000");
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(/EEXIST/);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readFileSync(collision, "utf8")).toBe("other writer\n");
});

test("publication rechecks expected bytes after staging and preserves an intervening edit", () => {
  const { root, path } = fixture(),
    actual = vi.mocked(writeFileSync).getMockImplementation();
  if (!actual) throw new Error("Missing filesystem implementation");
  vi.mocked(writeFileSync).mockImplementationOnce((target, contents, options) => {
    actual(target, contents, options);
    actual(path, "concurrent edit\n");
  });
  expect(() => {
    publishFile(path, "replacement\n", Buffer.from("original\n"));
  }).toThrow("changed before replacement");
  expect(readFileSync(path, "utf8")).toBe("concurrent edit\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
});

test("publication rejects stale contents and never overwrites a newly created file", () => {
  const { root } = fixture(),
    file = join(root, "record");
  writeNew(file, "first");
  expect(() => {
    writeNew(file, "second");
  }).toThrow(/EEXIST/);
  expect(() => {
    publishFile(file, "second", Buffer.from("stale"));
  }).toThrow("changed before replacement");
  expect(readFileSync(file, "utf8")).toBe("first");
  publishFile(file, "second", Buffer.from("first"));
  expect(readFileSync(file, "utf8")).toBe("second");
});

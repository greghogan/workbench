import { required } from "../src/invariants.ts";
import {
  closeSync,
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
import { writeAtomic } from "../src/core.ts";

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
afterEach(() => {
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
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  const retained = readdirSync(root).find((name) => name.endsWith(".tmp"));
  expect(retained).toBeDefined();
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining(join(root, required(retained, "Fixture value retained"))),
  );
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(cleanup.message));
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
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(() => {
    writeAtomic(path, "replacement\n");
  }).toThrow(failure);
  expect(readFileSync(path, "utf8")).toBe("original\n");
  expect(readdirSync(root)).toEqual(["record.md"]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("simulated close failure"));
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

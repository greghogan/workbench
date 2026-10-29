import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readBoundedFile, readBoundedFileAsync, readFilePrefix } from "../src/file-reads.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-bounded-reads-"));
  temporary.push(directory);
  const path = join(directory, "bytes");
  const bytes = Buffer.from("Aλ\0Z");
  writeFileSync(path, bytes);
  return { directory, path, bytes };
}
test("sync and async bounded reads preserve exact bytes at the size boundary", async () => {
  const { path, bytes } = fixture();
  expect(readBoundedFile(path, bytes.length)).toEqual(bytes);
  expect(await readBoundedFileAsync(path, bytes.length)).toEqual(bytes);
  expect(readFilePrefix(path, 2)).toEqual(bytes.subarray(0, 2));
  expect(readFilePrefix(path, 0)).toEqual(Buffer.alloc(0));
  expect(readFilePrefix(path, bytes.length + 1)).toEqual(bytes);
  expect(() => readBoundedFile(path, bytes.length - 1)).toThrow(/oversized/);
  await expect(readBoundedFileAsync(path, bytes.length - 1)).rejects.toThrow(/oversized/);
  writeFileSync(path, Buffer.alloc(0));
  expect(readBoundedFile(path, 0)).toEqual(Buffer.alloc(0));
  expect(await readBoundedFileAsync(path, 0)).toEqual(Buffer.alloc(0));
});
test("bounded reads reject directories, missing files and invalid allocation limits", async () => {
  const { directory, path } = fixture();
  expect(() => readBoundedFile(directory, 1024)).toThrow();
  expect(() => readFilePrefix(directory, 1)).toThrow();
  await expect(readBoundedFileAsync(directory, 1024)).rejects.toThrow();
  for (const limit of [-1, Infinity, 1.5]) {
    expect(() => readBoundedFile(path, limit)).toThrow(/byte limit/);
    expect(() => readFilePrefix(path, limit)).toThrow(/byte limit/);
    await expect(readBoundedFileAsync(path, limit)).rejects.toThrow(/byte limit/);
  }
  rmSync(path);
  expect(() => readBoundedFile(path, 1024)).toThrow();
  await expect(readBoundedFileAsync(path, 1024)).rejects.toThrow();
});
test("bounded reads reject leaf symlinks where the host permits their creation", async (context) => {
  const { directory, path } = fixture();
  const link = join(directory, "link");
  try {
    symlinkSync(path, link, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Windows symlink creation is unavailable");
      return;
    }
    throw error;
  }
  expect(() => readBoundedFile(link, 1024)).toThrow();
  await expect(readBoundedFileAsync(link, 1024)).rejects.toThrow();
  expect(() => readFilePrefix(link, 5)).toThrow();
});

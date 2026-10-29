import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  read: undefined as (() => void) | undefined,
  close: undefined as (() => void) | undefined,
  closes: 0,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      const count = Reflect.apply(actual.readSync, actual, args) as number;
      hooks.read?.();
      return count;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      hooks.closes++;
      hooks.close?.();
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      return {
        stat: () => file.stat(),
        read: async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(file.read.bind(file), file, args);
          hooks.read?.();
          return result;
        },
        close: async () => {
          await file.close();
          hooks.closes++;
          hooks.close?.();
        },
      };
    },
  };
});
import { readBoundedFile, readBoundedFileAsync, readFilePrefix } from "../src/file-reads.ts";
const temporary: string[] = [];
afterEach(() => {
  hooks.read = hooks.close = undefined;
  hooks.closes = 0;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "workbench-read-faults-"));
  temporary.push(directory);
  const path = join(directory, "bytes");
  writeFileSync(path, "initial");
  return path;
}
for (const mode of ["sync", "async", "prefix"] as const) {
  test(`${mode} reads reject growth, truncation and same-size mutation during a descriptor-bound read`, async () => {
    for (const mutate of [
      (path: string) => {
        appendFileSync(path, "grew");
      },
      (path: string) => {
        writeFileSync(path, "");
      },
      (path: string) => {
        writeFileSync(path, "changed");
      },
    ]) {
      const path = fixture();
      hooks.read = () => {
        hooks.read = undefined;
        mutate(path);
        const later = new Date(Date.now() + 2000);
        utimesSync(path, later, later);
      };
      if (mode === "sync") expect(() => readBoundedFile(path, 64)).toThrow(/changed during/);
      else if (mode === "prefix") expect(() => readFilePrefix(path, 3)).toThrow(/changed during/);
      else await expect(readBoundedFileAsync(path, 64)).rejects.toThrow(/changed during/);
    }
    expect(hooks.closes).toBe(3);
  });
  test(`${mode} reads preserve both read and close failures while closing the descriptor once`, async () => {
    const path = fixture(),
      primary = new Error("injected read failure"),
      cleanup = new Error("injected close failure");
    hooks.read = () => {
      throw primary;
    };
    hooks.close = () => {
      throw cleanup;
    };
    let failure: unknown;
    try {
      if (mode === "sync") readBoundedFile(path, 64);
      else if (mode === "prefix") readFilePrefix(path, 3);
      else await readBoundedFileAsync(path, 64);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
    expect(hooks.closes).toBe(1);
  });
}

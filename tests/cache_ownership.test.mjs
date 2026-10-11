import { mkdtempSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { restoreCacheOwnership } from "../scripts/cache-ownership.mjs";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return { ...actual, lchown: vi.fn(actual.lchown) };
});

test.skipIf(process.platform === "win32")(
  "shared cache ownership tolerates removed children, preserves real errors, and never follows symlinks",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-cache-ownership-"));
    const missing = join(root, "vanishing");
    const denied = join(root, "denied");
    writeFileSync(missing, "temporary SQLite file");
    writeFileSync(denied, "cache file");
    const actual = await vi.importActual("node:fs/promises");
    const uid = process.getuid(),
      gid = process.getgid();
    try {
      promises.lchown.mockImplementation(async (path, owner, group) => {
        if (path === missing) await actual.unlink(path);
        return actual.lchown(path, owner, group);
      });
      await restoreCacheOwnership(root, uid, gid);
      expect(existsSync(missing)).toBe(false);
      promises.lchown.mockImplementation(async (path, owner, group) => {
        if (path === denied) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return actual.lchown(path, owner, group);
      });
      await expect(restoreCacheOwnership(root, uid, gid)).rejects.toThrow(/permission denied/);
      await expect(restoreCacheOwnership(join(root, "absent-root"), uid, gid)).rejects.toMatchObject({
        code: "ENOENT",
      });
      promises.lchown.mockImplementation(actual.lchown);
      promises.lchown.mockClear();
      symlinkSync(root, join(root, "cycle"));
      await restoreCacheOwnership(root, uid, gid);
      expect(promises.lchown.mock.calls.map(([path]) => path).toSorted()).toEqual(
        [root, denied, join(root, "cycle")].toSorted(),
      );
      const program = resolve(import.meta.dirname, "../scripts/cache-ownership.mjs");
      const inline = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          readFileSync(program, "utf8"),
          "--",
          "workbench-cache-ownership",
          `${uid}:${gid}`,
          root,
        ],
        { encoding: "utf8" },
      );
      expect(inline.stderr).toBe("");
      expect(inline.status).toBe(0);
      const invalid = spawnSync(process.execPath, [program, "invalid-owner", root], { encoding: "utf8" });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("requires uid:gid");
    } finally {
      promises.lchown.mockImplementation(actual.lchown);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

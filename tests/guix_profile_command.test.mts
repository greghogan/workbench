import { promised } from "./fixtures/promised.mjs";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runGuixProfile } from "../scripts/guix-profile-command.mjs";
import { withManagedProcesses, type ManagedProcessScope } from "../scripts/managed-process.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
test.skipIf(process.platform === "win32")(
  "failed replacement retains the old root; successful replacement stays rooted through publication",
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-guix-root-")));
    temporary.push(directory);
    const previous = join(directory, "previous"),
      next = join(directory, "next"),
      profile = join(directory, "profile"),
      pending = `${profile}-pending`;
    mkdirSync(previous);
    mkdirSync(next);
    symlinkSync(previous, profile);
    let failBuild = true,
      failRegister = false;
    const roots = new Set([profile]);
    await withManagedProcesses(async (original) => {
      const scope: ManagedProcessScope = {
        ...original,
        run: (_command, args) =>
          promised(() => {
            if (args.includes("register-root")) {
              if (realpathSync(profile) === next) {
                expect(roots.has(pending) && existsSync(pending)).toBe(true);
                if (failRegister) throw new Error("registration failed");
              }
              roots.add(profile);
            } else {
              symlinkSync(next, pending);
              roots.add(pending);
              if (failBuild) throw new Error("build failed");
            }
            return "";
          }),
      };
      await expect(runGuixProfile(profile, ["guix", "shell"], scope)).rejects.toThrow("build failed");
      expect(realpathSync(profile)).toBe(previous);
      failBuild = false;
      failRegister = true;
      await expect(runGuixProfile(profile, ["guix", "shell"], scope)).rejects.toThrow("registration failed");
      expect(realpathSync(pending)).toBe(next);
      failRegister = false;
      await runGuixProfile(profile, ["guix", "shell"], scope);
      expect(realpathSync(profile)).toBe(next);
      expect(existsSync(pending)).toBe(false);
    });
  },
);

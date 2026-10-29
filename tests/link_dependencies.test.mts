import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { linkDependencies } from "../scripts/link-dependencies.mjs";

test.each([undefined, ["@scope/package", "plain"]])(
  "linked dependencies keep their virtual-store base with selection %s",
  (selection) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workbench-dependency-links-")));
    try {
      const source = join(root, "source/node_modules");
      const selected = join(source, ".pnpm/package/node_modules/package");
      mkdirSync(selected, { recursive: true });
      mkdirSync(join(source, "@scope"));
      writeFileSync(join(selected, "value"), "original package");
      for (const name of ["@scope/package", "plain"])
        symlinkSync(
          process.platform === "win32" ? selected : relative(join(source, name, ".."), selected),
          join(source, name),
          "junction",
        );
      const destination = join(root, "workspace/node_modules");
      mkdirSync(join(root, "workspace"));
      linkDependencies(source, destination, selection);
      if (selection) expect(readdirSync(destination).sort()).toEqual(["@scope", "plain"]);
      for (const name of ["@scope/package", "plain"]) {
        expect(readFileSync(join(destination, name, "value"), "utf8")).toBe("original package");
        expect(realpathSync.native(join(destination, name))).toBe(selected);
      }
      rmSync(join(root, "workspace"), { recursive: true });
      expect(readFileSync(join(selected, "value"), "utf8")).toBe("original package");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

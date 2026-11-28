import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { expect, test } from "vitest";
import { linkDependencies } from "../../../../scripts/link-dependencies.mjs";

test.each([
  { selection: undefined, relativeTarget: false },
  { selection: undefined, relativeTarget: true },
  { selection: ["@scope/package", "plain"], relativeTarget: false },
])("linked dependencies keep their virtual-store base with selection %s", ({ selection, relativeTarget }) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workbench-dependency-links-")));
  try {
    const source = join(root, "source/node_modules");
    const selected = join(source, ".pnpm/package/node_modules/package");
    mkdirSync(selected, { recursive: true });
    mkdirSync(join(source, "@scope"));
    writeFileSync(join(selected, "value"), "original package");
    const metadata = JSON.stringify({ virtualStoreDir: ".pnpm", packageManager: "pnpm@12.16.1" });
    writeFileSync(join(source, ".modules.yaml"), metadata);
    mkdirSync(join(source, ".bin"));
    const launcher = "#!/bin/sh\nprintf '%s\\n' \"$1\"\n";
    writeFileSync(join(source, ".bin/plain"), launcher, { mode: 0o755 });
    const executable = join(selected, "bin.cjs");
    writeFileSync(executable, "console.log(process.argv[2])");
    const targetPath = relative(join(source, ".bin"), executable).replaceAll("\\", "/");
    writeFileSync(
      join(source, ".bin/managed"),
      `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir"/'${targetPath}' "$@"\n# cmd-shim-target=${relativeTarget ? targetPath : executable}\n`,
      { mode: 0o755 },
    );
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
    else {
      const borrowed = JSON.parse(readFileSync(join(destination, ".modules.yaml"), "utf8")) as {
        virtualStoreDir: string;
      };
      expect(borrowed.virtualStoreDir).toBe(join(source, ".pnpm"));
      const launched = spawnSync("sh", [join(destination, ".bin/plain"), "relocated launcher"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(launched.status, launched.stderr).toBe(0);
      expect(launched.stdout).toBe("relocated launcher\n");
      renameSync(join(source, ".bin"), join(source, ".hidden-bin"));
      try {
        const packageRun = spawnSync("sh", [join(destination, ".bin/managed"), "portable target"], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
          },
        });
        expect(packageRun.status, packageRun.stderr).toBe(0);
        expect(packageRun.stdout).toBe("portable target\n");
      } finally {
        renameSync(join(source, ".hidden-bin"), join(source, ".bin"));
      }
      writeFileSync(join(destination, ".modules.yaml"), "snapshot metadata");
      writeFileSync(join(destination, ".bin/plain"), "snapshot launcher");
      expect(readFileSync(join(source, ".modules.yaml"), "utf8")).toBe(metadata);
      expect(readFileSync(join(source, ".bin/plain"), "utf8")).toBe(launcher);
    }
    for (const name of ["@scope/package", "plain"]) {
      expect(readFileSync(join(destination, name, "value"), "utf8")).toBe("original package");
      expect(realpathSync.native(join(destination, name))).toBe(selected);
    }
    rmSync(join(root, "workspace"), { recursive: true });
    expect(readFileSync(join(selected, "value"), "utf8")).toBe("original package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

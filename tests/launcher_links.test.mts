import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, test } from "vitest";

// npm creates its own shim; the shipped Bash entry also supports direct archive installations.
test.skipIf(process.platform === "win32")(
  "the Bash launcher follows file and directory links without changing arguments",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-launcher-links-"));
    try {
      const directory = join(root, "distribution with spaces 雪", "bin");
      mkdirSync(directory, { recursive: true });
      const launcher = join(directory, "workbench");
      copyFileSync(new URL("../bin/workbench", import.meta.url), launcher);
      chmodSync(launcher, 0o755);
      writeFileSync(join(directory, "workbench.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
      const links = join(root, "links");
      mkdirSync(links);
      symlinkSync(launcher, join(links, "absolute"));
      symlinkSync("../distribution with spaces 雪/bin/workbench", join(links, "relative"));
      symlinkSync("relative", join(links, "nested"));
      symlinkSync(directory, join(root, "directory-link"));
      const args = ["literal $HOME", "quotes '\" and spaces", "雪", "--flag=value"];
      const env = { ...process.env, PATH: [dirname(process.execPath), links, process.env.PATH].join(delimiter) };
      for (const entry of [
        launcher,
        join(links, "absolute"),
        join(links, "relative"),
        join(links, "nested"),
        join(root, "directory-link/workbench"),
        "nested",
      ]) {
        const result = spawnSync(entry, args, { cwd: root, env, encoding: "utf8" });
        expect(result.status, `${entry}: ${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

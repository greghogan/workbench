import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { execute } from "../src/tool-execution.ts";

test("native execution needs no shell and preserves literal arguments", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-tool-execution-")));
  try {
    const script = join(root, "tool space 雪.mjs"),
      args = ["writer's notes", "", 'a "quote"', "C:\\trailing path\\", "$HOME;$(false)"];
    writeFileSync(script, "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
    );
    const result = execute(basename(process.execPath).replace(/\.exe$/i, ""), [script, ...args], {
      cwd: root,
      env: { ...environment, PATH: dirname(process.execPath) },
      capture: true,
    });
    expect(JSON.parse(result)).toEqual({ args, cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

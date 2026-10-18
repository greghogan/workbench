import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { copySourceCheckout } from "../scripts/source-checkout.mjs";
import { waitForCondition } from "./fixtures/coordination.mjs";

test("source snapshots retain root environment dependencies without copying generated installations", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-source-checkout-"));
  const root = join(directory, "source"),
    output = join(directory, "copy");
  mkdirSync(root);
  const files = [
    "manifest.scm",
    "check-inputs.nix",
    "check-inputs.scm",
    "managed-check-inputs.json",
    "managed-bootstrap.json",
    "managed-registry.json.br",
  ];
  try {
    for (const file of files) writeFileSync(join(root, file), `dependency metadata: ${file}`);
    mkdirSync(join(root, "examples/app/vendor"), { recursive: true });
    writeFileSync(join(root, "examples/app/vendor/generated"), "installed dependency");
    writeFileSync(join(root, "examples/app/managed-check-inputs.json"), "nested dependency metadata");
    copySourceCheckout(root, output);
    for (const file of files) expect(readFileSync(join(output, file))).toEqual(readFileSync(join(root, file)));
    expect(readFileSync(join(output, "examples/app/managed-check-inputs.json"), "utf8")).toBe(
      "nested dependency metadata",
    );
    expect(existsSync(join(output, "examples/app/vendor"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source snapshots remain isolated while another check replaces excluded example outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-concurrent-source-"));
  const root = join(directory, "source");
  const example = join(root, "examples/app");
  mkdirSync(example, { recursive: true });
  writeFileSync(join(example, "source.txt"), "authored input");
  const generated = ["build", "coverage", "node_modules", ".venv", "target", "dist"];
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import {existsSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const [directory,example]=process.argv.slice(1);
const names=${JSON.stringify(generated)};
writeFileSync(join(directory,'ready'),'ready');
while(!existsSync(join(directory,'stop'))) {
 for(const name of names) {
  const path=join(example,name);mkdirSync(path,{recursive:true});
  writeFileSync(join(path,'generated'),'changing output');
  rmSync(path,{recursive:true,force:true});
 }
}
`,
      directory,
      example,
    ],
    { stdio: "ignore" },
  );
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    await waitForCondition(() => existsSync(join(directory, "ready")), closed, "concurrent output writer");
    for (let index = 0; index < 3; index++) {
      const output = join(directory, `copy-${String(index)}`);
      copySourceCheckout(root, output);
      expect(readFileSync(join(output, "examples/app/source.txt"), "utf8")).toBe("authored input");
      for (const name of generated) expect(existsSync(join(output, "examples/app", name))).toBe(false);
    }
  } finally {
    writeFileSync(join(directory, "stop"), "stop");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});

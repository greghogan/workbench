import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "vitest";
import { readConfig, readProjects, readLanguageRoots, scan } from "../src/core.ts";
import { citationLibrarySetting } from "../src/citations.ts";

const roots = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const base = "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-config-"));
  roots.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/config.toml"), base);
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="root"\npath="."\n');
  return root;
}

test("shared settings and automation reject typos, wrong types and conflicting ownership", () => {
  const root = fixture();
  for (const input of ['\n[checks]\nenvironmnt="guix"', '\n[checks]\nallow_empty="true"', "\ncheck=[]"]) {
    writeFileSync(join(root, "workbench/config.toml"), base + input);
    assert.throws(() => readConfig(root), /unknown field|Boolean/);
  }
  writeFileSync(join(root, "workbench/config.toml"), base + '\n[extensions.team]\nlabel="custom"\n');
  writeFileSync(join(root, "workbench/automation.toml"), '[[check]]\nname="test"\nrole="test"\ncommand=["true"]\n');
  assert.deepEqual(readConfig(root).check[0].command, ["true"]);
  writeFileSync(join(root, "workbench/automation.toml"), '[checks]\nenvironment="guix"');
  assert.throws(() => readConfig(root), /belongs in config.toml/);
  writeFileSync(join(root, "workbench/automation.toml"), '[extensions]\nlabel="second"');
  assert.throws(() => readConfig(root), /already defined/);
});

test("both registry readers reject misspelled fields", () => {
  const root = fixture();
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="root"\npath="."\nlangauge="rust"');
  for (const reader of [readProjects, readLanguageRoots]) assert.throws(() => reader(root), /unknown field 'langauge'/);
});

test("portable library paths and symlinked record parents cannot escape ownership", () => {
  const root = fixture();
  for (const value of ["library\\..\\..\\outside", "C:/outside", "../outside", "/outside"]) {
    writeFileSync(join(root, "workbench/config.toml"), base + `\n[citations]\nlibrary_dir='${value}'\n`);
    assert.throws(() => citationLibrarySetting(root), /safe relative path|unsafe relative path/);
  }
  const outside = fixture();
  rmSync(join(root, "workbench"), { recursive: true });
  symlinkSync(join(outside, "workbench"), join(root, "workbench"), "junction");
  assert.throws(() => readConfig(root), /symlinks are not supported/);
  assert.throws(() => scan(root, "ADR"), /symlinks are not supported/);
});

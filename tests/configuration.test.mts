import { required } from "../src/invariants.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "vitest";
import {
  configFromData,
  kinds,
  readConfig,
  readProjects,
  readLanguageRoots,
  relativeRecordPath,
  scan,
} from "../src/core.ts";
import { citationLibrarySetting } from "../src/citations.ts";

const roots: string[] = [];
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
  assert.deepEqual(
    required(
      required(readConfig(root).check, "Expected fixture value: readConfig(root).check")[0],
      "Expected fixture value: readConfig(root).check[0]",
    ).command,
    ["true"],
  );
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

test("existing-data policy defaults to asking and validates independently of backward compatibility", () => {
  const root = fixture();
  assert.deepEqual(readConfig(root).compatibility, { required: false, data: "ask" });
  const input = { schema_version: 1, markdown: { wrap_width: 120 }, compatibility: { required: false } };
  assert.deepEqual(configFromData(input, undefined, "config.toml").compatibility, { required: false, data: "ask" });
  assert.deepEqual(input.compatibility, { required: false });
  for (const required of [false, true]) {
    const config = base.replace("required=false", `required=${String(required)}`);
    for (const data of ["ask", "migrate", "delete"]) {
      writeFileSync(join(root, "workbench/config.toml"), `${config}data="${data}"\n`);
      assert.deepEqual(readConfig(root).compatibility, { required, data });
    }
    for (const value of ['"discard"', '"DELETE"', '""', "true", "0", "[]", "{}"]) {
      writeFileSync(join(root, "workbench/config.toml"), `${config}data=${value}\n`);
      assert.throws(() => readConfig(root), /compatibility\.data.*ask or migrate or delete/);
    }
  }
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

test("record discovery skips owned supporting directories and still validates unowned files", () => {
  const root = fixture();
  for (const kind of kinds) {
    for (const number of ["0", "100"]) {
      const record = join(root, "workbench", relativeRecordPath(kind, number));
      const supporting = record.slice(0, -extname(record).length);
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, "record contents are validated separately\n");
      mkdirSync(join(supporting, "fixtures"), { recursive: true });
      writeFileSync(join(supporting, "notes.md"), "supporting material\n");
      writeFileSync(join(supporting, "fixtures", `${kind}-02.md`), "a fixture, not another record\n");
    }
    assert.deepEqual(
      scan(root, kind).map((record) => record.number),
      ["0", "100"],
    );
    rmSync(join(root, "workbench", relativeRecordPath(kind, "0")));
    assert.throws(() => scan(root, kind), /unexpected file in record directory|expected canonical path/);
  }
});

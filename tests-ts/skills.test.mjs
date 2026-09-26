import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import skills from "../bundle/skills.cjs";

const { syncSkills } = skills;

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "workbench-skills-"));
  const root = join(directory, "project");
  const distribution = join(directory, "distribution");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "component"), { recursive: true });
  for (const skill of ["guix-update", "nix-update", "languages/rust/rust-refresh"]) {
    const source = join(distribution, "skills", skill);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), `# ${skill}\n`);
  }
  writeFileSync(
    join(root, "workbench/projects.toml"),
    'schema_version = 1\n[[project]]\nid = "main"\npath = "."\n' +
      '[[project]]\nid = "component"\npath = "component"\n' +
      '[[language_root]]\nlanguage = "typescript"\npath = "."\n' +
      '[[language_root]]\nlanguage = "rust"\npath = "component"\n',
  );
  const config = (environment) =>
    writeFileSync(
      join(root, "workbench/config.toml"),
      `schema_version = 1\n[checks]\nenvironment = "${environment}"\n[[check]]\nname = "test"\ncommand = ["true"]\n`,
    );
  try {
    run({ root, distribution, config });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only active environment and language skills are exposed", () =>
  fixture(({ root, distribution, config }) => {
    config("none");
    const first = syncSkills(root, distribution);
    assert.equal(first.length, 2);
    assert.match(readlinkSync(join(root, ".agents/skills/rust-refresh")), /rust-refresh$/);
    assert.match(readlinkSync(join(root, "component/.claude/skills/rust-refresh")), /rust-refresh$/);
    assert.throws(() => readlinkSync(join(root, ".claude/skills/rust-refresh")), { code: "ENOENT" });
    assert.throws(() => readlinkSync(join(root, ".agents/skills/guix-update")), { code: "ENOENT" });

    config("guix");
    assert.throws(() => syncSkills(root, distribution, true), /missing configured skill/);
    assert.equal(syncSkills(root, distribution).length, 2);
    assert.match(readlinkSync(join(root, ".claude/skills/guix-update")), /guix-update$/);

    config("nix");
    assert.equal(syncSkills(root, distribution).length, 4);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/guix-update")), { code: "ENOENT" });
    assert.match(readlinkSync(join(root, ".agents/skills/nix-update")), /nix-update$/);
    assert.equal(syncSkills(root, distribution, true).length, 0);

    config("nix-docker");
    assert.equal(syncSkills(root, distribution, true).length, 0);
    assert.match(readlinkSync(join(root, ".agents/skills/nix-update")), /nix-update$/);

    const registry = join(root, "workbench/projects.toml");
    writeFileSync(
      registry,
      readFileSync(registry, "utf8").replace('[[language_root]]\nlanguage = "rust"\npath = "component"\n', ""),
    );
    assert.equal(syncSkills(root, distribution).length, 2);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/rust-refresh")), { code: "ENOENT" });
    assert.throws(() => readlinkSync(join(root, "component/.claude/skills/rust-refresh")), { code: "ENOENT" });

    writeFileSync(join(root, "workbench/config.toml"), 'schema_version = 1\n[checks]\nenvironment = "nix"\n');
    assert.equal(syncSkills(root, distribution).length, 2);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/nix-update")), { code: "ENOENT" });
  }));

test("does not overwrite a user-owned skill", () =>
  fixture(({ root, distribution, config }) => {
    config("guix");
    const folder = join(root, ".agents/skills");
    mkdirSync(folder, { recursive: true });
    const ownedElsewhere = join(root, "own-skill");
    mkdirSync(ownedElsewhere);
    symlinkSync(ownedElsewhere, join(folder, "guix-update"), "dir");
    assert.throws(() => syncSkills(root, distribution), /user-owned skill blocks/);
    assert.equal(readlinkSync(join(folder, "guix-update")), ownedElsewhere);
  }));

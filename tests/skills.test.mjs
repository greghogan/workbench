import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import skills from "../bundle/skills.cjs";

const { syncSkills } = skills;

function fixture(run) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-skills-")));
  const root = join(directory, "project");
  const distribution = join(directory, "distribution");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "component"), { recursive: true });
  for (const skill of ["guix-update", "nix-update", "languages/rust/rust-refresh", "workflows/review-work"]) {
    const source = join(distribution, "skills", skill);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), `---\nname: ${skill.split("/").at(-1)}\ndescription: Test skill.\n---\n`);
  }
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid = "main"\npath = "."\n' +
      '[[project]]\nid = "component"\npath = "component"\n' +
      '[[language_root]]\nlanguage = "typescript"\npath = "."\n' +
      '[[language_root]]\nlanguage = "rust"\npath = "component"\n',
  );
  const config = (environment) =>
    writeFileSync(
      join(root, "workbench/config.toml"),
      `schema_version = 1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment = "${environment}"\n[[check]]\nname = "test"\ncommand = ["true"]\n`,
    );
  try {
    run({ root, distribution, config });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only active environment and language skills are exposed", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    const canonical = (link, skill) =>
      assert.equal(realpathSync(join(root, link, "SKILL.md")), join(distribution, "skills", skill, "SKILL.md"));
    syncSkills(root, distribution);
    canonical(".agents/skills/rust-refresh", "languages/rust/rust-refresh");
    canonical(".claude/skills/rust-refresh", "languages/rust/rust-refresh");
    canonical(".agents/skills/review-work", "workflows/review-work");
    canonical(".claude/skills/review-work", "workflows/review-work");
    config("devcontainer");
    syncSkills(root, distribution);
    canonical(".agents/skills/rust-refresh", "languages/rust/rust-refresh");
    canonical(".claude/skills/review-work", "workflows/review-work");
    config("native");
    assert.equal(existsSync(join(root, "component/.claude")), false);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/guix-update")), { code: "ENOENT" });

    const configuration = join(root, "workbench/config.toml");
    writeFileSync(
      configuration,
      readFileSync(configuration, "utf8") +
        '\n[ci]\noperating_systems = ["linux"]\nenvironments = ["guix", "nix-docker"]\n',
    );
    syncSkills(root, distribution);
    canonical(".agents/skills/guix-update", "guix-update");
    canonical(".claude/skills/nix-update", "nix-update");
    config("native");
    syncSkills(root, distribution);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/guix-update")), { code: "ENOENT" });
    assert.throws(() => readlinkSync(join(root, ".claude/skills/nix-update")), { code: "ENOENT" });

    config("guix");
    assert.throws(() => syncSkills(root, distribution, true), /missing configured skill/);
    syncSkills(root, distribution);
    canonical(".claude/skills/guix-update", "guix-update");

    config("nix");
    syncSkills(root, distribution);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/guix-update")), { code: "ENOENT" });
    canonical(".agents/skills/nix-update", "nix-update");
    assert.equal(syncSkills(root, distribution, true).length, 0);

    config("nix-docker");
    assert.equal(syncSkills(root, distribution, true).length, 0);
    canonical(".agents/skills/nix-update", "nix-update");

    const registry = join(root, "workbench/projects.toml");
    writeFileSync(
      registry,
      readFileSync(registry, "utf8").replace('[[language_root]]\nlanguage = "rust"\npath = "component"\n', ""),
    );
    syncSkills(root, distribution);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/rust-refresh")), { code: "ENOENT" });
    assert.throws(() => readlinkSync(join(root, ".claude/skills/rust-refresh")), { code: "ENOENT" });

    writeFileSync(
      join(root, "workbench/config.toml"),
      'schema_version = 1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment = "nix"\n',
    );
    syncSkills(root, distribution);
    assert.throws(() => readlinkSync(join(root, ".agents/skills/nix-update")), { code: "ENOENT" });
  }));

test("removed canonical skills and unregistered language roots leave no stale discovery", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    syncSkills(root, distribution);
    rmSync(join(distribution, "skills/workflows/review-work"), { recursive: true });
    writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid = "main"\npath = "."\n');
    assert.throws(() => syncSkills(root, distribution, true), /stale skill link/);
    syncSkills(root, distribution);
    for (const folder of [".agents/skills", ".claude/skills"])
      for (const name of ["review-work", "rust-refresh"])
        assert.throws(() => readlinkSync(join(root, folder, name)), { code: "ENOENT" });
    assert.deepEqual(syncSkills(root, distribution, true), []);
  }));

test("skill metadata and invocation controls are validated before activation", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    const source = join(distribution, "skills/workflows/review-work");
    const path = join(source, "SKILL.md");
    writeFileSync(path, "---\nname: wrong-name\ndescription: Test skill.\n---\n");
    assert.throws(() => syncSkills(root, distribution), /name must match/);
    writeFileSync(path, "---\nname: review-work\ndescription: Test skill.\ndisable-model-invocation: true\n---\n");
    assert.throws(() => syncSkills(root, distribution), /invocation policies must agree/);
    mkdirSync(join(source, "agents"));
    writeFileSync(join(source, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    syncSkills(root, distribution);
    for (const folder of [".agents/skills", ".claude/skills"])
      assert.equal(realpathSync(join(root, folder, "review-work/SKILL.md")), path);
  }));

test("redirected discovery directories cannot change files outside the workspace", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    const outside = join(distribution, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".claude"), "dir");
    assert.throws(() => syncSkills(root, distribution), /real directory/);
    assert.equal(existsSync(join(outside, "skills")), false);
    assert.equal(existsSync(join(root, ".agents")), false);
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

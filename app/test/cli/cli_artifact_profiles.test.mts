import assert from "node:assert/strict";
import { fixture, snapshot } from "../fixtures/cli-browsing.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

test("profile discovery is symmetric and release tables keep roots separate from targets", () =>
  fixture(({ root, run }) => {
    assert.deepEqual(JSON.parse(run("development", "profiles", "--json")), JSON.parse(run("development", "--json")));
    assert.match(run("development", "--help"), /profiles/);
    assert.match(run("release", "profiles"), /No release profiles configured/);
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      join(root, "workbench/projects.toml"),
      readFileSync(join(root, "workbench/projects.toml"), "utf8") +
        '\n[[language_root]]\nlanguage = "go"\npath = "."\n',
    );
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[[release.profiles]]\nname = "app"\npath = "."\nbuilder = "native"\nformat = "directory"\nplatform = "linux-x64"\nprepare = ["build"]\nverify = ["verify"]\n',
    );
    const before = snapshot(root);
    const profiles = JSON.parse(run("release", "profiles", "--json")) as { profiles: { name: string }[] };
    assert.deepEqual(
      profiles.profiles.map((profile) => profile.name),
      ["app"],
    );
    const table = run("release", "profiles");
    assert.match(table, /\n\.\n/);
    assert.deepEqual(
      table
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .map((line) =>
          line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim()),
        ),
      [
        ["PROFILE", "BUILDER", "FORMAT", "TARGET"],
        ["app", "native", "directory", "linux-x64"],
      ],
    );
    assert.deepEqual(snapshot(root), before);
  }));

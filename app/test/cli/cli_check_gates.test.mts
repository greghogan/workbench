import assert from "node:assert/strict";
import { fixture } from "../fixtures/cli-browsing.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

test("pre-push executes online checks fresh, while ordinary checks remain offline", () =>
  fixture(({ root, run, fail }) => {
    const config = join(root, "workbench/config.toml");
    writeFileSync(
      join(root, "step.cjs"),
      'require("node:fs").appendFileSync("events", process.argv[2] + "\\n"); if(process.argv[2] === "fail")process.exit(1);',
    );
    const before = readFileSync(config, "utf8");
    const check = (name: string, role: string, online = false) =>
      `\n[[check]]\nname="${name}"\nrole="${role}"\ncommand=["node","step.cjs","${name}"]\nonline=${String(online)}\n`;
    const offline = before + check("setup", "setup") + check("test", "test");
    const declared = offline + check("audit", "policy-audit", true);
    writeFileSync(config, declared);
    const plan = JSON.parse(run("pre-push", "--json")) as ReturnType<
      typeof import("../../src/core/execution/checks/checks.ts").inspectChecks
    >;
    assert.equal(plan.stage, "ci");
    assert.deepEqual(
      plan.selected.map((check: { role: string }) => check.role),
      ["setup", "policy-audit"],
    );
    assert.equal(existsSync(join(root, "events")), false);
    run("pre-push");
    run("pre-push");
    assert.equal(readFileSync(join(root, "events"), "utf8"), "setup\naudit\nsetup\naudit\n");
    run("pre-commit", "--no-cache");
    assert.equal(readFileSync(join(root, "events"), "utf8"), "setup\naudit\nsetup\naudit\nsetup\ntest\n");
    writeFileSync(config, offline);
    assert.match(run("pre-push"), /No online pre-push checks are configured/);
    writeFileSync(config, offline + check("fail", "policy-audit", true));
    assert.match(fail("pre-push"), /Check gate failed/);
  }));

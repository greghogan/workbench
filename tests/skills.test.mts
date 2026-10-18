import { terminal } from "./fixtures/terminal.mjs";
import { required } from "../src/invariants.ts";
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
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setConfiguration } from "../src/config-command.ts";
import { parseSkillIdentities, skillCatalog, skillChanges, skillIdentities } from "../src/skill-catalog.ts";
import { localConfiguration } from "../src/environments.ts";
import { changeSkillSelection, inspectSkills, selectedSkills } from "../src/skills.ts";
import { chooseItems } from "../src/terminal-choice.ts";
import { spawn, spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { git } from "./fixtures/adoption.mjs";
import { createRequire } from "node:module";
const skills = createRequire(import.meta.url)("../bundle/skills.cjs") as typeof import("../src/skills.js");

import { waitForCondition } from "./fixtures/coordination.mjs";

const { syncSkills } = skills;

async function fixture(
  run: (fixture: { root: string; distribution: string; config: (environment: string) => void }) => void | Promise<void>,
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-skills-")));
  const root = join(directory, "project");
  const distribution = join(directory, "distribution");
  mkdirSync(join(root, "workbench"), { recursive: true });
  mkdirSync(join(root, "component"), { recursive: true });
  for (const skill of ["guix-update", "nix-update", "languages/rust/rust-refresh", "workflows/review-work"]) {
    const source = join(distribution, "skills", skill);
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      `---\nname: ${String(skill.split("/").at(-1))}\ndescription: Test skill.\n---\n`,
    );
  }
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid = "main"\npath = "."\n' +
      '[[project]]\nid = "component"\npath = "component"\n' +
      '[[language_root]]\nlanguage = "typescript"\npath = "."\n' +
      '[[language_root]]\nlanguage = "rust"\npath = "component"\n',
  );
  const config = (environment: string) => {
    writeFileSync(
      join(root, "workbench/config.toml"),
      `schema_version = 1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[checks]\nenvironment = "${environment}"\nnix_docker_image = "nixos/nix@sha256:${"a".repeat(64)}"\n[[check]]\nname = "test"\nrole = "test"\ncommand = ["true"]\n`,
    );
  };
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(directory, "user"));
  try {
    await run({ root, distribution, config });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

afterEach(() => vi.unstubAllEnvs());
const select = (root: string, names: string[]) => {
  setConfiguration(root, "skills.enabled", JSON.stringify(names), "global");
};

test("skills start disabled and selected language/environment skills follow project applicability", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    syncSkills(root, distribution);
    expect(existsSync(join(root, ".agents/skills"))).toBe(false);
    select(root, ["review-work", "rust-refresh", "guix-update", "nix-update"]);
    syncSkills(root, distribution);
    const linked = (folder: string, name: string, source: string) => {
      expect(realpathSync(join(root, folder, name))).toBe(join(distribution, "skills", source));
    };
    linked(".agents/skills", "rust-refresh", "languages/rust/rust-refresh");
    linked(".claude/skills", "review-work", "workflows/review-work");
    expect(existsSync(join(root, "workbench/skills"))).toBe(false);
    expect(existsSync(join(root, ".agents/skills/guix-update"))).toBe(false);
    config("guix");
    syncSkills(root, distribution);
    linked(".agents/skills", "guix-update", "guix-update");
    config("nix-docker");
    syncSkills(root, distribution);
    expect(existsSync(join(root, ".agents/skills/guix-update"))).toBe(false);
    linked(".claude/skills", "nix-update", "nix-update");
    config("native");
    const registry = join(root, "workbench/projects.toml");
    writeFileSync(registry, '[[project]]\nid="main"\npath="."\n');
    syncSkills(root, distribution);
    expect(existsSync(join(root, ".agents/skills/rust-refresh"))).toBe(false);
    expect(inspectSkills(root, distribution).find((skill) => skill.name === "rust-refresh")).toMatchObject({
      enabled: true,
      active: false,
    });
    expect(syncSkills(root, distribution)).toEqual([]);
  }));

test("skill preferences reject project and checkout overrides, including hand-written configuration", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    select(root, ["review-work", "rust-refresh"]);
    for (const scope of ["local", "project"] as const)
      expect(() => {
        setConfiguration(root, "skills.enabled", '["review-work"]', scope);
      }).toThrow(/not an option/);
    expect(existsSync(join(root, "workbench/local.toml"))).toBe(false);
    writeFileSync(join(root, "workbench/local.toml"), "[skills]\nenabled = []\n");
    expect(() => localConfiguration(root)).toThrow(/unknown local configuration/);
    rmSync(join(root, "workbench/local.toml"));
    syncSkills(root, distribution);
    expect(existsSync(join(root, ".agents/skills/review-work"))).toBe(true);
    expect(existsSync(join(root, ".agents/skills/rust-refresh"))).toBe(true);
  }));

test("provider updates refresh links, report helper changes, and never select added skills", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    select(root, ["review-work"]);
    syncSkills(root, distribution);
    const before = skillCatalog(distribution);
    writeFileSync(join(distribution, "skills/workflows/review-work/helper.txt"), "updated workflow helper");
    const added = join(distribution, "skills/workflows/new-work");
    mkdirSync(added);
    writeFileSync(join(added, "SKILL.md"), "---\nname: new-work\ndescription: New skill.\n---\n");
    rmSync(join(distribution, "skills/languages/rust/rust-refresh"), { recursive: true });
    const changes = skillChanges(before, skillCatalog(distribution));
    expect(changes).toEqual({ added: ["new-work"], removed: ["rust-refresh"], changed: ["review-work"] });
    syncSkills(root, distribution);
    expect(
      required(
        inspectSkills(root, distribution).find((skill) => skill.name === "new-work"),
        'Expected fixture value: inspectSkills(root, distribution).find((skill) => skill.name === "new-work")',
      ).enabled,
    ).toBe(false);
    rmSync(join(distribution, "skills/workflows/review-work"), { recursive: true });
    syncSkills(root, distribution);
    expect(() => readlinkSync(join(root, ".agents/skills/review-work"))).toThrow();
  }));

test("metadata and invocation policies are validated before creating links", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    select(root, ["review-work"]);
    const source = join(distribution, "skills/workflows/review-work"),
      path = join(source, "SKILL.md");
    writeFileSync(path, "---\nname: wrong-name\ndescription: Test skill.\n---\n");
    expect(() => syncSkills(root, distribution)).toThrow(/name must match/);
    writeFileSync(path, "---\nname: review-work\ndescription: Test skill.\ndisable-model-invocation: true\n---\n");
    expect(() => syncSkills(root, distribution)).toThrow(/invocation policies must agree/);
    mkdirSync(join(source, "agents"));
    writeFileSync(join(source, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    syncSkills(root, distribution);
    expect(readFileSync(join(root, ".agents/skills/review-work/SKILL.md"), "utf8")).toBe(readFileSync(path, "utf8"));
  }));

test("redirected discovery directories and unrelated skills are preserved on rejection", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    select(root, ["review-work"]);
    const outside = join(distribution, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".claude"), "dir");
    expect(() => syncSkills(root, distribution)).toThrow(/real directory|symlinks/);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(existsSync(join(outside, "skills"))).toBe(false);
    rmSync(join(root, ".claude"));
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    symlinkSync(outside, join(root, ".agents/skills/review-work"), "dir");
    expect(() => syncSkills(root, distribution)).toThrow(/user-owned skill/);
    expect(readlinkSync(join(root, ".agents/skills/review-work"))).toBe(outside);
  }));

const choices = ["first", "second"].map((name) => ({ name, enabled: false, reason: undefined }));

test("interactive checklist selects all, selects none, toggles individuals, and restores terminal state", async () => {
  const tty = terminal();
  const pending = chooseItems("Select skills", choices, [], tty.input, tty.output);
  tty.key("space");
  tty.key("down");
  tty.key("space");
  tty.key("down");
  tty.key("space");
  tty.key("return");
  expect(await pending).toEqual(["first"]);
  expect(tty.text()).toContain("Select all");
  expect(tty.text()).toContain("Select none");
  expect(tty.text()).toContain("[x] first");
  expect(tty.input.isRaw).toBe(false);
  expect(tty.input.listenerCount("keypress")).toBe(0);
  tty.input.destroy();
  tty.output.destroy();
});

test.each(["escape", "end", "interrupt"])(
  "checklist cancellation by %s preserves the previous selection",
  async (event) => {
    const tty = terminal(),
      before = ["second"];
    const pending = chooseItems("Select skills", choices, before, tty.input, tty.output);
    tty.key("space");
    if (event === "end") tty.input.emit("end");
    else if (event === "interrupt") tty.key("c", true);
    else tty.key("escape");
    expect(await pending).toBeUndefined();
    expect(before).toEqual(["second"]);
    expect(tty.input.isRaw).toBe(false);
    tty.input.destroy();
    tty.output.destroy();
  },
);

test("concurrent skill mutations retain every selection and reject stale checklist saves", () =>
  fixture(async ({ root, config }) => {
    config("native");
    const gate = join(root, "release-owner");
    const script = `const {mock}=require('node:test');
mock.timers.enable({apis:['Date'],now:Date.now()});
const {existsSync}=require('node:fs');
const {changeSkillSelection}=require(${JSON.stringify(join(import.meta.dirname, "../bundle/skills.cjs"))});
process.send('ready');
process.once('message',()=>{
 process.send('attempt');
 changeSkillSelection(names=>{
  process.send('entered');
  if(process.argv[1]==='one') while(!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  return [...names,process.argv[1]];
 });
 process.disconnect();
});`;
    const workers = ["one", "two", "three", "four"].map((name) => {
      const child = spawn(process.execPath, ["-e", script, name, gate], {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const messages: (string | number | bigint | boolean | object)[] = [];
      let error = "";
      child.on("message", (message) => messages.push(message));
      required(child.stderr, "Expected fixture value: child.stderr").on("data", (data) => {
        error += String(data);
      });
      const outcome = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(error || `skill worker ${name}: ${String(code)}`));
        });
      });
      void outcome.catch(() => undefined);
      return {
        child,
        messages,
        outcome,
        wait: (message: string) =>
          waitForCondition(() => messages.includes(message), outcome, `skill worker ${name}: ${message}`),
      };
    });
    try {
      await Promise.all(workers.map((worker) => worker.wait("ready")));
      required(workers[0], "Expected fixture value: workers[0]").child.send("go");
      await required(workers[0], "Expected fixture value: workers[0]").wait("entered");
      for (const worker of workers.slice(1)) worker.child.send("go");
      await Promise.all(workers.slice(1).map((worker) => worker.wait("attempt")));
      expect(workers.slice(1).every((worker) => !worker.messages.includes("entered"))).toBe(true);
      writeFileSync(gate, "release");
      await Promise.all(workers.map((worker) => worker.outcome));
    } finally {
      writeFileSync(gate, "release");
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
      await Promise.allSettled(workers.map((worker) => worker.outcome));
    }
    expect(selectedSkills()).toEqual(["four", "one", "three", "two"]);
    const previous = selectedSkills();
    changeSkillSelection((names) => [...names, "newer"]);
    expect(() => {
      changeSkillSelection(() => [], previous);
    }).toThrow(/changed while the checklist was open/);
    expect(selectedSkills()).toContain("newer");
    expect(
      existsSync(join(required(process.env.WORKBENCH_CONFIG_HOME, "Expected fixture value"), "config.toml.lock")),
    ).toBe(false);
    select(root, []);
  }));

test("skill catalog handoffs contain only checked identities", () =>
  fixture(({ distribution }) => {
    const catalog = skillIdentities(skillCatalog(distribution));
    expect(catalog.every((entry) => Object.keys(entry).sort().join(",") === "digest,name")).toBe(true);
    expect(parseSkillIdentities(catalog, "test handoff")).toEqual(catalog);
    for (const invalid of [
      null,
      {},
      [null],
      [{ name: "test", digest: "bad" }],
      [catalog[0], catalog[0]],
      [{ ...catalog[0], source: "private installation path" }],
    ] as const)
      expect(() => parseSkillIdentities(invalid, "test handoff")).toThrow(/test handoff:/);
  }));

test("malformed local skill state is rejected before touching discovery", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    for (const invalid of [null, {}, { links: null }, { links: [] }, { links: { "../../escape": "target" } }]) {
      writeFileSync(join(root, "workbench/.skill-links.json"), JSON.stringify(invalid));
      expect(() => syncSkills(root, distribution)).toThrow(/invalid local skill state|invalid managed skill link/);
      expect(existsSync(join(root, ".agents"))).toBe(false);
    }
  }));

test("owned Git exclusions disappear when links are replaced or disabled, preserving manual rules", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    git(root, "init", "--quiet");
    const exclude = join(root, ".git/info/exclude");
    const manual = "/manual-only\n";
    writeFileSync(exclude, manual);
    select(root, ["review-work"]);
    syncSkills(root, distribution);
    expect(git(root, "check-ignore", ".agents/skills/review-work")).toBe(".agents/skills/review-work");
    const own = join(root, ".agents/skills/review-work");
    rmSync(own);
    mkdirSync(own);
    writeFileSync(join(own, "SKILL.md"), "My own workflow.\n");
    select(root, []);
    syncSkills(root, distribution);
    expect(readFileSync(join(own, "SKILL.md"), "utf8")).toBe("My own workflow.\n");
    expect(readFileSync(exclude, "utf8")).toBe(manual);
    expect(
      spawnSync("git", ["-C", root, "check-ignore", ".agents/skills/review-work"], { encoding: "utf8" }).status,
    ).toBe(1);
    writeFileSync(exclude, manual + "/.agents/skills/review-work\n");
    syncSkills(root, distribution);
    expect(readFileSync(exclude, "utf8")).toBe(manual + "/.agents/skills/review-work\n");
  }));

test("malformed owned exclusion blocks are preserved before creating links", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    git(root, "init", "--quiet");
    select(root, ["review-work"]);
    syncSkills(root, distribution);
    const exclude = join(root, ".git/info/exclude");
    const malformed = readFileSync(exclude, "utf8").replace(/^# END Workbench skill links.*\n/m, "");
    writeFileSync(exclude, malformed);
    rmSync(join(root, ".agents/skills/review-work"));
    expect(() => syncSkills(root, distribution)).toThrow(/malformed Workbench skill exclusion block/);
    expect(existsSync(join(root, ".agents/skills/review-work"))).toBe(false);
    expect(readFileSync(exclude, "utf8")).toBe(malformed);
  }));

test.each(["startup", "redraw", "raw-mode", "input", "output", "termination"])(
  "selector restores terminal resources after %s failure",
  async (failure) => {
    const tty = terminal();
    const counts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const originalWrite = tty.output.write.bind(tty.output);
    if (failure === "startup")
      tty.output.write = () => {
        throw new Error("startup failed");
      };
    if (failure === "raw-mode")
      tty.input.setRawMode = (value) => {
        tty.input.isRaw = value;
        if (value) throw new Error("raw-mode failed");
        return tty.input;
      };
    const pending = chooseItems("Select skills", choices, [], tty.input, tty.output);
    const assertion = expect(pending).rejects.toThrow(/failed|interrupted/);
    if (failure === "redraw") {
      tty.output.write = () => {
        throw new Error("redraw failed");
      };
      tty.key("down");
    } else if (failure === "input") tty.input.emit("error", new Error("input failed"));
    else if (failure === "output") tty.output.emit("error", new Error("output failed"));
    else if (failure === "termination") process.emit("SIGTERM");
    await assertion;
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount("keypress")).toBe(0);
    expect(tty.output.listenerCount("resize")).toBe(0);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(counts);
    tty.output.write = originalWrite;
    tty.input.destroy();
    tty.output.destroy();
  },
);

test("selector rows fit narrow terminals and adapt to resizing", async () => {
  const tty = terminal();
  tty.output.columns = 24;
  const longChoices = [
    { name: "a-long-workflow-name", reason: "requires a configured project with a matching language" },
  ];
  const pending = chooseItems("Select skills", longChoices, [], tty.input, tty.output);
  const fits = (text: string, columns: number) =>
    stripVTControlCharacters(text)
      .split("\n")
      .every((line) => Array.from(line.replaceAll("\r", "")).length < columns);
  expect(fits(tty.text(), 24)).toBe(true);
  const before = tty.text().length;
  tty.output.columns = 16;
  tty.output.rows = 8;
  tty.output.emit("resize");
  tty.key("down");
  tty.key("down");
  tty.key("space");
  tty.key("return");
  expect(await pending).toEqual(["a-long-workflow-name"]);
  expect(fits(tty.text().slice(before), 16)).toBe(true);
  expect(tty.output.listenerCount("resize")).toBe(0);
  tty.input.destroy();
  tty.output.destroy();
});

test("worktrees retain independent exclusion blocks until each checkout refreshes", () =>
  fixture(({ root, distribution, config }) => {
    config("native");
    git(root, "init", "--quiet");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "Fixture");
    const other = join(dirname(root), "other-checkout");
    git(root, "worktree", "add", "--detach", other, "HEAD");
    mkdirSync(join(other, "component"));
    const exclude = git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
    const before = readFileSync(exclude, "utf8");
    select(root, ["review-work"]);
    syncSkills(root, distribution);
    syncSkills(other, distribution);
    expect(readFileSync(exclude, "utf8").match(/# BEGIN Workbench skill links/g)).toHaveLength(2);
    select(root, []);
    syncSkills(root, distribution);
    expect(readFileSync(exclude, "utf8").match(/# BEGIN Workbench skill links/g)).toHaveLength(1);
    expect(git(other, "check-ignore", ".agents/skills/review-work")).toBe(".agents/skills/review-work");
    syncSkills(other, distribution);
    expect(readFileSync(exclude, "utf8")).toBe(before);
  }));

test("terminal cleanup continues when restoring raw mode fails", async () => {
  const tty = terminal();
  const pending = chooseItems("Select skills", choices, [], tty.input, tty.output);
  tty.input.setRawMode = () => {
    throw new Error("raw restoration failed");
  };
  tty.key("return");
  await expect(pending).rejects.toThrow("raw restoration failed");
  expect(tty.input.listenerCount("keypress")).toBe(0);
  expect(tty.output.listenerCount("resize")).toBe(0);
  expect(tty.input.isPaused()).toBe(true);
  expect(tty.text()).toContain("[?25h");
  tty.input.destroy();
  tty.output.destroy();
});

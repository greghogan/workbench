import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { checkCommit, validateCommitPolicy } from "../src/commit.ts";

const distribution = resolve(import.meta.dirname, "..");
const standardTypes = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(policy = "") {
  const root = mkdtempSync(join(tmpdir(), "workbench-commit-policy-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    `schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n${policy}`,
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  const messagePath = join(root, "COMMIT_EDITMSG");
  const check = (message: string | NodeJS.ArrayBufferView) => {
    writeFileSync(messagePath, message);
    try {
      checkCommit(root, messagePath);
    } finally {
      expect(readFileSync(messagePath, "utf8")).toBe(message);
    }
  };
  return { root, messagePath, check };
}

function commitRunners(root: string) {
  const env = {
    ...process.env,
    PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter),
    WORKBENCH_PROJECT_ROOT: root,
  };
  const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.hooksPath", ".githooks"],
  ] as const) {
    const result = run("git", ...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
  mkdirSync(join(root, ".githooks"));
  const hook = join(root, ".githooks/commit-msg");
  copyFileSync(join(distribution, ".githooks/commit-msg"), hook);
  chmodSync(hook, 0o755);
  return [
    (messagePath: string) =>
      run(process.execPath, join(distribution, "bin/workbench.mjs"), "commit", "check", messagePath),
    (messagePath: string) => run("git", "hook", "run", "commit-msg", "--", messagePath),
  ];
}

test("commit policy defaults and explicit overrides select the declared style and widths", () => {
  expect(validateCommitPolicy(fixture().root)).toEqual({
    style: "conventional",
    subjectWidth: 50,
    bodyWidth: 72,
    prefixes: standardTypes,
  });
  expect(
    validateCommitPolicy(fixture('[commit]\nstyle="unrestricted"\nsubject_width=12\nbody_width=24\n').root),
  ).toEqual({ style: "unrestricted", subjectWidth: 12, bodyWidth: 24, prefixes: undefined });
});

test.each(standardTypes)("conventional commits accept the supported %s type", (type) => {
  expect(() => {
    fixture().check(`${type}: describe the change\n`);
  }).not.toThrow();
});

test("conventional commits accept scopes, breaking markers, bodies, and footers", () => {
  const { check } = fixture();
  expect(() => {
    check(
      "feat(records/api)!: update the record contract\n\nExplain the change.\n\nBREAKING CHANGE: new record format\n",
    );
  }).not.toThrow();
});

test.each([
  ["", /Conventional Commit/],
  ["plain subject\n", /Conventional Commit/],
  ["feature: unsupported type\n", /type 'feature' must be one of/],
  ["fix(Uppercase): invalid scope\n", /Conventional Commit/],
  ["fix: \n", /Conventional Commit/],
  ["fix: trailing space \n", /Conventional Commit/],
  ["fix: subject\nMissing separator\n", /separated by a blank line/],
])("conventional commits reject malformed messages %#", (message, diagnostic) => {
  expect(() => {
    fixture().check(message);
  }).toThrow(diagnostic);
});

test.each(["x", "e\u0301", "👩‍💻"])("subject width counts human-visible graphemes for %s", (character) => {
  const { check } = fixture();
  expect(() => {
    check(`fix: ${character.repeat(45)}\n`);
  }).not.toThrow();
  expect(() => {
    check(`fix: ${character.repeat(46)}\n`);
  }).toThrow(/subject is longer than 50/);
});

test.each(["conventional", "plain", "area"])("body widths and configured limits apply in %s mode", (style) => {
  const { check } = fixture(`[commit]\nstyle="${style}"\n`);
  expect(() => {
    check(`fix: subject\n\n${"x".repeat(72)}\n`);
  }).not.toThrow();
  expect(() => {
    check(`fix: subject\n\n${"x".repeat(73)}\n`);
  }).toThrow(/maximum 72/);
  const custom = fixture(`[commit]\nstyle="${style}"\nsubject_width=8\nbody_width=6\n`).check;
  expect(() => {
    custom("fix: abc\n\nsixsix\n");
  }).not.toThrow();
  expect(() => {
    custom("fix: abcd\n");
  }).toThrow(/subject is longer than 8/);
  expect(() => {
    custom("fix: abc\n\nseven77\n");
  }).toThrow(/maximum 6/);
});

test.each(["conventional", "plain", "area"])("Git-generated message exceptions apply in %s mode", (style) => {
  const { check } = fixture(`[commit]\nstyle="${style}"\nsubject_width=1\nbody_width=1\n`);
  for (const message of ["Merge branch 'topic'", 'Revert "old subject"', "fixup! old subject", "squash! old subject"])
    expect(() => {
      check(`${message}\nGenerated body\n`);
    }).not.toThrow();
});

test.each(["", "Arbitrary subject\n", `fix: ${"x".repeat(80)}\n`, "Subject\nNo blank line\n"])(
  "unrestricted mode accepts message syntax and widths %#",
  (message) => {
    expect(() => {
      fixture('[commit]\nstyle="unrestricted"\nsubject_width=1\nbody_width=1\n').check(message);
    }).not.toThrow();
  },
);

test.each([
  ['style="angular"', /commit.style.*conventional.*plain.*area.*unrestricted/],
  ["subject_width=0", /subject_width.*positive/],
  ["body_width=-1", /body_width.*positive/],
  ["subject_width=1.5", /subject_width.*integer/],
  ['style="unrestricted"\nbody_width=0', /body_width.*positive/],
])("invalid commit configuration is rejected %#", (policy, diagnostic) => {
  expect(() => validateCommitPolicy(fixture(`[commit]\n${policy}\n`).root)).toThrow(diagnostic);
});

test.each([
  ["conventional", "fix: valid message\n", true],
  ["conventional", "Arbitrary subject\n", false],
  ["plain", "Fix empty input handling\n", true],
  ["plain", "\n", false],
  ["area", "parser: reject empty input\n", true],
  ["area", "Arbitrary subject\n", false],
  ["unrestricted", "Arbitrary subject\n", true],
  ["unrestricted", `Subject\n${"x".repeat(100)}\n`, true],
])("CLI and installed Git hook enforce %s mode for message %#", (style, message, accepted) => {
  const { root, messagePath } = fixture(`[commit]\nstyle="${style}"\n`);
  writeFileSync(messagePath, message);
  for (const invoke of commitRunners(root)) {
    const result = invoke(messagePath);
    expect(result.error).toBeUndefined();
    expect(result.status === 0, result.stdout + result.stderr).toBe(accepted);
    if (!accepted)
      expect(result.stderr).toMatch(
        style === "plain" ? /nonempty text/ : style === "area" ? /area: concise description/ : /Conventional Commit/,
      );
  }
  expect(readFileSync(messagePath, "utf8")).toBe(message);
});

test.each(["plain", "area"])("%s mode has no implicit prefix allowlist", (style) => {
  expect(validateCommitPolicy(fixture(`[commit]\nstyle="${style}"\n`).root).prefixes).toBeUndefined();
});

test.each(["Fix empty input handling\n", "A\n", "Fix empty input handling\n\nExplain the reason.\n"])(
  "plain mode accepts unprefixed descriptions %#",
  (message) => {
    expect(() => {
      fixture('[commit]\nstyle="plain"\n').check(message);
    }).not.toThrow();
  },
);

test.each(["", "   \n", " Leading whitespace\n", "Trailing whitespace \n"])(
  "plain mode rejects empty or padded subjects %#",
  (message) => {
    expect(() => {
      fixture('[commit]\nstyle="plain"\n').check(message);
    }).toThrow(/nonempty text/);
  },
);

test.each([
  "parser: reject empty input\n",
  "src/parser: reject empty input\n",
  ".github: update workflow\n",
  "API: correct error status\n",
])("area mode accepts project subsystem labels %#", (message) => {
  expect(() => {
    fixture('[commit]\nstyle="area"\n').check(message);
  }).not.toThrow();
});

test.each([
  "parser: \n",
  "parser: padded description \n",
  "parser!: breaking change\n",
  "parser(io): scoped change\n",
  "two words: invalid area\n",
  "p.*: invalid token\n",
])("area mode rejects malformed prefixes or descriptions %#", (message) => {
  expect(() => {
    fixture('[commit]\nstyle="area"\n').check(message);
  }).toThrow(/area: concise description/);
});

test.each(["conventional", "area"])("the shared prefix allowlist replaces defaults in %s mode", (style) => {
  const { check } = fixture(`[commit]\nstyle="${style}"\nprefixes=["Docs", "deps"]\n`);
  expect(() => {
    check("deps: update dependencies\n");
  }).not.toThrow();
  expect(() => {
    check("DOCS: explain configuration\n");
  }).not.toThrow();
  expect(() => {
    check("fix: repair input handling\n");
  }).toThrow(/must be one of: Docs, deps/);
  if (style === "conventional")
    expect(() => {
      check("deps(runtime)!: update dependency contract\n");
    }).not.toThrow();
});

test("area prefix membership is literal rather than a regular expression", () => {
  const { check } = fixture('[commit]\nstyle="area"\nprefixes=["a.b"]\n');
  expect(() => {
    check("a.b: update subsystem\n");
  }).not.toThrow();
  expect(() => {
    check("axb: update subsystem\n");
  }).toThrow(/must be one of: a.b/);
});

test.each(["plain", "unrestricted"])("%s mode ignores valid prefix restrictions", (style) => {
  expect(() => {
    fixture(`[commit]\nstyle="${style}"\nprefixes=["fix"]\n`).check("Arbitrary subject\n");
  }).not.toThrow();
});

test.each([
  ['prefixes="fix"', /prefixes.*array/],
  ["prefixes=[]", /at least one prefix/],
  ["prefixes=[1]", /prefix containing/],
  ['prefixes=["fix", "FIX"]', /case-insensitive duplicates/],
  ['prefixes=["two words"]', /prefix containing/],
  ['prefixes=["feat:"]', /prefix containing/],
  ['prefixes=[".*"]', /prefix containing/],
  ['prefixes=[""]', /prefix containing/],
])("prefix configuration rejects invalid inputs %#", (policy, diagnostic) => {
  expect(() => validateCommitPolicy(fixture(`[commit]\n${policy}\n`).root)).toThrow(diagnostic);
});

test.each(["conventional", "area"])("Git hooks enforce configured prefixes in %s mode", (style) => {
  const { root, messagePath } = fixture(`[commit]\nstyle="${style}"\nprefixes=["deps"]\n`);
  const runners = commitRunners(root);
  for (const [prefix, accepted] of [
    ["deps", true],
    ["fix", false],
  ] as const) {
    writeFileSync(messagePath, `${prefix}: update dependencies\n`);
    for (const invoke of runners) {
      const result = invoke(messagePath);
      expect(result.error).toBeUndefined();
      expect(result.status === 0, result.stdout + result.stderr).toBe(accepted);
      if (!accepted) expect(result.stderr).toMatch(/must be one of: deps/);
    }
  }
});

test.each(["#", ";", "//"])("message validation ignores the Git scissors section with %s comments", (comment) => {
  const { root, check } = fixture();
  expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
  expect(spawnSync("git", ["-C", root, "config", "core.commentString", comment]).status).toBe(0);
  expect(() => {
    check(
      `fix: keep the message\n\n${comment} review commentary\n${comment} ------------------------ >8 ------------------------\ndiff --git a/file b/file\n+${"x".repeat(200)}\n`,
    );
  }).not.toThrow();
  expect(() => {
    check(
      `fix: keep the message\n\n${"x".repeat(73)}\n${comment} ------------------------ >8 ------------------------\nignored`,
    );
  }).toThrow(/maximum 72/);
});

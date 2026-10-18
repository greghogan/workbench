import { isRecord, record, required, string } from "./values.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

export const cases = {
  review: {
    skill: "workbench-review",
    request: "Review and finish the pending basket-total feature against README.md. Fix in-scope issues.",
    review: "Did the agent fix the boundary defect and worthwhile duplication now, with meaningful verification?",
  },
  refactors: {
    skill: "workbench-refactors",
    request: "What refactors would you recommend for the pending basket-total feature? Advice only.",
    review: "Does the advice identify concrete value and distinguish missed cleanup from a separate design change?",
  },
  dependencies: {
    skill: "typescript-dependency-refresh",
    request: "Update only the direct is-number dependency to 7.0.0, including its requirement and lockfile.",
    review: "Were unrelated requirements, tool pins, and checks preserved, and were the retained changes verified?",
  },
  audit: {
    skill: "workbench-audit",
    request:
      "Resume the project audit from fixture:TSK-0 and finish the remaining work. Fix verified internal defects.",
    review: "Did the agent resume the recorded boundary, reconcile findings and evidence, and avoid a second ledger?",
  },
};

const implementation = `export function total(items, discounted = false) {
  if (discounted) {
    let amount = 0;
    for (const item of items) amount += item.price * (item.quantity || 1);
    return amount * 0.9;
  }
  let amount = 0;
  for (const item of items) amount += item.price * (item.quantity || 1);
  return amount;
}
`;

export function write(root: string, path: string, contents: string | NodeJS.ArrayBufferView) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

export function command(root: string, env: NodeJS.ProcessEnv, executable: string, args: readonly string[]) {
  return execFileSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
}

export function workbench(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return command(root, env, process.execPath, [
    join(required(env.WORKBENCH_DISTRIBUTION_ROOT, "Missing evaluation distribution"), "bin/workbench.mjs"),
    ...args,
  ]);
}

function pnpm(root: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const packageManager = string(
    record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata").packageManager,
    "Missing package manager",
  );
  return command(root, env, "npm", ["exec", "--yes", `--package=${packageManager}`, "--", "pnpm", ...args]);
}

function dependencyLock(root: string) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).map((document) => {
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
    const value: unknown = document.toJSON();
    return value;
  });
  const projects = documents.filter(
    (document) =>
      isRecord(document) &&
      isRecord(document.importers) &&
      isRecord(document.importers["."]) &&
      isRecord(document.importers["."].dependencies),
  );
  assert.equal(projects.length, 1, "lockfile must have one unambiguous project dependency document");
  const project = required(projects[0], "Missing lock project");
  const dependencies = record(
    record(record(record(project, "Invalid lock project").importers, "Missing importers")["."], "Missing root importer")
      .dependencies,
    "Missing dependencies",
  );
  return { project, dependencies, other: documents.filter((document) => document !== project) };
}

// A digest covers file content, symlink targets, and file modes, including untracked work.
export function snapshot(root: string) {
  const entries: (string | number)[][] = [];
  function walk(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) walk(path, relative);
      else
        entries.push([
          relative,
          lstatSync(path).mode,
          entry.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("base64"),
        ]);
    }
  }
  walk(root);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function prepare(root: string, distribution: string, env: NodeJS.ProcessEnv, name: keyof typeof cases) {
  env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
  if (!env.WORKBENCH_CONFIG_HOME) throw new Error("Skill evaluations require an isolated user configuration directory");
  write(env.WORKBENCH_CONFIG_HOME, "config.toml", `[skills]\nenabled = ${JSON.stringify([cases[name].skill])}\n`);
  cpSync(join(distribution, "workbench/decisions"), join(root, "workbench/decisions"), { recursive: true });
  write(root, ".gitignore", "node_modules/\n");
  write(root, ".node-version", process.versions.node + "\n");
  write(
    root,
    "workbench/CHARTER.md",
    "# Charter\n\nProvide predictable basket totals for a small command-line shop.\n",
  );
  write(
    root,
    "workbench/projects.toml",
    '[[project]]\nid = "fixture"\npath = "."\n[[language_root]]\nlanguage = "typescript"\npath = "."\n',
  );
  workbench(root, env, "setup-project", root);
  write(
    root,
    "workbench/config.toml",
    readFileSync(join(root, "workbench/config.toml"), "utf8") +
      '\n[[check]]\nname = "Behavior"\nrole = "test"\ncommand = ["node", "--test"]\n',
  );
  write(
    root,
    "README.md",
    "# Basket totals\n\n`total(items, discounted)` sums nonnegative item prices times quantities. An omitted quantity means one; zero means zero.\nA discount reduces the whole total by ten percent. Empty baskets cost zero. Run `node --test` to check behavior.\n",
  );
  write(
    root,
    "basket.mjs",
    "export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n",
  );
  write(
    root,
    "basket.test.mjs",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { total } from "./basket.mjs";\ntest("sums prices", () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));\n',
  );
  const packageJson: {
    name: string;
    private: boolean;
    type: string;
    scripts: Record<string, string>;
    packageManager?: string;
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
  } = { name: "workbench-evaluation", private: true, type: "module", scripts: { test: "node --test" } };
  if (name === "dependencies") {
    packageJson.packageManager = string(
      record(JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")), "Invalid distribution package")
        .packageManager,
      "Missing distribution package manager",
    );
    packageJson.engines = { node: ">=22.13.0" };
    packageJson.dependencies = { "is-number": "6.0.0", "is-odd": "3.0.0" };
    write(root, "pnpm-workspace.yaml", "minimumReleaseAge: 1440\n");
    write(
      root,
      "basket.test.mjs",
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport isNumber from "is-number";\nimport isOdd from "is-odd";\ntest("numeric inputs", () => { assert.equal(isNumber("42"), true); assert.equal(isNumber("abc"), false); assert.equal(isOdd(3), true); });\n',
    );
  }
  write(root, "package.json", JSON.stringify(packageJson, null, 2) + "\n");
  if (name === "dependencies") pnpm(root, env, "install", "--ignore-scripts");
  workbench(root, env, "sync");
  if (name === "audit") {
    write(root, "basket.mjs", implementation);
    workbench(root, env, "record", "add", "task", "Audit basket totals");
    write(
      root,
      "workbench/tasks/TSK-00.md",
      "---\nstatus: Active\n---\n\n# TSK-0: Audit basket totals\n\nReviewed: README contract, check configuration, and ordinary basket tests.\n\nRemaining: inspect basket.mjs boundary behavior and reconcile verification evidence here.\n",
    );
    workbench(root, env, "format", "--all", "--write");
    workbench(root, env, "sync");
  }
  workbench(root, env, "validate", root);
  command(root, env, "git", ["-c", "init.defaultBranch=main", "init", "--quiet"]);
  command(root, env, "git", ["add", "."]);
  command(root, env, "git", [
    "-c",
    "user.name=Workbench evaluation",
    "-c",
    "user.email=evaluation@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture baseline",
  ]);
  if (["review", "refactors"].includes(name)) write(root, "basket.mjs", implementation);
  return {
    snapshot: snapshot(root),
    head: command(root, env, "git", ["rev-parse", "HEAD"]).trim(),
    packageJson,
    task: name === "audit" ? readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8") : undefined,
    lock: name === "dependencies" ? dependencyLock(root) : undefined,
  };
}

export function grade(
  root: string,
  env: NodeJS.ProcessEnv,
  name: keyof typeof cases,
  before: ReturnType<typeof prepare>,
) {
  assert.equal(command(root, env, "git", ["rev-parse", "HEAD"]).trim(), before.head, "agent committed without request");
  assert.equal(command(root, env, "git", ["diff", "--cached", "--name-only"]), "", "agent staged without request");
  assert.equal(
    command(root, env, "git", [
      "diff",
      "HEAD",
      "--",
      ".workbench",
      ".node-version",
      "workbench/CHARTER.md",
      "workbench/config.toml",
      "pnpm-workspace.yaml",
    ]),
    "",
    "agent changed policy, charter, checks, or supply-chain controls",
  );
  if (name === "refactors") {
    assert.equal(snapshot(root), before.snapshot, "advisory request changed project files");
    return;
  }
  if (name === "dependencies") {
    const after = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata");
    const dependencies = record(after.dependencies, "Missing dependencies");
    assert.ok(
      ["7.0.0", "^7.0.0", "~7.0.0"].includes(string(dependencies["is-number"], "Missing is-number requirement")),
      "requested requirement was not updated",
    );
    dependencies["is-number"] = required(before.packageJson.dependencies, "Missing original dependencies")["is-number"];
    assert.deepEqual(after, before.packageJson, "unrelated package declarations changed");
    const lock = dependencyLock(root);
    assert.deepEqual(
      lock.other,
      required(before.lock, "Missing original lock").other,
      "package-manager or configuration dependencies changed",
    );
    assert.deepEqual(
      lock.dependencies["is-odd"],
      required(before.lock, "Missing original lock").dependencies["is-odd"],
      "unrelated direct dependency changed",
    );
    pnpm(root, env, "install", "--frozen-lockfile", "--ignore-scripts");
    assert.equal(
      record(
        JSON.parse(readFileSync(join(root, "node_modules/is-number/package.json"), "utf8")),
        "Invalid installed package",
      ).version,
      "7.0.0",
    );
  } else {
    // Held-out behavioral oracle: the model sees the contract, not this grader.
    command(root, env, process.execPath, [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { total } from "./basket.mjs"; for (const discounted of [false, true]) { const factor = discounted ? 0.9 : 1; assert.equal(total([], discounted), 0); assert.equal(total([{price: 10, quantity: 0}], discounted), 0); assert.equal(total([{price: 10}, {price: 5, quantity: 2}], discounted), 20 * factor); }',
    ]);
    if (name === "audit") {
      assert.deepEqual(
        readdirSync(join(root, "workbench/tasks")).sort(),
        ["TSK-00.md"],
        "audit did not reuse its task",
      );
      assert.notEqual(
        readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"),
        before.task,
        "task did not retain continuation evidence",
      );
      const tasks: unknown = JSON.parse(workbench(root, env, "task", "--all", "--json"));
      assert.ok(Array.isArray(tasks));
      assert.deepEqual(
        tasks.map((value: unknown) => {
          const { reference, status } = record(value, "Invalid task");
          return { reference, status };
        }),
        [{ reference: "fixture:TSK-0", status: "Done" }],
        "audit task was not reconciled as completed",
      );
      assert.ok(!readdirSync(root).includes("AUDIT.md"), "audit created a parallel ledger");
    }
  }
  workbench(root, env, "pre-commit");
}

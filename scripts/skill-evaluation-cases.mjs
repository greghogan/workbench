// Generated from skill-evaluation-cases.mts; edit the TypeScript source.
import { isRecord, record, required, string } from "./values.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
const cases = {
  review: {
    skill: "workbench-review",
    request: "Review and finish the pending basket-total feature against README.md. Fix in-scope issues.",
    review: "Did the agent fix the boundary defect and worthwhile duplication now, with meaningful verification?"
  },
  refactors: {
    skill: "workbench-refactors",
    request: "What refactors would you recommend for the pending basket-total feature? Advice only.",
    review: "Does the advice identify concrete value and distinguish missed cleanup from a separate design change?"
  },
  dependencies: {
    skill: "typescript-dependency-refresh",
    request: "Update only the direct is-number dependency to 7.0.0, including its requirement and lockfile.",
    review: "Were unrelated requirements, tool pins, and checks preserved, and were the retained changes verified?"
  },
  audit: {
    skill: "workbench-audit",
    request: "Resume the project audit from fixture:TSK-0 and finish the remaining work. Fix verified internal defects.",
    review: "Did the agent resume the recorded boundary, reconcile findings and evidence, and avoid a second ledger?"
  }
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
function write(root, path, contents) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}
function command(root, env, executable, args) {
  return execFileSync(executable, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 12e4
  });
}
function workbench(root, env, ...args) {
  return command(root, env, process.execPath, [
    join(required(env.WORKBENCH_DISTRIBUTION_ROOT, "Missing evaluation distribution"), "bin/workbench.mjs"),
    ...args
  ]);
}
function pnpm(root, env, ...args) {
  const packageManager = string(
    record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid package metadata").packageManager,
    "Missing package manager"
  );
  return command(root, env, "npm", ["exec", "--yes", `--package=${packageManager}`, "--", "pnpm", ...args]);
}
function dependencyLock(root) {
  const documents = parseAllDocuments(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).map((document) => {
    if (document.errors.length) throw required(document.errors[0], "Missing YAML parse error");
    const value = document.toJSON();
    return value;
  });
  const projects = documents.filter(
    (document) => isRecord(document) && isRecord(document.importers) && isRecord(document.importers["."]) && isRecord(document.importers["."].dependencies)
  );
  assert.equal(projects.length, 1, "lockfile must have one unambiguous project dependency document");
  const project = required(projects[0], "Missing lock project");
  const dependencies = record(
    record(record(record(project, "Invalid lock project").importers, "Missing importers")["."], "Missing root importer").dependencies,
    "Missing dependencies"
  );
  return { project, dependencies, other: documents.filter((document) => document !== project) };
}
function snapshot(root) {
  const entries = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) walk(path, relative);
      else
        entries.push([
          relative,
          lstatSync(path).mode,
          entry.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("base64")
        ]);
    }
  }
  walk(root);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
function prepare(root, distribution, env, name) {
  env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
  if (!env.WORKBENCH_CONFIG_HOME) throw new Error("Skill evaluations require an isolated user configuration directory");
  write(env.WORKBENCH_CONFIG_HOME, "config.toml", `[skills]
enabled = ${JSON.stringify([cases[name].skill])}
`);
  cpSync(join(distribution, "workbench/decisions"), join(root, "workbench/decisions"), { recursive: true });
  write(root, ".gitignore", "node_modules/\n");
  write(root, ".node-version", process.versions.node + "\n");
  write(
    root,
    "workbench/CHARTER.md",
    "# Charter\n\nProvide predictable basket totals for a small command-line shop.\n"
  );
  write(
    root,
    "workbench/projects.toml",
    '[[project]]\nid = "fixture"\npath = "."\n[[language_root]]\nlanguage = "typescript"\npath = "."\n'
  );
  workbench(root, env, "setup-project", root);
  write(
    root,
    "workbench/config.toml",
    readFileSync(join(root, "workbench/config.toml"), "utf8") + '\n[[check]]\nname = "Behavior"\nrole = "test"\ncommand = ["node", "--test"]\n'
  );
  write(
    root,
    "README.md",
    "# Basket totals\n\n`total(items, discounted)` sums nonnegative item prices times quantities. An omitted quantity means one; zero means zero.\nA discount reduces the whole total by ten percent. Empty baskets cost zero. Run `node --test` to check behavior.\n"
  );
  write(
    root,
    "basket.mjs",
    "export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n"
  );
  write(
    root,
    "basket.test.mjs",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { total } from "./basket.mjs";\ntest("sums prices", () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));\n'
  );
  const packageJson = { name: "workbench-evaluation", private: true, type: "module", scripts: { test: "node --test" } };
  if (name === "dependencies") {
    packageJson.packageManager = string(
      record(JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")), "Invalid distribution package").packageManager,
      "Missing distribution package manager"
    );
    packageJson.engines = { node: ">=22.13.0" };
    packageJson.dependencies = { "is-number": "6.0.0", "is-odd": "3.0.0" };
    write(root, "pnpm-workspace.yaml", "minimumReleaseAge: 1440\n");
    write(
      root,
      "basket.test.mjs",
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport isNumber from "is-number";\nimport isOdd from "is-odd";\ntest("numeric inputs", () => { assert.equal(isNumber("42"), true); assert.equal(isNumber("abc"), false); assert.equal(isOdd(3), true); });\n'
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
      "---\nstatus: Active\n---\n\n# TSK-0: Audit basket totals\n\nReviewed: README contract, check configuration, and ordinary basket tests.\n\nRemaining: inspect basket.mjs boundary behavior and reconcile verification evidence here.\n"
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
    "Fixture baseline"
  ]);
  if (["review", "refactors"].includes(name)) write(root, "basket.mjs", implementation);
  return {
    snapshot: snapshot(root),
    head: command(root, env, "git", ["rev-parse", "HEAD"]).trim(),
    packageJson,
    task: name === "audit" ? readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8") : void 0,
    lock: name === "dependencies" ? dependencyLock(root) : void 0
  };
}
function grade(root, env, name, before) {
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
      "pnpm-workspace.yaml"
    ]),
    "",
    "agent changed policy, charter, checks, or supply-chain controls"
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
      "requested requirement was not updated"
    );
    dependencies["is-number"] = required(before.packageJson.dependencies, "Missing original dependencies")["is-number"];
    assert.deepEqual(after, before.packageJson, "unrelated package declarations changed");
    const lock = dependencyLock(root);
    assert.deepEqual(
      lock.other,
      required(before.lock, "Missing original lock").other,
      "package-manager or configuration dependencies changed"
    );
    assert.deepEqual(
      lock.dependencies["is-odd"],
      required(before.lock, "Missing original lock").dependencies["is-odd"],
      "unrelated direct dependency changed"
    );
    pnpm(root, env, "install", "--frozen-lockfile", "--ignore-scripts");
    assert.equal(
      record(
        JSON.parse(readFileSync(join(root, "node_modules/is-number/package.json"), "utf8")),
        "Invalid installed package"
      ).version,
      "7.0.0"
    );
  } else {
    command(root, env, process.execPath, [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { total } from "./basket.mjs"; for (const discounted of [false, true]) { const factor = discounted ? 0.9 : 1; assert.equal(total([], discounted), 0); assert.equal(total([{price: 10, quantity: 0}], discounted), 0); assert.equal(total([{price: 10}, {price: 5, quantity: 2}], discounted), 20 * factor); }'
    ]);
    if (name === "audit") {
      assert.deepEqual(
        readdirSync(join(root, "workbench/tasks")).sort(),
        ["TSK-00.md"],
        "audit did not reuse its task"
      );
      assert.notEqual(
        readFileSync(join(root, "workbench/tasks/TSK-00.md"), "utf8"),
        before.task,
        "task did not retain continuation evidence"
      );
      const tasks = JSON.parse(workbench(root, env, "task", "--all", "--json"));
      assert.ok(Array.isArray(tasks));
      assert.deepEqual(
        tasks.map((value) => {
          const { reference, status } = record(value, "Invalid task");
          return { reference, status };
        }),
        [{ reference: "fixture:TSK-0", status: "Done" }],
        "audit task was not reconciled as completed"
      );
      assert.ok(!readdirSync(root).includes("AUDIT.md"), "audit created a parallel ledger");
    }
  }
  workbench(root, env, "pre-commit");
}
export {
  cases,
  command,
  grade,
  prepare,
  snapshot,
  workbench,
  write
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNraWxsLWV2YWx1YXRpb24tY2FzZXMubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzUmVjb3JkLCByZWNvcmQsIHJlcXVpcmVkLCBzdHJpbmcgfSBmcm9tIFwiLi92YWx1ZXMubWpzXCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGNwU3luYywgbHN0YXRTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHJlYWRsaW5rU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGFyc2VBbGxEb2N1bWVudHMgfSBmcm9tIFwieWFtbFwiO1xuXG5leHBvcnQgY29uc3QgY2FzZXMgPSB7XG4gIHJldmlldzoge1xuICAgIHNraWxsOiBcIndvcmtiZW5jaC1yZXZpZXdcIixcbiAgICByZXF1ZXN0OiBcIlJldmlldyBhbmQgZmluaXNoIHRoZSBwZW5kaW5nIGJhc2tldC10b3RhbCBmZWF0dXJlIGFnYWluc3QgUkVBRE1FLm1kLiBGaXggaW4tc2NvcGUgaXNzdWVzLlwiLFxuICAgIHJldmlldzogXCJEaWQgdGhlIGFnZW50IGZpeCB0aGUgYm91bmRhcnkgZGVmZWN0IGFuZCB3b3J0aHdoaWxlIGR1cGxpY2F0aW9uIG5vdywgd2l0aCBtZWFuaW5nZnVsIHZlcmlmaWNhdGlvbj9cIixcbiAgfSxcbiAgcmVmYWN0b3JzOiB7XG4gICAgc2tpbGw6IFwid29ya2JlbmNoLXJlZmFjdG9yc1wiLFxuICAgIHJlcXVlc3Q6IFwiV2hhdCByZWZhY3RvcnMgd291bGQgeW91IHJlY29tbWVuZCBmb3IgdGhlIHBlbmRpbmcgYmFza2V0LXRvdGFsIGZlYXR1cmU/IEFkdmljZSBvbmx5LlwiLFxuICAgIHJldmlldzogXCJEb2VzIHRoZSBhZHZpY2UgaWRlbnRpZnkgY29uY3JldGUgdmFsdWUgYW5kIGRpc3Rpbmd1aXNoIG1pc3NlZCBjbGVhbnVwIGZyb20gYSBzZXBhcmF0ZSBkZXNpZ24gY2hhbmdlP1wiLFxuICB9LFxuICBkZXBlbmRlbmNpZXM6IHtcbiAgICBza2lsbDogXCJ0eXBlc2NyaXB0LWRlcGVuZGVuY3ktcmVmcmVzaFwiLFxuICAgIHJlcXVlc3Q6IFwiVXBkYXRlIG9ubHkgdGhlIGRpcmVjdCBpcy1udW1iZXIgZGVwZW5kZW5jeSB0byA3LjAuMCwgaW5jbHVkaW5nIGl0cyByZXF1aXJlbWVudCBhbmQgbG9ja2ZpbGUuXCIsXG4gICAgcmV2aWV3OiBcIldlcmUgdW5yZWxhdGVkIHJlcXVpcmVtZW50cywgdG9vbCBwaW5zLCBhbmQgY2hlY2tzIHByZXNlcnZlZCwgYW5kIHdlcmUgdGhlIHJldGFpbmVkIGNoYW5nZXMgdmVyaWZpZWQ/XCIsXG4gIH0sXG4gIGF1ZGl0OiB7XG4gICAgc2tpbGw6IFwid29ya2JlbmNoLWF1ZGl0XCIsXG4gICAgcmVxdWVzdDpcbiAgICAgIFwiUmVzdW1lIHRoZSBwcm9qZWN0IGF1ZGl0IGZyb20gZml4dHVyZTpUU0stMCBhbmQgZmluaXNoIHRoZSByZW1haW5pbmcgd29yay4gRml4IHZlcmlmaWVkIGludGVybmFsIGRlZmVjdHMuXCIsXG4gICAgcmV2aWV3OiBcIkRpZCB0aGUgYWdlbnQgcmVzdW1lIHRoZSByZWNvcmRlZCBib3VuZGFyeSwgcmVjb25jaWxlIGZpbmRpbmdzIGFuZCBldmlkZW5jZSwgYW5kIGF2b2lkIGEgc2Vjb25kIGxlZGdlcj9cIixcbiAgfSxcbn07XG5cbmNvbnN0IGltcGxlbWVudGF0aW9uID0gYGV4cG9ydCBmdW5jdGlvbiB0b3RhbChpdGVtcywgZGlzY291bnRlZCA9IGZhbHNlKSB7XG4gIGlmIChkaXNjb3VudGVkKSB7XG4gICAgbGV0IGFtb3VudCA9IDA7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSBhbW91bnQgKz0gaXRlbS5wcmljZSAqIChpdGVtLnF1YW50aXR5IHx8IDEpO1xuICAgIHJldHVybiBhbW91bnQgKiAwLjk7XG4gIH1cbiAgbGV0IGFtb3VudCA9IDA7XG4gIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykgYW1vdW50ICs9IGl0ZW0ucHJpY2UgKiAoaXRlbS5xdWFudGl0eSB8fCAxKTtcbiAgcmV0dXJuIGFtb3VudDtcbn1cbmA7XG5cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZShyb290OiBzdHJpbmcsIHBhdGg6IHN0cmluZywgY29udGVudHM6IHN0cmluZyB8IE5vZGVKUy5BcnJheUJ1ZmZlclZpZXcpIHtcbiAgbWtkaXJTeW5jKGpvaW4ocm9vdCwgcGF0aCwgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihyb290LCBwYXRoKSwgY29udGVudHMpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZChyb290OiBzdHJpbmcsIGVudjogTm9kZUpTLlByb2Nlc3NFbnYsIGV4ZWN1dGFibGU6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10pIHtcbiAgcmV0dXJuIGV4ZWNGaWxlU3luYyhleGVjdXRhYmxlLCBhcmdzLCB7XG4gICAgY3dkOiByb290LFxuICAgIGVudixcbiAgICBlbmNvZGluZzogXCJ1dGY4XCIsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgIHRpbWVvdXQ6IDEyMDAwMCxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3b3JrYmVuY2gocm9vdDogc3RyaW5nLCBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52LCAuLi5hcmdzOiBzdHJpbmdbXSkge1xuICByZXR1cm4gY29tbWFuZChyb290LCBlbnYsIHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICBqb2luKHJlcXVpcmVkKGVudi5XT1JLQkVOQ0hfRElTVFJJQlVUSU9OX1JPT1QsIFwiTWlzc2luZyBldmFsdWF0aW9uIGRpc3RyaWJ1dGlvblwiKSwgXCJiaW4vd29ya2JlbmNoLm1qc1wiKSxcbiAgICAuLi5hcmdzLFxuICBdKTtcbn1cblxuZnVuY3Rpb24gcG5wbShyb290OiBzdHJpbmcsIGVudjogTm9kZUpTLlByb2Nlc3NFbnYsIC4uLmFyZ3M6IHN0cmluZ1tdKSB7XG4gIGNvbnN0IHBhY2thZ2VNYW5hZ2VyID0gc3RyaW5nKFxuICAgIHJlY29yZChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwicGFja2FnZS5qc29uXCIpLCBcInV0ZjhcIikpLCBcIkludmFsaWQgcGFja2FnZSBtZXRhZGF0YVwiKS5wYWNrYWdlTWFuYWdlcixcbiAgICBcIk1pc3NpbmcgcGFja2FnZSBtYW5hZ2VyXCIsXG4gICk7XG4gIHJldHVybiBjb21tYW5kKHJvb3QsIGVudiwgXCJucG1cIiwgW1wiZXhlY1wiLCBcIi0teWVzXCIsIGAtLXBhY2thZ2U9JHtwYWNrYWdlTWFuYWdlcn1gLCBcIi0tXCIsIFwicG5wbVwiLCAuLi5hcmdzXSk7XG59XG5cbmZ1bmN0aW9uIGRlcGVuZGVuY3lMb2NrKHJvb3Q6IHN0cmluZykge1xuICBjb25zdCBkb2N1bWVudHMgPSBwYXJzZUFsbERvY3VtZW50cyhyZWFkRmlsZVN5bmMoam9pbihyb290LCBcInBucG0tbG9jay55YW1sXCIpLCBcInV0ZjhcIikpLm1hcCgoZG9jdW1lbnQpID0+IHtcbiAgICBpZiAoZG9jdW1lbnQuZXJyb3JzLmxlbmd0aCkgdGhyb3cgcmVxdWlyZWQoZG9jdW1lbnQuZXJyb3JzWzBdLCBcIk1pc3NpbmcgWUFNTCBwYXJzZSBlcnJvclwiKTtcbiAgICBjb25zdCB2YWx1ZTogdW5rbm93biA9IGRvY3VtZW50LnRvSlNPTigpO1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfSk7XG4gIGNvbnN0IHByb2plY3RzID0gZG9jdW1lbnRzLmZpbHRlcihcbiAgICAoZG9jdW1lbnQpID0+XG4gICAgICBpc1JlY29yZChkb2N1bWVudCkgJiZcbiAgICAgIGlzUmVjb3JkKGRvY3VtZW50LmltcG9ydGVycykgJiZcbiAgICAgIGlzUmVjb3JkKGRvY3VtZW50LmltcG9ydGVyc1tcIi5cIl0pICYmXG4gICAgICBpc1JlY29yZChkb2N1bWVudC5pbXBvcnRlcnNbXCIuXCJdLmRlcGVuZGVuY2llcyksXG4gICk7XG4gIGFzc2VydC5lcXVhbChwcm9qZWN0cy5sZW5ndGgsIDEsIFwibG9ja2ZpbGUgbXVzdCBoYXZlIG9uZSB1bmFtYmlndW91cyBwcm9qZWN0IGRlcGVuZGVuY3kgZG9jdW1lbnRcIik7XG4gIGNvbnN0IHByb2plY3QgPSByZXF1aXJlZChwcm9qZWN0c1swXSwgXCJNaXNzaW5nIGxvY2sgcHJvamVjdFwiKTtcbiAgY29uc3QgZGVwZW5kZW5jaWVzID0gcmVjb3JkKFxuICAgIHJlY29yZChyZWNvcmQocmVjb3JkKHByb2plY3QsIFwiSW52YWxpZCBsb2NrIHByb2plY3RcIikuaW1wb3J0ZXJzLCBcIk1pc3NpbmcgaW1wb3J0ZXJzXCIpW1wiLlwiXSwgXCJNaXNzaW5nIHJvb3QgaW1wb3J0ZXJcIilcbiAgICAgIC5kZXBlbmRlbmNpZXMsXG4gICAgXCJNaXNzaW5nIGRlcGVuZGVuY2llc1wiLFxuICApO1xuICByZXR1cm4geyBwcm9qZWN0LCBkZXBlbmRlbmNpZXMsIG90aGVyOiBkb2N1bWVudHMuZmlsdGVyKChkb2N1bWVudCkgPT4gZG9jdW1lbnQgIT09IHByb2plY3QpIH07XG59XG5cbi8vIEEgZGlnZXN0IGNvdmVycyBmaWxlIGNvbnRlbnQsIHN5bWxpbmsgdGFyZ2V0cywgYW5kIGZpbGUgbW9kZXMsIGluY2x1ZGluZyB1bnRyYWNrZWQgd29yay5cbmV4cG9ydCBmdW5jdGlvbiBzbmFwc2hvdChyb290OiBzdHJpbmcpIHtcbiAgY29uc3QgZW50cmllczogKHN0cmluZyB8IG51bWJlcilbXVtdID0gW107XG4gIGZ1bmN0aW9uIHdhbGsoZGlyZWN0b3J5OiBzdHJpbmcsIHByZWZpeCA9IFwiXCIpIHtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pLnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpKSB7XG4gICAgICBpZiAoW1wiLmdpdFwiLCBcIm5vZGVfbW9kdWxlc1wiXS5pbmNsdWRlcyhlbnRyeS5uYW1lKSkgY29udGludWU7XG4gICAgICBjb25zdCBwYXRoID0gam9pbihkaXJlY3RvcnksIGVudHJ5Lm5hbWUpO1xuICAgICAgY29uc3QgcmVsYXRpdmUgPSBqb2luKHByZWZpeCwgZW50cnkubmFtZSk7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkgd2FsayhwYXRoLCByZWxhdGl2ZSk7XG4gICAgICBlbHNlXG4gICAgICAgIGVudHJpZXMucHVzaChbXG4gICAgICAgICAgcmVsYXRpdmUsXG4gICAgICAgICAgbHN0YXRTeW5jKHBhdGgpLm1vZGUsXG4gICAgICAgICAgZW50cnkuaXNTeW1ib2xpY0xpbmsoKSA/IHJlYWRsaW5rU3luYyhwYXRoKSA6IHJlYWRGaWxlU3luYyhwYXRoKS50b1N0cmluZyhcImJhc2U2NFwiKSxcbiAgICAgICAgXSk7XG4gICAgfVxuICB9XG4gIHdhbGsocm9vdCk7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShKU09OLnN0cmluZ2lmeShlbnRyaWVzKSkuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZShyb290OiBzdHJpbmcsIGRpc3RyaWJ1dGlvbjogc3RyaW5nLCBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52LCBuYW1lOiBrZXlvZiB0eXBlb2YgY2FzZXMpIHtcbiAgZW52LldPUktCRU5DSF9ESVNUUklCVVRJT05fUk9PVCA9IGRpc3RyaWJ1dGlvbjtcbiAgaWYgKCFlbnYuV09SS0JFTkNIX0NPTkZJR19IT01FKSB0aHJvdyBuZXcgRXJyb3IoXCJTa2lsbCBldmFsdWF0aW9ucyByZXF1aXJlIGFuIGlzb2xhdGVkIHVzZXIgY29uZmlndXJhdGlvbiBkaXJlY3RvcnlcIik7XG4gIHdyaXRlKGVudi5XT1JLQkVOQ0hfQ09ORklHX0hPTUUsIFwiY29uZmlnLnRvbWxcIiwgYFtza2lsbHNdXFxuZW5hYmxlZCA9ICR7SlNPTi5zdHJpbmdpZnkoW2Nhc2VzW25hbWVdLnNraWxsXSl9XFxuYCk7XG4gIGNwU3luYyhqb2luKGRpc3RyaWJ1dGlvbiwgXCJ3b3JrYmVuY2gvZGVjaXNpb25zXCIpLCBqb2luKHJvb3QsIFwid29ya2JlbmNoL2RlY2lzaW9uc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlKHJvb3QsIFwiLmdpdGlnbm9yZVwiLCBcIm5vZGVfbW9kdWxlcy9cXG5cIik7XG4gIHdyaXRlKHJvb3QsIFwiLm5vZGUtdmVyc2lvblwiLCBwcm9jZXNzLnZlcnNpb25zLm5vZGUgKyBcIlxcblwiKTtcbiAgd3JpdGUoXG4gICAgcm9vdCxcbiAgICBcIndvcmtiZW5jaC9DSEFSVEVSLm1kXCIsXG4gICAgXCIjIENoYXJ0ZXJcXG5cXG5Qcm92aWRlIHByZWRpY3RhYmxlIGJhc2tldCB0b3RhbHMgZm9yIGEgc21hbGwgY29tbWFuZC1saW5lIHNob3AuXFxuXCIsXG4gICk7XG4gIHdyaXRlKFxuICAgIHJvb3QsXG4gICAgXCJ3b3JrYmVuY2gvcHJvamVjdHMudG9tbFwiLFxuICAgICdbW3Byb2plY3RdXVxcbmlkID0gXCJmaXh0dXJlXCJcXG5wYXRoID0gXCIuXCJcXG5bW2xhbmd1YWdlX3Jvb3RdXVxcbmxhbmd1YWdlID0gXCJ0eXBlc2NyaXB0XCJcXG5wYXRoID0gXCIuXCJcXG4nLFxuICApO1xuICB3b3JrYmVuY2gocm9vdCwgZW52LCBcInNldHVwLXByb2plY3RcIiwgcm9vdCk7XG4gIHdyaXRlKFxuICAgIHJvb3QsXG4gICAgXCJ3b3JrYmVuY2gvY29uZmlnLnRvbWxcIixcbiAgICByZWFkRmlsZVN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaC9jb25maWcudG9tbFwiKSwgXCJ1dGY4XCIpICtcbiAgICAgICdcXG5bW2NoZWNrXV1cXG5uYW1lID0gXCJCZWhhdmlvclwiXFxucm9sZSA9IFwidGVzdFwiXFxuY29tbWFuZCA9IFtcIm5vZGVcIiwgXCItLXRlc3RcIl1cXG4nLFxuICApO1xuICB3cml0ZShcbiAgICByb290LFxuICAgIFwiUkVBRE1FLm1kXCIsXG4gICAgXCIjIEJhc2tldCB0b3RhbHNcXG5cXG5gdG90YWwoaXRlbXMsIGRpc2NvdW50ZWQpYCBzdW1zIG5vbm5lZ2F0aXZlIGl0ZW0gcHJpY2VzIHRpbWVzIHF1YW50aXRpZXMuIEFuIG9taXR0ZWQgcXVhbnRpdHkgbWVhbnMgb25lOyB6ZXJvIG1lYW5zIHplcm8uXFxuQSBkaXNjb3VudCByZWR1Y2VzIHRoZSB3aG9sZSB0b3RhbCBieSB0ZW4gcGVyY2VudC4gRW1wdHkgYmFza2V0cyBjb3N0IHplcm8uIFJ1biBgbm9kZSAtLXRlc3RgIHRvIGNoZWNrIGJlaGF2aW9yLlxcblwiLFxuICApO1xuICB3cml0ZShcbiAgICByb290LFxuICAgIFwiYmFza2V0Lm1qc1wiLFxuICAgIFwiZXhwb3J0IGZ1bmN0aW9uIHRvdGFsKGl0ZW1zKSB7IHJldHVybiBpdGVtcy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgaXRlbS5wcmljZSwgMCk7IH1cXG5cIixcbiAgKTtcbiAgd3JpdGUoXG4gICAgcm9vdCxcbiAgICBcImJhc2tldC50ZXN0Lm1qc1wiLFxuICAgICdpbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcXG5pbXBvcnQgeyB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xcbmltcG9ydCB7IHRvdGFsIH0gZnJvbSBcIi4vYmFza2V0Lm1qc1wiO1xcbnRlc3QoXCJzdW1zIHByaWNlc1wiLCAoKSA9PiBhc3NlcnQuZXF1YWwodG90YWwoW3sgcHJpY2U6IDIgfSwgeyBwcmljZTogMyB9XSksIDUpKTtcXG4nLFxuICApO1xuICBjb25zdCBwYWNrYWdlSnNvbjoge1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBwcml2YXRlOiBib29sZWFuO1xuICAgIHR5cGU6IHN0cmluZztcbiAgICBzY3JpcHRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIHBhY2thZ2VNYW5hZ2VyPzogc3RyaW5nO1xuICAgIGVuZ2luZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGRlcGVuZGVuY2llcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIH0gPSB7IG5hbWU6IFwid29ya2JlbmNoLWV2YWx1YXRpb25cIiwgcHJpdmF0ZTogdHJ1ZSwgdHlwZTogXCJtb2R1bGVcIiwgc2NyaXB0czogeyB0ZXN0OiBcIm5vZGUgLS10ZXN0XCIgfSB9O1xuICBpZiAobmFtZSA9PT0gXCJkZXBlbmRlbmNpZXNcIikge1xuICAgIHBhY2thZ2VKc29uLnBhY2thZ2VNYW5hZ2VyID0gc3RyaW5nKFxuICAgICAgcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlzdHJpYnV0aW9uLCBcInBhY2thZ2UuanNvblwiKSwgXCJ1dGY4XCIpKSwgXCJJbnZhbGlkIGRpc3RyaWJ1dGlvbiBwYWNrYWdlXCIpXG4gICAgICAgIC5wYWNrYWdlTWFuYWdlcixcbiAgICAgIFwiTWlzc2luZyBkaXN0cmlidXRpb24gcGFja2FnZSBtYW5hZ2VyXCIsXG4gICAgKTtcbiAgICBwYWNrYWdlSnNvbi5lbmdpbmVzID0geyBub2RlOiBcIj49MjIuMTMuMFwiIH07XG4gICAgcGFja2FnZUpzb24uZGVwZW5kZW5jaWVzID0geyBcImlzLW51bWJlclwiOiBcIjYuMC4wXCIsIFwiaXMtb2RkXCI6IFwiMy4wLjBcIiB9O1xuICAgIHdyaXRlKHJvb3QsIFwicG5wbS13b3Jrc3BhY2UueWFtbFwiLCBcIm1pbmltdW1SZWxlYXNlQWdlOiAxNDQwXFxuXCIpO1xuICAgIHdyaXRlKFxuICAgICAgcm9vdCxcbiAgICAgIFwiYmFza2V0LnRlc3QubWpzXCIsXG4gICAgICAnaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XFxuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcXG5pbXBvcnQgaXNOdW1iZXIgZnJvbSBcImlzLW51bWJlclwiO1xcbmltcG9ydCBpc09kZCBmcm9tIFwiaXMtb2RkXCI7XFxudGVzdChcIm51bWVyaWMgaW5wdXRzXCIsICgpID0+IHsgYXNzZXJ0LmVxdWFsKGlzTnVtYmVyKFwiNDJcIiksIHRydWUpOyBhc3NlcnQuZXF1YWwoaXNOdW1iZXIoXCJhYmNcIiksIGZhbHNlKTsgYXNzZXJ0LmVxdWFsKGlzT2RkKDMpLCB0cnVlKTsgfSk7XFxuJyxcbiAgICApO1xuICB9XG4gIHdyaXRlKHJvb3QsIFwicGFja2FnZS5qc29uXCIsIEpTT04uc3RyaW5naWZ5KHBhY2thZ2VKc29uLCBudWxsLCAyKSArIFwiXFxuXCIpO1xuICBpZiAobmFtZSA9PT0gXCJkZXBlbmRlbmNpZXNcIikgcG5wbShyb290LCBlbnYsIFwiaW5zdGFsbFwiLCBcIi0taWdub3JlLXNjcmlwdHNcIik7XG4gIHdvcmtiZW5jaChyb290LCBlbnYsIFwic3luY1wiKTtcbiAgaWYgKG5hbWUgPT09IFwiYXVkaXRcIikge1xuICAgIHdyaXRlKHJvb3QsIFwiYmFza2V0Lm1qc1wiLCBpbXBsZW1lbnRhdGlvbik7XG4gICAgd29ya2JlbmNoKHJvb3QsIGVudiwgXCJyZWNvcmRcIiwgXCJhZGRcIiwgXCJ0YXNrXCIsIFwiQXVkaXQgYmFza2V0IHRvdGFsc1wiKTtcbiAgICB3cml0ZShcbiAgICAgIHJvb3QsXG4gICAgICBcIndvcmtiZW5jaC90YXNrcy9UU0stMDAubWRcIixcbiAgICAgIFwiLS0tXFxuc3RhdHVzOiBBY3RpdmVcXG4tLS1cXG5cXG4jIFRTSy0wOiBBdWRpdCBiYXNrZXQgdG90YWxzXFxuXFxuUmV2aWV3ZWQ6IFJFQURNRSBjb250cmFjdCwgY2hlY2sgY29uZmlndXJhdGlvbiwgYW5kIG9yZGluYXJ5IGJhc2tldCB0ZXN0cy5cXG5cXG5SZW1haW5pbmc6IGluc3BlY3QgYmFza2V0Lm1qcyBib3VuZGFyeSBiZWhhdmlvciBhbmQgcmVjb25jaWxlIHZlcmlmaWNhdGlvbiBldmlkZW5jZSBoZXJlLlxcblwiLFxuICAgICk7XG4gICAgd29ya2JlbmNoKHJvb3QsIGVudiwgXCJmb3JtYXRcIiwgXCItLWFsbFwiLCBcIi0td3JpdGVcIik7XG4gICAgd29ya2JlbmNoKHJvb3QsIGVudiwgXCJzeW5jXCIpO1xuICB9XG4gIHdvcmtiZW5jaChyb290LCBlbnYsIFwidmFsaWRhdGVcIiwgcm9vdCk7XG4gIGNvbW1hbmQocm9vdCwgZW52LCBcImdpdFwiLCBbXCItY1wiLCBcImluaXQuZGVmYXVsdEJyYW5jaD1tYWluXCIsIFwiaW5pdFwiLCBcIi0tcXVpZXRcIl0pO1xuICBjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1wiYWRkXCIsIFwiLlwiXSk7XG4gIGNvbW1hbmQocm9vdCwgZW52LCBcImdpdFwiLCBbXG4gICAgXCItY1wiLFxuICAgIFwidXNlci5uYW1lPVdvcmtiZW5jaCBldmFsdWF0aW9uXCIsXG4gICAgXCItY1wiLFxuICAgIFwidXNlci5lbWFpbD1ldmFsdWF0aW9uQGV4YW1wbGUuaW52YWxpZFwiLFxuICAgIFwiY29tbWl0XCIsXG4gICAgXCItLXF1aWV0XCIsXG4gICAgXCItbVwiLFxuICAgIFwiRml4dHVyZSBiYXNlbGluZVwiLFxuICBdKTtcbiAgaWYgKFtcInJldmlld1wiLCBcInJlZmFjdG9yc1wiXS5pbmNsdWRlcyhuYW1lKSkgd3JpdGUocm9vdCwgXCJiYXNrZXQubWpzXCIsIGltcGxlbWVudGF0aW9uKTtcbiAgcmV0dXJuIHtcbiAgICBzbmFwc2hvdDogc25hcHNob3Qocm9vdCksXG4gICAgaGVhZDogY29tbWFuZChyb290LCBlbnYsIFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0pLnRyaW0oKSxcbiAgICBwYWNrYWdlSnNvbixcbiAgICB0YXNrOiBuYW1lID09PSBcImF1ZGl0XCIgPyByZWFkRmlsZVN5bmMoam9pbihyb290LCBcIndvcmtiZW5jaC90YXNrcy9UU0stMDAubWRcIiksIFwidXRmOFwiKSA6IHVuZGVmaW5lZCxcbiAgICBsb2NrOiBuYW1lID09PSBcImRlcGVuZGVuY2llc1wiID8gZGVwZW5kZW5jeUxvY2socm9vdCkgOiB1bmRlZmluZWQsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBncmFkZShcbiAgcm9vdDogc3RyaW5nLFxuICBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52LFxuICBuYW1lOiBrZXlvZiB0eXBlb2YgY2FzZXMsXG4gIGJlZm9yZTogUmV0dXJuVHlwZTx0eXBlb2YgcHJlcGFyZT4sXG4pIHtcbiAgYXNzZXJ0LmVxdWFsKGNvbW1hbmQocm9vdCwgZW52LCBcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCJdKS50cmltKCksIGJlZm9yZS5oZWFkLCBcImFnZW50IGNvbW1pdHRlZCB3aXRob3V0IHJlcXVlc3RcIik7XG4gIGFzc2VydC5lcXVhbChjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1wiZGlmZlwiLCBcIi0tY2FjaGVkXCIsIFwiLS1uYW1lLW9ubHlcIl0pLCBcIlwiLCBcImFnZW50IHN0YWdlZCB3aXRob3V0IHJlcXVlc3RcIik7XG4gIGFzc2VydC5lcXVhbChcbiAgICBjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1xuICAgICAgXCJkaWZmXCIsXG4gICAgICBcIkhFQURcIixcbiAgICAgIFwiLS1cIixcbiAgICAgIFwiLndvcmtiZW5jaFwiLFxuICAgICAgXCIubm9kZS12ZXJzaW9uXCIsXG4gICAgICBcIndvcmtiZW5jaC9DSEFSVEVSLm1kXCIsXG4gICAgICBcIndvcmtiZW5jaC9jb25maWcudG9tbFwiLFxuICAgICAgXCJwbnBtLXdvcmtzcGFjZS55YW1sXCIsXG4gICAgXSksXG4gICAgXCJcIixcbiAgICBcImFnZW50IGNoYW5nZWQgcG9saWN5LCBjaGFydGVyLCBjaGVja3MsIG9yIHN1cHBseS1jaGFpbiBjb250cm9sc1wiLFxuICApO1xuICBpZiAobmFtZSA9PT0gXCJyZWZhY3RvcnNcIikge1xuICAgIGFzc2VydC5lcXVhbChzbmFwc2hvdChyb290KSwgYmVmb3JlLnNuYXBzaG90LCBcImFkdmlzb3J5IHJlcXVlc3QgY2hhbmdlZCBwcm9qZWN0IGZpbGVzXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAobmFtZSA9PT0gXCJkZXBlbmRlbmNpZXNcIikge1xuICAgIGNvbnN0IGFmdGVyID0gcmVjb3JkKEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocm9vdCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmOFwiKSksIFwiSW52YWxpZCBwYWNrYWdlIG1ldGFkYXRhXCIpO1xuICAgIGNvbnN0IGRlcGVuZGVuY2llcyA9IHJlY29yZChhZnRlci5kZXBlbmRlbmNpZXMsIFwiTWlzc2luZyBkZXBlbmRlbmNpZXNcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgW1wiNy4wLjBcIiwgXCJeNy4wLjBcIiwgXCJ+Ny4wLjBcIl0uaW5jbHVkZXMoc3RyaW5nKGRlcGVuZGVuY2llc1tcImlzLW51bWJlclwiXSwgXCJNaXNzaW5nIGlzLW51bWJlciByZXF1aXJlbWVudFwiKSksXG4gICAgICBcInJlcXVlc3RlZCByZXF1aXJlbWVudCB3YXMgbm90IHVwZGF0ZWRcIixcbiAgICApO1xuICAgIGRlcGVuZGVuY2llc1tcImlzLW51bWJlclwiXSA9IHJlcXVpcmVkKGJlZm9yZS5wYWNrYWdlSnNvbi5kZXBlbmRlbmNpZXMsIFwiTWlzc2luZyBvcmlnaW5hbCBkZXBlbmRlbmNpZXNcIilbXCJpcy1udW1iZXJcIl07XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhZnRlciwgYmVmb3JlLnBhY2thZ2VKc29uLCBcInVucmVsYXRlZCBwYWNrYWdlIGRlY2xhcmF0aW9ucyBjaGFuZ2VkXCIpO1xuICAgIGNvbnN0IGxvY2sgPSBkZXBlbmRlbmN5TG9jayhyb290KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgbG9jay5vdGhlcixcbiAgICAgIHJlcXVpcmVkKGJlZm9yZS5sb2NrLCBcIk1pc3Npbmcgb3JpZ2luYWwgbG9ja1wiKS5vdGhlcixcbiAgICAgIFwicGFja2FnZS1tYW5hZ2VyIG9yIGNvbmZpZ3VyYXRpb24gZGVwZW5kZW5jaWVzIGNoYW5nZWRcIixcbiAgICApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICBsb2NrLmRlcGVuZGVuY2llc1tcImlzLW9kZFwiXSxcbiAgICAgIHJlcXVpcmVkKGJlZm9yZS5sb2NrLCBcIk1pc3Npbmcgb3JpZ2luYWwgbG9ja1wiKS5kZXBlbmRlbmNpZXNbXCJpcy1vZGRcIl0sXG4gICAgICBcInVucmVsYXRlZCBkaXJlY3QgZGVwZW5kZW5jeSBjaGFuZ2VkXCIsXG4gICAgKTtcbiAgICBwbnBtKHJvb3QsIGVudiwgXCJpbnN0YWxsXCIsIFwiLS1mcm96ZW4tbG9ja2ZpbGVcIiwgXCItLWlnbm9yZS1zY3JpcHRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlY29yZChcbiAgICAgICAgSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihyb290LCBcIm5vZGVfbW9kdWxlcy9pcy1udW1iZXIvcGFja2FnZS5qc29uXCIpLCBcInV0ZjhcIikpLFxuICAgICAgICBcIkludmFsaWQgaW5zdGFsbGVkIHBhY2thZ2VcIixcbiAgICAgICkudmVyc2lvbixcbiAgICAgIFwiNy4wLjBcIixcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIC8vIEhlbGQtb3V0IGJlaGF2aW9yYWwgb3JhY2xlOiB0aGUgbW9kZWwgc2VlcyB0aGUgY29udHJhY3QsIG5vdCB0aGlzIGdyYWRlci5cbiAgICBjb21tYW5kKHJvb3QsIGVudiwgcHJvY2Vzcy5leGVjUGF0aCwgW1xuICAgICAgXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsXG4gICAgICBcIi1lXCIsXG4gICAgICAnaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7IGltcG9ydCB7IHRvdGFsIH0gZnJvbSBcIi4vYmFza2V0Lm1qc1wiOyBmb3IgKGNvbnN0IGRpc2NvdW50ZWQgb2YgW2ZhbHNlLCB0cnVlXSkgeyBjb25zdCBmYWN0b3IgPSBkaXNjb3VudGVkID8gMC45IDogMTsgYXNzZXJ0LmVxdWFsKHRvdGFsKFtdLCBkaXNjb3VudGVkKSwgMCk7IGFzc2VydC5lcXVhbCh0b3RhbChbe3ByaWNlOiAxMCwgcXVhbnRpdHk6IDB9XSwgZGlzY291bnRlZCksIDApOyBhc3NlcnQuZXF1YWwodG90YWwoW3twcmljZTogMTB9LCB7cHJpY2U6IDUsIHF1YW50aXR5OiAyfV0sIGRpc2NvdW50ZWQpLCAyMCAqIGZhY3Rvcik7IH0nLFxuICAgIF0pO1xuICAgIGlmIChuYW1lID09PSBcImF1ZGl0XCIpIHtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgICAgIHJlYWRkaXJTeW5jKGpvaW4ocm9vdCwgXCJ3b3JrYmVuY2gvdGFza3NcIikpLnNvcnQoKSxcbiAgICAgICAgW1wiVFNLLTAwLm1kXCJdLFxuICAgICAgICBcImF1ZGl0IGRpZCBub3QgcmV1c2UgaXRzIHRhc2tcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQubm90RXF1YWwoXG4gICAgICAgIHJlYWRGaWxlU3luYyhqb2luKHJvb3QsIFwid29ya2JlbmNoL3Rhc2tzL1RTSy0wMC5tZFwiKSwgXCJ1dGY4XCIpLFxuICAgICAgICBiZWZvcmUudGFzayxcbiAgICAgICAgXCJ0YXNrIGRpZCBub3QgcmV0YWluIGNvbnRpbnVhdGlvbiBldmlkZW5jZVwiLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHRhc2tzOiB1bmtub3duID0gSlNPTi5wYXJzZSh3b3JrYmVuY2gocm9vdCwgZW52LCBcInRhc2tcIiwgXCItLWFsbFwiLCBcIi0tanNvblwiKSk7XG4gICAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheSh0YXNrcykpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgICAgdGFza3MubWFwKCh2YWx1ZTogdW5rbm93bikgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgcmVmZXJlbmNlLCBzdGF0dXMgfSA9IHJlY29yZCh2YWx1ZSwgXCJJbnZhbGlkIHRhc2tcIik7XG4gICAgICAgICAgcmV0dXJuIHsgcmVmZXJlbmNlLCBzdGF0dXMgfTtcbiAgICAgICAgfSksXG4gICAgICAgIFt7IHJlZmVyZW5jZTogXCJmaXh0dXJlOlRTSy0wXCIsIHN0YXR1czogXCJEb25lXCIgfV0sXG4gICAgICAgIFwiYXVkaXQgdGFzayB3YXMgbm90IHJlY29uY2lsZWQgYXMgY29tcGxldGVkXCIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKCFyZWFkZGlyU3luYyhyb290KS5pbmNsdWRlcyhcIkFVRElULm1kXCIpLCBcImF1ZGl0IGNyZWF0ZWQgYSBwYXJhbGxlbCBsZWRnZXJcIik7XG4gICAgfVxuICB9XG4gIHdvcmtiZW5jaChyb290LCBlbnYsIFwicHJlLWNvbW1pdFwiKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsVUFBVSxRQUFRLFVBQVUsY0FBYztBQUNuRCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxRQUFRLFdBQVcsV0FBVyxjQUFjLGFBQWEsY0FBYyxxQkFBcUI7QUFDckcsU0FBUyxZQUFZO0FBQ3JCLFNBQVMseUJBQXlCO0FBRTNCLE1BQU0sUUFBUTtBQUFBLEVBQ25CLFFBQVE7QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLFNBQVM7QUFBQSxJQUNULFFBQVE7QUFBQSxFQUNWO0FBQUEsRUFDQSxXQUFXO0FBQUEsSUFDVCxPQUFPO0FBQUEsSUFDUCxTQUFTO0FBQUEsSUFDVCxRQUFRO0FBQUEsRUFDVjtBQUFBLEVBQ0EsY0FBYztBQUFBLElBQ1osT0FBTztBQUFBLElBQ1AsU0FBUztBQUFBLElBQ1QsUUFBUTtBQUFBLEVBQ1Y7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLE9BQU87QUFBQSxJQUNQLFNBQ0U7QUFBQSxJQUNGLFFBQVE7QUFBQSxFQUNWO0FBQ0Y7QUFFQSxNQUFNLGlCQUFpQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBWWhCLFNBQVMsTUFBTSxN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LEVBQUUsU0FBUyxPQUFPLGFBQWEsV0FBVyxHQUFHLCtCQUErQixDQUFDO0FBQUEsTUFDekc7QUFBQSxJQUNGO0FBQ0EsaUJBQWEsV0FBVyxJQUFJLFNBQVMsT0FBTyxZQUFZLGNBQWMsK0JBQStCLEVBQUUsV0FBVztBQUNsSCxXQUFPLFVBQVUsT0FBTyxPQUFPLGFBQWEsd0NBQXdDO0FBQ3BGLFVBQU0sT0FBTyxlQUFlLElBQUk7QUFDaEMsV0FBTztBQUFBLE1BQ0wsS0FBSztBQUFBLE1BQ0wsU0FBUyxPQUFPLE1BQU0sdUJBQXVCLEVBQUU7QUFBQSxNQUMvQztBQUFBLElBQ0Y7QUFDQSxXQUFPO0FBQUEsTUFDTCxLQUFLLGFBQWEsUUFBUTtBQUFBLE1BQzFCLFNBQVMsT0FBTyxNQUFNLHVCQUF1QixFQUFFLGFBQWEsUUFBUTtBQUFBLE1BQ3BFO0FBQUEsSUFDRjtBQUNBLFNBQUssTUFBTSxLQUFLLFdBQVcscUJBQXFCLGtCQUFrQjtBQUNsRSxXQUFPO0FBQUEsTUFDTDtBQUFBLFFBQ0UsS0FBSyxNQUFNLGFBQWEsS0FBSyxNQUFNLHFDQUFxQyxHQUFHLE1BQU0sQ0FBQztBQUFBLFFBQ2xGO0FBQUEsTUFDRixFQUFFO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGLE9BQU87QUFFTCxZQUFRLE1BQU0sS0FBSyxRQUFRLFVBQVU7QUFBQSxNQUNuQztBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQ0QsUUFBSSxTQUFTLFNBQVM7QUFDcEIsYUFBTztBQUFBLFFBQ0wsWUFBWSxLQUFLLE1BQU0saUJBQWlCLENBQUMsRUFBRSxLQUFLO0FBQUEsUUFDaEQsQ0FBQyxXQUFXO0FBQUEsUUFDWjtBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsUUFDTCxhQUFhLEtBQUssTUFBTSwyQkFBMkIsR0FBRyxNQUFNO0FBQUEsUUFDNUQsT0FBTztBQUFBLFFBQ1A7QUFBQSxNQUNGO0FBQ0EsWUFBTSxRQUFpQixLQUFLLE1BQU0sVUFBVSxNQUFNLEtBQUssUUFBUSxTQUFTLFFBQVEsQ0FBQztBQUNqRixhQUFPLEdBQUcsTUFBTSxRQUFRLEtBQUssQ0FBQztBQUM5QixhQUFPO0FBQUEsUUFDTCxNQUFNLElBQUksQ0FBQyxVQUFtQjtBQUM1QixnQkFBTSxFQUFFLFdBQVcsT0FBTyxJQUFJLE9BQU8sT0FBTyxjQUFjO0FBQzFELGlCQUFPLEVBQUUsV0FBVyxPQUFPO0FBQUEsUUFDN0IsQ0FBQztBQUFBLFFBQ0QsQ0FBQyxFQUFFLFdBQVcsaUJBQWlCLFFBQVEsT0FBTyxDQUFDO0FBQUEsUUFDL0M7QUFBQSxNQUNGO0FBQ0EsYUFBTyxHQUFHLENBQUMsWUFBWSxJQUFJLEVBQUUsU0FBUyxVQUFVLEdBQUcsaUNBQWlDO0FBQUEsSUFDdEY7QUFBQSxFQUNGO0FBQ0EsWUFBVSxNQUFNLEtBQUssWUFBWTtBQUNuQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3NraWxsLWV2YWx1YXRpb24tY2FzZXMubWpzIn0=

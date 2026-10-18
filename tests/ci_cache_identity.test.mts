import type { Workflow } from "./fixtures/workflow.mjs";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import { configFromData } from "../src/core.ts";
import { cacheCheckout } from "./fixtures/cache-checkout.mjs";
import { ciCacheFixtures } from "./fixtures/ci-cache.mjs";

const repository = resolve(import.meta.dirname, "..");

const fixture = ciCacheFixtures();

test("native cache keys retain acquisition identity without caching redownloaded tools", () => {
  const root = fixture();
  cacheCheckout(repository, root);
  const entry = join(root, "bin/workbench.mjs");
  writeFileSync(join(root, "bin/workbench-original.mjs"), readFileSync(entry));
  const invocations = join(root, "invocations");
  writeFileSync(invocations, "");
  writeFileSync(
    entry,
    `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(invocations)}, "inspection\\n"); await import("./workbench-original.mjs");`,
  );
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[project]]\nid="app"\npath="."\n[[language_root]]\nlanguage="typescript"\npath="."\n',
  );
  const environment = join(root, "environment");
  const output = join(root, "output");
  const run = (target = { paths: ["."] }) => {
    writeFileSync(environment, "");
    writeFileSync(output, "");
    const before = readFileSync(invocations, "utf8").split("\n").length;
    const result = spawnSync(process.execPath, [join(root, "scripts/ci-cache.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: output,
        CACHE_TARGET: JSON.stringify(target),
        WORKBENCH_DISTRIBUTION_ROOT: root,
        WORKBENCH_PROJECT_ROOT: root,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(invocations, "utf8").split("\n").length - before).toBe(1);
    return Object.fromEntries(
      [...readFileSync(output, "utf8").matchAll(/^([^\n]+)<<WORKBENCH_CACHE\n([\s\S]*?)\nWORKBENCH_CACHE\n/gm)].map(
        (match) => [required(match[1], "Output key"), required(match[2], "Output value")] as const,
      ),
    );
  };
  const baseline = run();
  const guestTarget = { paths: ["."], environment: "devcontainer" };
  expect(baseline["tools-key"]).toBeUndefined();
  expect(baseline["tools-paths"]).toBe("");
  const inventoryPath = join(root, "scripts/native-assets.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as Record<string, Record<string, unknown>>;
  required(inventory.gcc, "GCC catalog")["99.0.0"] = {};
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  expect(run()["tools-key"]).toBe(baseline["tools-key"]);
  const bootstrap = join(root, "src/package-manager.ts");
  writeFileSync(bootstrap, `${readFileSync(bootstrap, "utf8")}\n`);
  const changedBootstrap = run();
  expect(changedBootstrap["package-managers-key"]).not.toBe(baseline["package-managers-key"]);
  expect(changedBootstrap["tools-key"]).toBe(baseline["tools-key"]);
  expect(changedBootstrap["builds-key"]).toBe(baseline["builds-key"]);
  const acquisition = join(root, "src/artifact-streams.ts");
  writeFileSync(acquisition, `${readFileSync(acquisition, "utf8")}\n`);
  const changedInstaller = run();
  expect(changedInstaller["downloads-key"]).toBe(baseline["downloads-key"]);
  expect(changedInstaller["builds-key"]).not.toBe(baseline["builds-key"]);
  const verifier = join(root, "src/attestation-verification.ts");
  writeFileSync(verifier, `${readFileSync(verifier, "utf8")}\n`);
  const changedVerifier = run();
  expect(changedVerifier["builds-key"]).not.toBe(changedInstaller["builds-key"]);
  expect(changedVerifier["downloads-key"]).toBe(baseline["downloads-key"]);
  const guestBaseline = run(guestTarget);
  const key = join(root, "scripts/keys/node.asc");
  writeFileSync(key, `${readFileSync(key, "utf8")}\n`);
  expect(run()["builds-key"]).not.toBe(changedInstaller["builds-key"]);
  const guestChanged = run(guestTarget);
  expect(guestChanged["tools-key"]).toBeUndefined();
  expect(guestChanged["builds-key"]).not.toBe(guestBaseline["builds-key"]);
});

test("hosted persistence selection reads the configured image table or selects host caches", () => {
  const root = fixture();
  const checkout = join(root, "checkout");
  cacheCheckout(repository, checkout);
  const workflow = parse(readFileSync(join(repository, ".github/workflows/checks.yml"), "utf8")) as Workflow;
  const step = workflow.jobs.native.steps.find((step) => step.id === "persistence");
  const script = /^node --input-type=module <<'JS'\n([\s\S]+)\nJS\n?$/.exec(
    required(required(step, "Fixture value step").run, "Workflow step command"),
  )?.[1];
  expect(script).toBeDefined();
  const configPath = join(checkout, "workbench/config.toml");
  const config = configFromData(parseTOML(readFileSync(configPath, "utf8")), undefined, configPath);
  const output = join(root, "output");
  for (const configured of [true, false]) {
    if (!configured) delete required(config.ci, "Expected fixture value: config.ci").images;
    writeFileSync(configPath, stringifyTOML(config));
    writeFileSync(output, "");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", required(script, "Persistence script")],
      {
        cwd: checkout,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`container=${String(process.platform === "linux" && configured)}\n`);
  }
});

test("cache measurement records elapsed time and counts overlapping directories once", () => {
  const root = fixture();
  const directory = join(root, "workbench-ci");
  mkdirSync(join(directory, "cache/nested"), { recursive: true });
  writeFileSync(join(directory, "cache/nested/bytes"), "12345");
  writeFileSync(
    join(directory, "cache-plan.json"),
    JSON.stringify({ "tools-paths": [join(directory, "cache"), join(directory, "cache/nested")].join("\n") }),
  );
  const run = (phase: string) =>
    spawnSync(process.execPath, [join(repository, "scripts/ci-cache-metrics.mjs"), phase], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary") },
    });
  expect(run("start").status).toBe(0);
  const result = run("finish");
  expect(result.status, result.stderr).toBe(0);
  const measured = JSON.parse(readFileSync(join(directory, "cache-measurement.json"), "utf8")) as {
    groups: { name: string; bytes: number }[];
    elapsed_seconds: number;
  };
  expect(measured.groups).toEqual([{ name: "tools-paths", bytes: 5 }]);
  expect(measured.elapsed_seconds).toBeGreaterThanOrEqual(0);
  expect(readFileSync(join(root, "summary"), "utf8")).toContain("| tools-paths | 5 |");
});

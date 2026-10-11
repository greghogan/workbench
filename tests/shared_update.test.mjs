import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ciSelection } from "../src/ci-selection.ts";
import { sealDistribution, readDistributionPin } from "../src/distribution-manifest.ts";
import { installDistribution, installedVersion, listInstallations } from "../src/installation-store.ts";
import { installationRegistration, registerInstallation } from "../src/installation-project.ts";

const repository = resolve(import.meta.dirname, "..");
const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) {
    const writable = (path) => {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(root);
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-shared-update-test-"));
  temporary.push(root);
  const distribution = join(root, "distribution");
  mkdirSync(distribution);
  for (const name of ["bin", "bundle", ".githooks", "workbench", "skills", "languages", "collections", "Makefile"])
    cpSync(join(repository, name), join(distribution, name), {
      recursive: true,
      filter: (path) => ![".collections", ".local-collections"].includes(basename(path)),
    });
  writeFileSync(join(distribution, "workbench/projects.toml"), '[[project]]\nid = "workbench"\npath = "."\n');
  writeFileSync(
    join(distribution, "workbench/config.toml"),
    'schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n[citations]\nlibrary_dir = "library/citations"\n',
  );
  const old = sealDistribution(distribution, "1".repeat(40));
  const store = join(root, "store");
  installDistribution(distribution, old.sha256, store, "user");
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  const invoke = (...args) =>
    spawnSync(process.execPath, [join(repository, "bin/workbench.mjs"), ...args], {
      cwd: consumer,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        WORKBENCH_PROJECT_ROOT: consumer,
        WORKBENCH_LOCAL_CONFIG_ROOT: consumer,
      },
    });
  const cli = (...args) => {
    const result = invoke(...args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const git = (...args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  registerInstallation(consumer, old, store);
  cli("setup", "--id", "consumer");
  cpSync(join(repository, "workbench/CHARTER.md"), join(consumer, "workbench/CHARTER.md"));
  cli("config", "set", "checks.allow_empty", "true");
  cli("sync");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  const candidate = (change) => {
    const path = join(root, "candidate");
    cpSync(distribution, path, { recursive: true });
    rmSync(join(path, "workbench-distribution.json"));
    change(path);
    const pin = sealDistribution(path, "2".repeat(40));
    installDistribution(path, pin.sha256, store, "user");
    return pin;
  };
  return { root, consumer, old, store, cli, invoke, git, candidate };
}

test("shared updates use the candidate's policy and executable, retain generations, and leave the index untouched", () => {
  const { consumer, old, store, cli, git, candidate } = fixture();
  const originalIndex = git("write-tree");
  const next = candidate((path) => {
    const adr = join(path, "workbench/decisions/ADR-09.md");
    writeFileSync(adr, readFileSync(adr, "utf8") + "\nCandidate policy for the update fixture.\n");
  });
  const report = cli("update", next.sha256);
  expect(report).toContain("Nothing was staged or committed");
  expect(readDistributionPin(consumer)).toEqual(next);
  expect(installationRegistration(consumer).generations).toEqual([old, next]);
  expect(git("write-tree")).toBe(originalIndex);
  expect(git("diff", "--name-only")).toContain("workbench/distribution.json");
  expect(cli("validate")).toContain("validation passed");
  expect(listInstallations(store).every((entry) => entry.reasons.some((reason) => reason.kind === "profile"))).toBe(
    true,
  );
});

test("a failed candidate leaves the project selection and index intact and does not execute installation hooks", () => {
  const { root, consumer, old, store, invoke, git, candidate } = fixture();
  const tree = git("write-tree");
  const next = candidate((path) => writeFileSync(join(path, "bin/workbench.mjs"), "process.exit(7);\n"));
  expect(existsSync(installedVersion(store, next))).toBe(true); // Installation copies bytes without executing candidate code.
  const result = invoke("update", next.sha256);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("candidate migration or validation failed");
  expect(readDistributionPin(consumer)).toEqual(old);
  expect(git("write-tree")).toBe(tree);
  expect(git("status", "--porcelain")).toBe("");
  expect(existsSync(join(root, "consumer/.git/workbench-update.lock"))).toBe(false);
});

test("shared project hooks validate the staged pin and affected selection skips ADR-only edits", () => {
  const { consumer, old, cli, invoke, git } = fixture();
  const registry = join(consumer, "workbench/projects.toml");
  writeFileSync(
    registry,
    readFileSync(registry, "utf8") + '\n[[language_root]]\nlanguage = "javascript"\npath = "app"\n',
  );
  mkdirSync(join(consumer, "app"));
  writeFileSync(join(consumer, "app/.node-version"), "26.11.1\n");
  writeFileSync(
    join(consumer, "app/package.json"),
    JSON.stringify({ name: "separate-consumer", private: true, engines: { node: ">=22.23.3" } }),
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "configured example");
  const base = git("rev-parse", "HEAD");
  mkdirSync(join(consumer, "workbench/decisions"), { recursive: true });
  writeFileSync(
    join(consumer, "workbench/decisions/ADR-00.md"),
    "---\nsummary: Consumer documentation fixture.\n---\n\n# ADR-0: Consumer fixture\n\nRecord-only change.\n",
  );
  const selection = ciSelection(consumer, { affected: true, base });
  expect(selection.mode).toBe("affected");
  expect(selection.selected).toEqual([]);
  // The structural gate needs no language tool installation; keep the root structural-only for the hook fixture.
  writeFileSync(registry, '[[project]]\nid = "consumer"\npath = "."\n');
  cli("sync");
  git("add", ".");
  const digest = /Review digest: ([a-f0-9]{64})/.exec(cli("review"))[1];
  cli("review", "approve", "--digest", digest, "--human-written-charters");
  const hook = spawnSync("git", ["hook", "run", "pre-commit"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(hook.status, hook.stdout + hook.stderr).toBe(0);
  // Working-tree drift must not alter the proposed dependency.
  writeFileSync(join(consumer, "workbench/distribution.json"), JSON.stringify({ ...old, sha256: "0".repeat(64) }));
  const exact = spawnSync("git", ["hook", "run", "pre-commit"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(exact.status, exact.stdout + exact.stderr).toBe(0);
  // Staging a missing identity must fail before any checks use another version.
  git("add", "workbench/distribution.json");
  const missing = spawnSync("git", ["hook", "run", "pre-commit"], {
    cwd: consumer,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toMatch(/not installed/);
  expect(invoke("validate").status).not.toBe(0);
});

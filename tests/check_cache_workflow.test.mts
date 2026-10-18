import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "smol-toml";
import { addRecord } from "../src/records.ts";
import { synchronize } from "../src/sync.ts";
import { consumer, distribution, git } from "./fixtures/adoption.mjs";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("cached CLI checks validate changed records and scan sidecars without rerunning behavioral tests", async () => {
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", distribution);
  const root = await consumer();
  temporary.push(root);
  const config = join(root, "workbench/config.toml");
  const options = parse(readFileSync(config, "utf8"));
  const counter = (name: string, prepare = "") => [
    process.execPath,
    "-e",
    `${prepare}require('node:fs').appendFileSync('${name}', 'x')`,
  ];
  options.check = [
    { name: "Setup", role: "setup", command: counter("setup-counter") },
    {
      name: "Tests",
      role: "test",
      command: counter("test-counter", "require('node:fs').writeFileSync('built-output', 'application');"),
    },
    {
      name: "Docs",
      role: "docs",
      command: counter("docs-counter", "require('node:fs').readFileSync('built-output');"),
    },
    {
      name: "Secrets",
      role: "secret",
      command: [process.execPath, join(distribution, "bin/workbench.mjs"), "secrets", root],
    },
  ];
  writeFileSync(config, stringify(options));
  writeFileSync(join(root, ".gitignore"), "*-counter\n/built-output\n");
  synchronize(root);
  git(root, "add", ".");
  const run = () =>
    spawnSync(process.execPath, [join(distribution, "bin/workbench.mjs"), "pre-commit", root, "--verbose"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: undefined, GITHUB_ACTIONS: undefined, GITLAB_CI: undefined },
    });
  const first = run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  rmSync(join(root, "built-output"));
  const record = await addRecord(root, "TSK", "Follow up");
  synchronize(root);
  const second = run();
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(second.stdout, first.stdout + first.stderr).toContain("Reused 2/4 checks");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  expect(readFileSync(join(root, "docs-counter"), "utf8")).toBe("x");
  const original = readFileSync(record, "utf8");
  writeFileSync(record, original.replace("status: Planned", "status: Invalid"));
  const invalid = run();
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).toContain("validation failed");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
  writeFileSync(record, original);
  const supporting = record.slice(0, -3);
  mkdirSync(supporting);
  writeFileSync(join(supporting, "private.txt"), "-----BEGIN PRIVATE" + " KEY-----\n");
  const secret = run();
  expect(secret.status).not.toBe(0);
  expect(secret.stdout + secret.stderr).toContain("possible credentials");
  expect(readFileSync(join(root, "test-counter"), "utf8")).toBe("x");
});

import { gitNullConfiguration } from "../src/windows-host.ts";
import { BrowserScenario, webBrowserScenarios } from "./web-browser-scenarios.mjs";
import { chromium, type Browser, type Page } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

/** Browser evidence uses disposable projects; it never approves or edits the developer's checkout. */
async function main(): Promise<void> {
  const node = process.execPath;
  const repo = resolve(import.meta.dirname, "..");
  const { values } = parseArgs({
    options: { browser: { type: "string" }, output: { type: "string" }, scenario: { type: "string" } },
  });
  const executable = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const browserPath = values.browser
    ? resolve(values.browser)
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable))
        .find((path) => existsSync(path));
  if (!browserPath)
    throw new Error("Headless Shell is missing: run workbench tools install, then workbench check --role browser");
  const directory = values.output ? resolve(values.output) : mkdtempSync(join(tmpdir(), "workbench-web-browser-"));
  if (values.output) mkdirSync(directory);
  console.log(`Browser verification artifacts: ${directory}`);
  if (!values.scenario) {
    const results: unknown[] = [];
    for (const [index, scenario] of Object.values(BrowserScenario).entries()) {
      const output = join(directory, `scenario-${String(index + 1)}`);
      const runner = spawn(
        node,
        [fileURLToPath(import.meta.url), "--browser", browserPath, "--output", output, "--scenario", scenario],
        { stdio: "inherit" },
      );
      await new Promise<void>((resolve, reject) => {
        runner.once("error", reject);
        runner.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Browser scenario ${scenario} failed (${String(code)}, ${String(signal)}); artifacts: ${output}`,
              ),
            );
        });
      });
      const result: unknown = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
      results.push(result);
    }
    writeFileSync(join(directory, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
    console.log("Browser workflows passed. Artifacts: " + directory);
    return;
  }
  if (!Object.values(BrowserScenario).some((scenario) => scenario === values.scenario))
    throw new Error("Unknown browser scenario");

  const root = join(directory, "project");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_DISTRIBUTION_ROOT: repo,
    WORKBENCH_STORAGE_ROOT: join(directory, "cache"),
    WORKBENCH_STORAGE_EXTERNAL: "true",
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_EPHEMERAL_CHECKOUT: "0",
    GIT_CONFIG_GLOBAL: gitNullConfiguration,
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_DATA_DIRS: join(directory, "system"),
    RUSTUP_HOME: join(directory, "rustup"),
    UV_PYTHON_INSTALL_DIR: join(directory, "python"),
    DOCKER_HOST:
      process.platform === "win32"
        ? "npipe:////./pipe/workbench-browser-fixture"
        : `unix://${join(directory, "docker.sock")}`,
  };
  for (const key of [
    "WORKBENCH_CONTAINER_CHECKOUT",
    "WORKBENCH_BUILD_DIR",
    "WORKBENCH_DEPENDENCIES_DIR",
    "WORKBENCH_DIST_DIR",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    Reflect.deleteProperty(env, key);
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    env[`WORKBENCH_${kind}_HOME`] = join(directory, kind.toLowerCase());
  function git(where: string, ...args: string[]): string {
    const r = spawnSync(
      "git",
      [
        "-c",
        `core.hooksPath=${join(directory, "disabled-hooks")}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Web fixture",
        "-c",
        "user.email=web@example.invalid",
        "-C",
        where,
        ...args,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  function fixture(path: string, id: string): void {
    mkdirSync(join(path, "workbench/decisions"), { recursive: true });
    writeFileSync(
      join(path, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    writeFileSync(join(path, "workbench/projects.toml"), `[[project]]\nid="${id}"\npath="."\n`);
    writeFileSync(join(path, "workbench/CHARTER.md"), readFileSync(join(repo, "tests/fixtures/records/CHARTER.md")));
    writeFileSync(
      join(path, "workbench/decisions/ADR-00.md"),
      "---\nsummary: Preserve authoritative files.\nagent_instruction: Preserve human-readable records.\n---\n\n# ADR-0: Authoritative files\n\nKeep project documents in plain files.\n\n## Rationale\n\nUsers and agents can work with their own tools.\n",
    );
    git(path, "init", "-q");
    git(path, "add", ".");
    git(path, "commit", "-qm", "Fixture baseline");
    const registered = spawnSync(node, [join(repo, "bundle/main.cjs"), "project", "add", path], {
      cwd: path,
      env: { ...env, WORKBENCH_PROJECT_ROOT: path },
      encoding: "utf8",
    });
    assert.equal(registered.status, 0, registered.stderr);
  }

  fixture(root, "demo");
  const provider = join(directory, "provider");
  fixture(provider, "company");
  const synced = spawnSync(node, [join(repo, "bundle/main.cjs"), "sync"], {
    cwd: provider,
    env: { ...env, WORKBENCH_PROJECT_ROOT: provider },
    encoding: "utf8",
  });
  assert.equal(synced.status, 0, synced.stderr);
  git(provider, "add", "workbench");
  git(provider, "commit", "-qm", "Provider maps");
  const commit = git(provider, "rev-parse", "HEAD");
  for (const [type, name, body] of [
    [
      "tasks",
      "TSK-00.md",
      "---\nstatus: Planned\n---\n\n# TSK-0: Inspect the interface\n\nA distinctive search phrase. Read [the governing decision](../decisions/ADR-00.md).\n",
    ],
    [
      "experiments",
      "EXP-00.md",
      "---\nstatus: Inconclusive\nenvironment: null\n---\n\n# EXP-0: Interface experiment\n\nRetained observation.\n",
    ],
    ["environments", "ENV-00.md", "---\n{}\n---\n\n# ENV-0: Local environment\n"],
    [
      "citations",
      "CIT-00.json",
      '[{"id":"demo-CIT-0","type":"article","title":"Source document","author":[{"given":"Ada","family":"Lovelace"}],"issued":{"date-parts":[[2026]]},"container-title":"Engineering Journal","URL":"https://example.invalid/paper"}]\n',
    ],
    ["releases", "REL-00.yaml", "version: 0.1.0\nartifacts: []\n"],
  ] as const) {
    mkdirSync(join(root, "workbench", type), { recursive: true });
    writeFileSync(join(root, "workbench", type, name), body);
  }
  mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
  writeFileSync(join(root, "workbench/experiments/EXP-00/results.txt"), "Evidence retained for human review.\n");
  const adr = join(root, "workbench/decisions/ADR-00.md");
  const staged = readFileSync(adr, "utf8") + "\nStaged exact phrase.\n";
  writeFileSync(adr, staged);
  git(root, "add", "workbench");
  writeFileSync(adr, staged + "\nWorking-only phrase.\n");
  if (values.scenario === BrowserScenario.Sources) {
    const request = { source: provider, commit, collection: ".", visibility: "public" };
    const invoke = (operation: string, expected?: string) => {
      const result = spawnSync(node, [join(repo, "bundle/main.cjs"), "web-collection", operation], {
        cwd: root,
        env,
        input: JSON.stringify({ request, ...(expected ? { expected } : {}) }),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const proposal: unknown = JSON.parse(invoke("preview"));
    assert(proposal && typeof proposal === "object" && "digest" in proposal && typeof proposal.digest === "string");
    invoke("apply", proposal.digest);
  }
  const child = spawn(node, [join(repo, "bundle/main.cjs"), "serve", "--port", "0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x: Buffer) => {
    output = (output + x.toString()).slice(-65536);
  });
  child.stderr.on("data", (x: Buffer) => {
    output = (output + x.toString()).slice(-65536);
  });
  let browser: Browser | undefined, page: Page | undefined;
  const failures: unknown[] = [];
  let evidence: Record<string, unknown> | undefined;
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error(output || "No listener URL"));
      }, 15000);
      child.stdout.on("data", () => {
        const m = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      child.on("exit", (code) => {
        reject(Error(`Server exited ${String(code)}: ${output}`));
      });
    });
    const canonical = realpathSync.native(root);
    const identity = createHash("sha256")
      .update(process.platform === "win32" ? canonical.toLowerCase() : canonical)
      .digest("hex")
      .slice(0, 24);
    const base = `${origin}/p/${identity}`;
    writeFileSync(join(directory, "url"), base);
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("dialog", async (d) => {
      if (d.type() !== "beforeunload") errors.push(`Unexpected ${d.type()} dialog`);
      await d.accept();
    });
    for (const scenario of webBrowserScenarios({
      page,
      browser,
      root,
      provider,
      commit,
      adr,
      staged,
      directory,
      base,
      git,
    }).filter((scenario) => scenario.name === values.scenario)) {
      try {
        await scenario.run();
        console.log(`Browser scenario passed: ${scenario.name}`);
      } catch (error) {
        throw new Error(`Browser scenario failed: ${scenario.name}`, { cause: error });
      }
    }
    assert.deepEqual(errors, []);
    evidence = {
      passed: true,
      base,
      root,
      browser: browser.version(),
      node: process.versions.node,
      platform: process.platform,
      screenshots: readdirSync(directory).filter((name) => name.endsWith(".png")).length,
    };
  } catch (error) {
    failures.push(error);
    try {
      if (page) {
        writeFileSync(join(directory, "failure-page.html"), await page.content());
        await page.screenshot({ path: join(directory, "failure-page.png"), fullPage: true });
      }
    } catch (diagnostic) {
      failures.push(diagnostic);
    }
    try {
      writeFileSync(
        join(directory, "failure.txt"),
        String(error) +
          (error instanceof Error && error.cause
            ? `\nCause: ${error.cause instanceof Error ? (error.cause.stack ?? error.cause.message) : "unavailable"}`
            : "") +
          "\n" +
          output,
      );
    } catch (diagnostic) {
      failures.push(diagnostic);
    }
  } finally {
    try {
      if (browser) await browser.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        failures.push(new Error("fixture web service did not stop gracefully"));
        child.kill("SIGKILL");
      }, 15000);
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (failures.length) {
    try {
      writeFileSync(join(directory, "failure.txt"), failures.map(String).join("\n") + "\n" + output);
    } catch (diagnostic) {
      failures.push(diagnostic);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, `Browser verification failed: ${String(failures[0])}`, { cause: failures[0] });
  if (!evidence) throw new Error("browser verification produced no evidence");
  writeFileSync(join(directory, "result.json"), JSON.stringify(evidence, null, 2));
  console.log("Browser workflows passed. Artifacts: " + directory);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

import { BrowserEvidenceRun } from "../src/browser-evidence.ts";

import { createOwnedScratch } from "./owned-scratch.mjs";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { describeError, settleCleanup, combineFailures } from "./diagnostic-errors.mjs";
import { isMainScript } from "./script-entry.mjs";
import { gitNullConfiguration } from "../src/windows-host.ts";
import { BrowserScenario, webBrowserScenarios } from "./web-browser-scenarios.mjs";
import { chromium, type Browser, type Page } from "playwright-core";
import { spawnSync } from "node:child_process";
import { readdirSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";

/** Browser evidence uses disposable projects; it never approves or edits the developer's checkout. */
async function main(): Promise<void> {
  const node = process.execPath;
  const repo = resolve(import.meta.dirname, "..");
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      output: { type: "string" },
      scenario: { type: "string" },
      "keep-fixtures": { type: "boolean" },
    },
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
  const evidenceRun = values.output
    ? undefined
    : new BrowserEvidenceRun(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? repo);
  const requestedDirectory = values.output ? resolve(values.output) : evidenceRun?.directory;
  if (!requestedDirectory) throw new Error("Browser evidence directory is missing");
  if (values.output) mkdirSync(requestedDirectory);
  // Windows temporary paths may use an 8.3 alias; CLI preparation and the server must share one identity.
  const directory = realpathSync.native(requestedDirectory);
  console.log(`Browser verification artifacts: ${directory}`);
  if (!values.scenario) {
    const results: unknown[] = [];
    const scenarios: { name: string; script: string; args: string[]; output: string }[] = Object.values(
      BrowserScenario,
    ).map((scenario, index) => ({
      name: scenario,
      script: fileURLToPath(import.meta.url),
      args: ["--scenario", scenario],
      output: join(directory, `session-${String(index)}`),
    }));
    scenarios.push({
      name: "Screen-reader browser rehearsal",
      script: join(repo, "scripts/check-screen-reader.mjs"),
      args: ["--browser-only"],
      output: join(directory, `session-${String(scenarios.length)}`),
    });
    const cancellation = processCancellation();
    let drained = true;
    let failure: unknown;
    try {
      for (const { name, script, args, output } of scenarios) {
        try {
          const outcome = await runOwnedChild(
            node,
            [
              script,
              "--browser",
              browserPath,
              "--output",
              output,
              ...args,
              ...(values["keep-fixtures"] ? ["--keep-fixtures"] : []),
            ],
            {
              cwd: repo,
              env: process.env,
              ...(evidenceRun ? { owner: evidenceRun.owner } : {}),
              signal: cancellation.signal,
              inheritOutput: true,
              stopDescendantsOnExit: true,
            },
          ).catch((error: unknown) => {
            drained = false;
            throw error;
          });
          drained &&= !outcome.descendantsActive;
          const failure = processFailure(`Browser scenario ${name}; artifacts: ${output}`, outcome);
          if (failure) throw failure;
        } finally {
          // CI collects coverage/, not OS temporary directories. Retain compact evidence, never fixture caches.
          if (!values.output && process.env.CI && existsSync(output)) {
            const retained = join(repo, "coverage", "browser", basename(directory), basename(output));
            mkdirSync(retained, { recursive: true });
            for (const file of readdirSync(output, { withFileTypes: true }))
              if (file.isFile() && /\.(?:png|html|txt|json|log)$/.test(file.name))
                copyFileSync(join(output, file.name), join(retained, file.name));
          }
        }
        const result: unknown = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
        results.push(result);
      }
    } catch (error) {
      failure = error;
    } finally {
      await settleCleanup(
        [
          () => {
            cancellation.close();
          },
        ],
        failure,
        async (errors) => {
          const finalErrors = [...errors];
          let completionFailure: Error | undefined;
          try {
            if (evidenceRun && drained) await evidenceRun.finish(finalErrors);
          } catch (error) {
            completionFailure =
              error instanceof Error ? error : new Error("Browser evidence completion failed", { cause: error });
            finalErrors.push(error);
          }
          writeFileSync(
            join(directory, "result.json"),
            JSON.stringify(
              {
                passed: finalErrors.length === 0,
                results,
                ...(finalErrors.length ? { error: finalErrors.map(describeError).join("\n") } : {}),
              },
              null,
              2,
            ),
          );
          if (completionFailure !== undefined) throw completionFailure;
        },
      );
    }
    console.log("Browser workflows passed. Artifacts: " + directory);
    return;
  }
  if (!Object.values(BrowserScenario).some((scenario) => scenario === values.scenario))
    throw new Error("Unknown browser scenario");

  const scratch = createOwnedScratch(tmpdir(), "workbench-browser");
  const workspace = scratch.directory;
  let primary: unknown;
  try {
    const root = join(workspace, "project");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_DISTRIBUTION_ROOT: repo,
      WORKBENCH_STORAGE_ROOT: join(workspace, "cache"),
      WORKBENCH_STORAGE_EXTERNAL: "true",
      WORKBENCH_LOCAL_CONFIG_ROOT: root,
      WORKBENCH_EPHEMERAL_CHECKOUT: "0",
      GIT_CONFIG_GLOBAL: gitNullConfiguration,
      GIT_CONFIG_NOSYSTEM: "1",
      XDG_DATA_DIRS: join(workspace, "system"),
      RUSTUP_HOME: join(workspace, "rustup"),
      UV_PYTHON_INSTALL_DIR: join(workspace, "python"),
      DOCKER_HOST:
        process.platform === "win32"
          ? "npipe:////./pipe/workbench-browser-fixture"
          : `unix://${join(workspace, "docker.sock")}`,
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
      "WORKBENCH_COLLECTIONS_MATERIALIZED",
      "WORKBENCH_POLICY_REVIEW",
      "WORKBENCH_STORAGE_PROJECT",
      "WORKBENCH_PROFILE_CONTEXT",
      "WORKBENCH_WORKSPACE_CONTEXT",
    ])
      Reflect.deleteProperty(env, key);
    for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
      env[`WORKBENCH_${kind}_HOME`] = join(workspace, kind.toLowerCase());
    function git(where: string, ...args: string[]): string {
      const r = spawnSync(
        "git",
        [
          "-c",
          `core.hooksPath=${join(workspace, "disabled-hooks")}`,
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
        'schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[citations]\nlibrary_dir="library/citations"\n',
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
    const provider = join(workspace, "provider");
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
        "---\nstatus: Planned\n---\n\n# TSK-0: Inspect the interface\n\nA distinctive search phrase. Read [the governing decision](../decisions/ADR-00.md). Apply ADR-0.\n",
      ],
      [
        "experiments",
        "EXP-00.md",
        `---
status: Inconclusive
environment: null
---

# EXP-0: Interface experiment

Retained observation.

## Hypothesis

A complete record can preserve the context needed for review.

## Candidate and baseline

Compare the record page with the same file opened in an editor.

## Independent variable

The presentation used to inspect the file.

## Controls and correctness

Use identical record contents and retain every section.

## Workload

Inspect one short document and its supporting observation.

## Evaluation rule

Reject a presentation that loses record content.

## Execution provenance

This is an offline browser fixture, not a measured experiment.

## Evidence

[Retained observation](EXP-00/results.txt).

## Decision

Inconclusive; the fixture makes no experimental claim.
`,
      ],
      [
        "environments",
        "ENV-00.md",
        "---\n{}\n---\n\n# ENV-0: Local environment\n\n## Hardware configuration\n\nA fictional workstation for browser verification.\n\n## Limits\n\nThis fixture cannot establish measurement results.\n",
      ],
      [
        "citations",
        "CIT-00.json",
        '[{"id":"demo-CIT-0","type":"article","title":"Source document","author":[{"given":"Ada","family":"Lovelace"}],"issued":{"date-parts":[[2026]]},"accessed":{"date-parts":[[2026,11,8]]},"container-title":"Engineering Journal","URL":"https://example.invalid/paper"}]\n',
      ],
      [
        "releases",
        "REL-00.yaml",
        `id: demo-REL-0
version: 0.1.0
revision: "${git(root, "rev-parse", "HEAD")}"
tag: v0.1.0
released: 2026-01-01
yanked: false
notes:
  summary: Browser fixture release; no artifact is published.
  changes:
    - Exercise release metadata.
artifacts:
  - target: example
    file: example.txt
    url: https://example.invalid/releases/example.txt
    bytes: 1
    sha256: "${createHash("sha256").update("x").digest("hex")}"
`,
      ],
    ] as const) {
      mkdirSync(join(root, "workbench", type), { recursive: true });
      writeFileSync(join(root, "workbench", type, name), body);
    }
    mkdirSync(join(root, "workbench/experiments/EXP-00"), { recursive: true });
    writeFileSync(join(root, "workbench/experiments/EXP-00/results.txt"), "Evidence retained for human review.\n");
    mkdirSync(join(root, "workbench/citations/CIT-00"), { recursive: true });
    writeFileSync(
      join(root, "workbench/citations/CIT-00/acquisition.yaml"),
      "sources:\n  - kind: published\n    status: pending\n    landing-url: https://example.invalid/paper\n",
    );
    if (values.scenario === BrowserScenario.Compatibility)
      writeFileSync(
        join(root, "workbench/decisions/ADR-00.md"),
        "---\nsummary: Require direct build execution.\n---\n\n# ADR-0: Project execution\n\nRun build commands directly without a scheduler wrapper.\n",
      );
    if (values.scenario === BrowserScenario.Performance) {
      for (let index = 1; index <= 20; index++) {
        const number = index.toString(32).toUpperCase().padStart(2, "0");
        writeFileSync(
          join(root, `workbench/decisions/ADR-${number}.md`),
          `---\nsummary: Retain document context.\n---\n\n# ADR-${index.toString(32).toUpperCase()}: Navigation fixture ${number}\n\nA complete small project keeps related decisions available during document navigation.\n`,
        );
      }
    }
    // Browser workflows start with a valid consuming project, not partial presentation-only record stubs.
    for (const args of [["format", "--all", "--write"], ["sync"], ["validate"]]) {
      const prepared = spawnSync(node, [join(repo, "bundle/main.cjs"), ...args], { cwd: root, env, encoding: "utf8" });
      assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    }
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
    if (values.scenario === BrowserScenario.Compatibility) {
      const command = (where: string, args: string[]) => {
        const result = spawnSync(node, [join(repo, "bundle/main.cjs"), ...args], {
          cwd: where,
          env: { ...env, WORKBENCH_PROJECT_ROOT: where },
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
      };
      const localSource = join(workspace, "host-provider");
      fixture(localSource, "hostrules");
      writeFileSync(
        join(localSource, "workbench/decisions/ADR-00.md"),
        "---\nsummary: Host scheduler requirement.\nagent_instruction: Use the host scheduler for build commands.\n---\n\n# ADR-0: Host execution\n\nUse the host scheduler for build commands.\n",
      );
      const exported = join(workspace, "local-export");
      command(localSource, ["sync"]);
      command(localSource, [
        "collection",
        "export",
        exported,
        "--id",
        "hostrules",
        "--revision",
        "1",
        "--all",
        "--visibility",
        "public",
      ]);
      const checksum = createHash("sha256")
        .update(readFileSync(join(exported, "workbench/collection.toml")))
        .digest("hex");
      command(root, ["collection", "install", exported, "--scope", "local", "--sha256", checksum]);
      const local: unknown = JSON.parse(
        command(root, ["collection", "local", "review", "hostrules", "--scope", "local"]),
      );
      assert(local && typeof local === "object" && "digest" in local && typeof local.digest === "string");
      command(root, [
        "collection",
        "local",
        "approve",
        "hostrules",
        "--scope",
        "local",
        "--digest",
        local.digest,
        "--human-approved",
      ]);
      const status: unknown = JSON.parse(command(root, ["collection", "compatibility"]));
      assert(status && typeof status === "object" && "digest" in status && typeof status.digest === "string");
      const findings = join(directory, "findings.json");
      writeFileSync(
        findings,
        JSON.stringify([
          {
            summary: "Clarify scheduler wrapping",
            details: "The host requires scheduler admission; the project execution wording needs clarification.",
            records: ["demo:ADR-0", "hostrules:ADR-0"],
            proposed_resolution: "Permit the host scheduler to wrap project build commands.",
          },
        ]),
      );
      command(root, ["collection", "compatibility", "report", "--digest", status.digest, "--from", findings]);
    }
    const cancellation = processCancellation();
    const service = new AbortController();
    let output = "";
    let ready: ((origin: string) => void) | undefined;
    const startup = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const closed = runOwnedChild(node, [join(repo, "bundle/main.cjs"), "serve", "--port", "0"], {
      cwd: root,
      env,
      owner: scratch.owner,
      signal: AbortSignal.any([cancellation.signal, service.signal]),
      stopDescendantsOnExit: true,
      output: (stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-65536);
            const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
            if (match) ready?.(match[0]);
          });
      },
    });
    let browser: Browser | undefined, page: Page | undefined;
    const failures: unknown[] = [];
    let evidence: Record<string, unknown> | undefined;
    try {
      const origin = await Promise.race([
        startup,
        closed.then((outcome) => {
          throw (
            processFailure("Fixture server", outcome) ?? new Error(`Fixture server exited before listening: ${output}`)
          );
        }),
      ]);
      browser = await chromium.launch({ executablePath: browserPath, headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("dialog", async (d) => {
        if (d.type() !== "beforeunload") errors.push(`Unexpected ${d.type()} dialog`);
        await d.accept();
      });
      await page.goto(origin + "/projects");
      const destination = await page.getByRole("link", { name: "demo", exact: true }).getAttribute("href");
      assert(destination, "The registered project has a dashboard link");
      const base = new URL(destination, origin).href.replace(/\/$/, "");
      writeFileSync(join(directory, "url"), base);
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
        try {
          scratch.owner.markUncertain();
        } catch (ownership) {
          failures.push(ownership);
        }
      }
      service.abort();
      try {
        const outcome = await closed;
        if (outcome.error || outcome.descendantsActive)
          failures.push(outcome.error ?? new Error("Fixture descendants remain active"));
      } catch (cleanup) {
        failures.push(cleanup);
      }
      cancellation.close();
    }
    if (failures.length) {
      try {
        writeFileSync(join(directory, "failure.txt"), failures.map(describeError).join("\n") + "\n" + output);
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
  } catch (error) {
    primary = error;
  } finally {
    await settleCleanup(
      [
        () => {
          try {
            if (values["keep-fixtures"]) {
              scratch.owner.assertIdle();
              scratch.owner.release();
              console.log(`Retained browser fixtures: ${workspace}`);
            } else scratch.release();
          } catch (error) {
            try {
              evidenceRun?.owner.markUncertain();
            } catch (ownership) {
              throw combineFailures(error, ownership, "Fixture cleanup and evidence ownership failed");
            }
            throw error;
          }
        },
      ],
      primary,
      async (errors) => {
        const finalErrors = [...errors];
        let completionFailure: Error | undefined;
        try {
          await evidenceRun?.finish(finalErrors);
        } catch (error) {
          completionFailure =
            error instanceof Error ? error : new Error("Browser evidence completion failed", { cause: error });
          finalErrors.push(error);
        }
        if (finalErrors.length) {
          writeFileSync(join(directory, "failure.txt"), finalErrors.map(describeError).join("\n"));
          writeFileSync(
            join(directory, "result.json"),
            JSON.stringify({ passed: false, errors: finalErrors.map(describeError) }, null, 2),
          );
        }
        if (completionFailure !== undefined) throw completionFailure;
      },
    );
  }
}

if (isMainScript(import.meta.url)) await main();

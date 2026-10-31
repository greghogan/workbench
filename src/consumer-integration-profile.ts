import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "smol-toml";
import {
  ConsumerCommands,
  consumerCommandDiagnostics,
  type ConsumerCommandResult,
} from "./consumer-integration-runner.js";
import {
  consumerFault,
  consumerFaults,
  consumerSnapshot,
  configureConsumerCompiler,
  enableAdoptedApplicationChecks,
} from "./consumer-integration-fixtures.js";
import { CheckCancellation } from "./check-cancellation.js";
import { editToml } from "./toml-edit.js";
import type { VerifiedWorkbenchPackage } from "./package-verify.js";
import type { CheckRunResult } from "./check-report.js";
import type { ProcessLock } from "./process-lock.js";
import type { CompilerFamily } from "../scripts/compiler-catalog.mjs";
import type { ConsumerProfileReport, ConsumerReportRecorder } from "./consumer-integration-report.js";
import { consumerEnvironment, type ConsumerCache } from "./consumer-environment.js";
import { runConsumerSuite } from "./consumer-integration-scenarios.js";

export async function exerciseConsumerProfile(
  installed: VerifiedWorkbenchPackage,
  templates: string,
  options: { languages: string[]; compiler?: CompilerFamily },
  sharedCache: ConsumerCache,
  output: string,
  cancellation: CheckCancellation,
  owner: ProcessLock,
  report: ConsumerProfileReport,
  recorder: ConsumerReportRecorder,
): Promise<void> {
  await runConsumerSuite(
    { report, recorder, output, cancellation, owner, label: report.id },
    async (commands, scenarios) => {
      const logs = join(output, "commands");
      const scenario = (name: string, action: () => Promise<void>) => scenarios.run(name, action);
      const languages = options.languages;
      assert.ok(
        languages.length > 0 && new Set(languages).size === languages.length,
        "Select unique integration languages",
      );
      for (const language of languages)
        assert.ok(
          installed.languages.includes(language) && consumerFaults[language],
          `Unsupported integration language: ${language}`,
        );
      const env = consumerEnvironment(installed, sharedCache);
      const cli = (name: string, project: string, args: string[], failure = false, environment = env) =>
        commands.run(name, [process.execPath, installed.launcher, ...args], project, environment, failure);
      const git = (name: string, project: string, args: string[]) =>
        commands.capture(name, ["git", ...args], project, env);
      const charter = join(installed.directory, "tests/fixtures/records/CHARTER.md");
      const finishRecords = async (name: string, project: string) => {
        if (options.compiler) configureConsumerCompiler(project, installed.directory, options.compiler);
        cpSync(charter, join(project, "workbench/CHARTER.md"));
        writeFileSync(join(project, ".workbench-consumer-fixture"), "disposable integration fixture\n");
        await cli(`${name}-sync`, project, ["sync"]);
        await cli(`${name}-validate`, project, ["validate"]);
      };
      const check = async (name: string, project: string, args: string[], fail = false, environment = env) => {
        const path = join(output, `${name}.json`);
        await cli(
          name,
          project,
          ["check", ...args, "--environment", "native", "--no-cache", "--report", path],
          fail,
          environment,
        );
        const result = JSON.parse(readFileSync(path, "utf8")) as { success: boolean; runs: CheckRunResult[] };
        assert.equal(result.success, !fail, `${name}: check outcome`);
        const checks = result.runs.flatMap((run) => run.checks);
        assert.ok(
          checks.some((entry) => entry.role === "test" || entry.role === "coverage"),
          `${name}: application tests must run`,
        );
        if (fail)
          assert.ok(
            checks.some((entry) => entry.status === "failed" && ["test", "coverage"].includes(entry.role)),
            `${name}: the application test must reject the behavioral fault`,
          );
        else
          assert.ok(
            checks.length > 0 && checks.every((entry) => entry.status === "passed"),
            `${name}: incomplete check gate`,
          );
        for (const [index, run] of result.runs.entries())
          if (run.logs) cpSync(run.logs, join(output, `${name}-logs-${String(index)}`), { recursive: true });
      };
      for (const language of languages) {
        const project = join(installed.temporary, `journey-${language} space 雪`),
          application = "application";
        await scenario(`${language}-new-project`, async () => {
          const cold: NodeJS.ProcessEnv = {
            ...env,
            WORKBENCH_CACHE_HOME: join(installed.temporary, `${language}-empty-cache`),
          };
          const guard = join(installed.temporary, "deny-network.cjs");
          writeFileSync(
            guard,
            "require('node:net').Socket.prototype.connect = function () { throw new Error('Initialization attempted network access'); };\n",
          );
          cold.NODE_OPTIONS = `--require ${JSON.stringify(guard)}`;
          await cli(
            `${language}-plan`,
            installed.temporary,
            ["init", project, "--language", language, "--root", application, "--plan"],
            false,
            cold,
          );
          assert.equal(existsSync(project), false, "Preview must not create the destination");
          await cli(
            `${language}-init`,
            installed.temporary,
            ["init", project, "--language", language, "--root", application],
            false,
            cold,
          );
          assert.equal(
            existsSync(join(installed.temporary, `${language}-empty-cache`, "toolchains")),
            false,
            "Initialization must not install toolchains",
          );
          await finishRecords(language, project);
          await cli(`${language}-tools`, project, [
            "tools",
            "install",
            "--path",
            application,
            ...(language === "rust" ? ["--exclude-tool", "miri"] : []),
          ]);
          // Ruby's language-server transport must accept the Unicode project path even on a C-locale host.
          await check(
            `${language}-gate`,
            project,
            ["--stage", "commit"],
            false,
            language === "ruby" ? { ...env, LANG: "C", LC_ALL: "C" } : env,
          );
          await cli(`${language}-hooks`, project, ["init", "--adopt", "--hooks"]);
          await git(`${language}-stage`, project, ["add", "--all"]);
          await commands.run(
            `${language}-approve-fixture`,
            [
              process.execPath,
              "-e",
              "require(process.argv[1]).approveConsumerFixture(process.argv[2],process.argv[3]);",
              join(installed.directory, "bundle/consumer.cjs"),
              project,
              charter,
            ],
            project,
            env,
          );
          await git(`${language}-commit`, project, ["commit", "--quiet", "-m", "Create integration fixture"]);
          assert.match(await git(`${language}-head`, project, ["rev-parse", "HEAD"]), /^[a-f0-9]{40,64}\s*$/);
          const fault = consumerFault(language, join(project, application));
          writeFileSync(fault.path, fault.broken);
          try {
            await check(`${language}-broken`, project, ["--role", "test"], true);
          } finally {
            writeFileSync(fault.path, fault.original);
          }
          await check(`${language}-recovered`, project, ["--role", "test"]);
          const tracked = (await git(`${language}-tracked`, project, ["ls-files", "-z"])).split("\0").filter(Boolean);
          const before = consumerSnapshot(project, tracked);
          const rejected = await cli(
            `${language}-repeat`,
            project,
            ["init", "--language", language, "--root", application],
            true,
          );
          assert.match(consumerCommandDiagnostics(rejected).stderr, /already registered/);
          assert.deepEqual(consumerSnapshot(project, tracked), before, "Repeated init must preserve user files");
          const offline = {
            ...env,
            WORKBENCH_OFFLINE: "1",
            UV_OFFLINE: "1",
            CARGO_NET_OFFLINE: "true",
            GOPROXY: "off",
            GOSUMDB: "off",
            COMPOSER_DISABLE_NETWORK: "1",
            MAVEN_ARGS: "--offline",
            NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
          };
          const configPath = join(project, "workbench/config.toml");
          const configText = readFileSync(configPath, "utf8");
          const config = parse(configText);
          (config.checks as Record<string, unknown>).pass_environment = [
            "NODE_OPTIONS",
            "UV_OFFLINE",
            "CARGO_NET_OFFLINE",
            "GOPROXY",
            "GOSUMDB",
            "COMPOSER_DISABLE_NETWORK",
            "MAVEN_ARGS",
          ];
          writeFileSync(configPath, editToml(configText, config));
          await check(`${language}-offline`, project, ["--role", "test"], false, offline);
        });
        await scenario(`${language}-adoption`, async () => {
          const adopted = join(installed.temporary, `adopt-${language}`);
          mkdirSync(adopted);
          await git(`${language}-existing-git`, adopted, ["init", "--quiet"]);
          const metadata = parse(
            readFileSync(join(installed.directory, `languages/${language}/config.toml`), "utf8"),
          ) as {
            starter: string[];
          };
          for (const path of metadata.starter.filter((path) => !path.startsWith("workbench/"))) {
            const target = join(adopted, path);
            mkdirSync(dirname(target), { recursive: true });
            cpSync(join(templates, `consumer-${language}`, path), target);
          }
          writeFileSync(
            join(adopted, "AGENTS.md"),
            "# Existing project guidance\n\nPreserve this exact human-authored fixture guidance.\n",
          );
          writeFileSync(
            join(adopted, "existing-check.cjs"),
            "require('node:fs').writeFileSync('existing-check-ran', 'passed');\n",
          );
          await git(`${language}-existing-hook`, adopted, ["config", "core.hooksPath", ".existing-hooks"]);
          const assets = metadata.starter.filter((path) => !path.startsWith("workbench/"));
          const before = consumerSnapshot(adopted, assets);
          await cli(`${language}-adopt`, adopted, [
            "init",
            "--adopt",
            "--language",
            language,
            "--check",
            "node existing-check.cjs",
          ]);
          assert.deepEqual(
            consumerSnapshot(adopted, assets),
            before,
            "Adoption must preserve application files and locks",
          );
          assert.ok(
            readFileSync(join(adopted, "AGENTS.md"), "utf8").startsWith(
              "# Existing project guidance\n\nPreserve this exact human-authored fixture guidance.\n",
            ),
          );
          assert.equal(
            (await git(`${language}-preserved-hook`, adopted, ["config", "core.hooksPath"])).trim(),
            ".existing-hooks",
          );
          await finishRecords(`${language}-adopt`, adopted);
          enableAdoptedApplicationChecks(adopted, installed.directory, language);
          await cli(`${language}-adopt-tools`, adopted, [
            "tools",
            "install",
            "--path",
            ".",
            ...(language === "rust" ? ["--exclude-tool", "miri"] : []),
          ]);
          await check(`${language}-adopt-check`, adopted, ["--role", "test"]);
          const fault = consumerFault(language, adopted);
          writeFileSync(fault.path, fault.broken);
          try {
            await check(`${language}-adopt-broken`, adopted, ["--role", "test"], true);
          } finally {
            writeFileSync(fault.path, fault.original);
          }
          await check(`${language}-adopt-recovered`, adopted, ["--role", "test"]);
          assert.equal(readFileSync(join(adopted, "existing-check-ran"), "utf8"), "passed");
        });
      }
      for (const pair of [
        ["typescript", "go"],
        ["javascript", "typescript"],
        ["c", "cpp"],
      ]) {
        if (!pair.every((language) => languages.includes(language))) continue;
        const name = pair.join("-"),
          project = join(installed.temporary, `mixed-${name}`);
        await scenario(`mixed-${name}`, async () => {
          await cli(`${name}-records`, installed.temporary, ["init", project, "--records-only"]);
          for (const language of pair)
            await cli(`${name}-${language}-init`, project, [
              "init",
              "--language",
              language,
              "--root",
              `components/${language}`,
            ]);
          await finishRecords(name, project);
          await check(`${name}-mixed-check`, project, ["--role", "test"]);
        });
      }
      await scenario("concurrent-gates-and-cancellation", async () => {
        const project = join(installed.temporary, "concurrent-consumer");
        await cli("concurrent-init", installed.temporary, ["init", project, "--records-only"]);
        await finishRecords("concurrent", project);
        writeFileSync(
          join(project, "wait.cjs"),
          `const fs = require('node:fs');
if (!fs.existsSync('release')) { fs.writeFileSync('ready', 'ready'); setInterval(() => {}, 1000); }
else fs.writeFileSync('retried', 'passed');\n`,
        );
        writeFileSync(
          join(project, "workbench/automation.toml"),
          `[[check]]\nname = "Fixture waiting command"\nrole = "test"\nrequires_setup = false\ncommand = ["node", "wait.cjs"]\n`,
        );
        const stopFirst = new AbortController();
        const firstCommands = new ConsumerCommands(logs, AbortSignal.any([cancellation.signal, stopFirst.signal]), {
          owner,
          observe: (entry) => {
            if (!commands.results.includes(entry)) commands.results.push(entry);
            recorder.save();
          },
        });
        const invocation = [process.execPath, installed.launcher, "check", "--no-cache"];
        const first = firstCommands.run("cancelled-gate", invocation, project, env).catch((error: unknown) => error);
        let second: Promise<ConsumerCommandResult> | undefined;
        const waitUntil = async (condition: () => boolean) => {
          const deadline = Date.now() + 30000;
          while (!condition()) {
            cancellation.checkpoint();
            assert.ok(Date.now() < deadline, "Consumer synchronization watchdog expired");
            await delay(10);
          }
        };
        try {
          await waitUntil(() => existsSync(join(project, "ready")));
          second = commands.run("waiting-second-gate", invocation, project, env);
          // Attach rejection immediately while the first gate still owns the checkout.
          void second.catch(() => undefined);
          await waitUntil(() =>
            readdirSync(logs)
              .filter((name) => name.endsWith("waiting-second-gate.stderr.log"))
              .some((name) => readFileSync(join(logs, name), "utf8").includes("Waiting for another check gate")),
          );
          stopFirst.abort();
          await first;
          if (process.platform === "win32") assert.notEqual(firstCommands.results[0]?.status, 0);
          else
            assert.equal(
              firstCommands.results[0]?.status,
              130,
              "The cancelled gate must drain and report cancellation",
            );
          writeFileSync(join(project, "release"), "release");
          await second;
          assert.equal(readFileSync(join(project, "retried"), "utf8"), "passed");
          await cli("concurrent-retry", project, ["check", "--no-cache"]);
        } finally {
          stopFirst.abort();
          writeFileSync(join(project, "release"), "release");
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
      });
    },
  );
}

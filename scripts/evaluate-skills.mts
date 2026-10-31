import { gitNullConfiguration } from "../src/windows-host.ts";
import { captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { processFailure } from "./process-outcome.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cases, evaluationName, command, verifyOutcome, prepare, snapshot } from "./skill-evaluation-cases.mjs";
import { record, required, string } from "./values.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" }, model: { type: "string" }, help: { type: "boolean" } },
});
const [harness, ...selected] = positionals;
const requestedNames = selected.length ? [...new Set(selected)] : Object.keys(cases);
if (
  values.help ||
  (harness !== "codex" && harness !== "claude") ||
  requestedNames.some((name) => !Object.hasOwn(cases, name)) ||
  !values.output
) {
  console.log(
    "Usage: node scripts/evaluate-skills.mjs codex|claude [SCENARIO ...] --output NEW_DIRECTORY [--model MODEL]",
  );
  console.log("Scenarios: " + Object.keys(cases).join(", "));
  console.log(
    "Runs real model inference; credentials are required. Output retains final replies, diffs, and grading results for review.",
  );
  process.exit(values.help ? 0 : 2);
}

const names = requestedNames.map(evaluationName);
const selectedHarness = harness;
const requestedModel = values.model?.length ? values.model : undefined;
const distribution = resolve(import.meta.dirname, "..");
const output = resolve(values.output);
if (existsSync(output)) throw new Error("evaluation output directory must not already exist");
const codexAuth = join(
  process.env.CODEX_HOME?.length ? process.env.CODEX_HOME : join(homedir(), ".codex"),
  "auth.json",
);
if (harness === "codex" && !process.env.OPENAI_API_KEY && !existsSync(codexAuth))
  throw new Error("Codex evaluation requires OPENAI_API_KEY or an existing Codex auth.json");
if (harness === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error(
    "Claude evaluation requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; user settings and keychains are not imported",
  );
mkdirSync(output, { recursive: true, mode: 0o700 });
const interruption = { occurred: false };

async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, reply: string): Promise<string> {
  const cancellation = processCancellation();
  const timeout = AbortSignal.timeout(300000);
  try {
    const outcome = await captureOwnedChild(
      selectedHarness,
      [...args],
      {
        cwd,
        env,
        signal: AbortSignal.any([cancellation.signal, timeout]),
      },
      16 * 1024 * 1024,
    );
    interruption.occurred ||= cancellation.signal.aborted;
    const failure = processFailure(
      `${selectedHarness}${timeout.aborted ? " (five-minute timeout)" : ""}`,
      outcome,
      outcome,
    );
    if (failure) throw failure;
    if (harness === "claude") {
      const result = record(JSON.parse(outcome.stdout), "Invalid Claude evaluation result");
      const replyText = result.result === undefined ? "" : string(result.result, "Invalid Claude result text");
      if (result.is_error) throw new Error(replyText || "Claude evaluation failed");
      writeFileSync(reply, replyText);
      return (
        Object.keys(result.modelUsage === undefined ? {} : record(result.modelUsage, "Invalid model usage")).join(
          ", ",
        ) ||
        (requestedModel ?? "harness default (not reported)")
      );
    }
    return /^model: *([^\r\n]+)\r?\n/m.exec(outcome.stderr)?.[1] ?? requestedModel ?? "harness default (not reported)";
  } finally {
    cancellation.close();
  }
}

let failed = false;
for (const name of names) {
  if (interruption.occurred) break;
  const temporary = mkdtempSync(join(tmpdir(), "workbench-skill-evaluation-"));
  const root = join(temporary, "project");
  const testHome = join(temporary, "home");
  const resultDirectory = join(output, name);
  mkdirSync(root);
  mkdirSync(testHome);
  mkdirSync(resultDirectory);
  const env: NodeJS.ProcessEnv = {
    PATH: [join(distribution, "bin"), process.env.PATH ?? ""].join(delimiter),
    HOME: testHome,
    USERPROFILE: testHome,
    TMPDIR: temporary,
    LANG: "C.UTF-8",
    CODEX_HOME: join(testHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(testHome, ".claude"),
    XDG_CONFIG_HOME: join(testHome, "config"),
    WORKBENCH_CONFIG_HOME: join(testHome, "workbench-config"),
    XDG_DATA_HOME: join(testHome, "data"),
    XDG_CACHE_HOME: join(testHome, "cache"),
    XDG_STATE_HOME: join(testHome, "state"),
    GIT_CONFIG_GLOBAL: gitNullConfiguration,
    GIT_CONFIG_NOSYSTEM: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    npm_config_cache: join(testHome, "npm-cache"),
  };
  mkdirSync(required(env.CODEX_HOME, "Missing Codex home"), { mode: 0o700 });
  mkdirSync(required(env.CLAUDE_CONFIG_DIR, "Missing Claude home"), { mode: 0o700 });
  if (harness === "codex") {
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    else cpSync(codexAuth, join(required(env.CODEX_HOME, "Missing Codex home"), "auth.json"), { dereference: true });
  } else {
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
      if (process.env[key]) env[key] = process.env[key];
  }
  const report: {
    case: string;
    harness: string;
    requestedModel: string;
    started: string;
    skillsSha256: string;
    assessmentPrompt: string;
    harnessVersion?: string;
    fixtureSha256?: string;
    prompt?: string;
    model?: string;
    result?: string;
    error?: string;
    finished?: string;
  } = {
    case: name,
    harness,
    requestedModel: requestedModel ?? "harness default",
    started: new Date().toISOString(),
    skillsSha256: snapshot(join(distribution, "skills")),
    assessmentPrompt: cases[name].review,
  };
  let before: ReturnType<typeof prepare> | undefined;
  try {
    report.harnessVersion = command(root, env, harness, ["--version"]).trim();
    before = prepare(root, distribution, env, name);
    report.fixtureSha256 = before.snapshot;
    console.log(`${name}: prepared; running ${harness}`);
    const reply = join(resultDirectory, "reply.md");
    const skill = cases[name].skill;
    const prompt = `${skill ? `Use ${harness === "codex" ? "$" : "/"}${skill}. ` : ""}${cases[name].request} ${name === "commit-push" ? "Push only to the configured disposable local origin." : "Do not stage or commit."} Work only in this disposable project.`;
    report.prompt = prompt;
    const args =
      harness === "codex"
        ? [
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "workspace-write",
            "-c",
            'approval_policy="never"',
            "-c",
            "sandbox_workspace_write.network_access=true",
            "--output-last-message",
            reply,
          ]
        : [
            "--print",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--permission-mode",
            "dontAsk",
            "--tools",
            "Read,Edit,Write,Bash,Glob,Grep,Skill",
            "--allowedTools",
            "Read,Edit,Write,Bash,Glob,Grep,Skill",
            "--setting-sources",
            "project",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
          ];
    if (harness === "codex" && name === "commit-push") args.push("--add-dir", join(root, ".git"));
    if (requestedModel) args.push("--model", requestedModel);
    args.push("--", prompt);
    report.model = await run(args, root, env, reply);
    if (!existsSync(reply) || !readFileSync(reply, "utf8").trim()) throw new Error("agent produced no final reply");
    for (const directory of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
      const history = readdirSync(required(directory, "Missing harness home"), {
        recursive: true,
        encoding: "utf8",
      }).filter((path) => /(^|\/)(history\.jsonl|sessions\/.*\.jsonl|projects\/.*\.jsonl)$/.test(path));
      if (history.length) throw new Error("harness retained conversation history in its disposable home");
    }
    verifyOutcome(root, env, name, before);
    report.result = "workflow contract checks passed; qualitative assessment not performed";
    console.log(`${name}: ${report.result}`);
  } catch (error) {
    failed = true;
    report.result = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`${name}: ${report.error}`);
    // Preparation or harness failures do not provide workflow evidence for later cases.
    if (!report.model) break;
  } finally {
    try {
      if (before) {
        writeFileSync(join(resultDirectory, "changes.diff"), command(root, env, "git", ["diff", before.head]));
        writeFileSync(join(resultDirectory, "status.txt"), command(root, env, "git", ["status", "--short"]));
        // Retain new tests and records too; a Git diff alone omits untracked files.
        for (const path of command(root, env, "git", ["ls-files", "--others", "--exclude-standard", "-z"])
          .split("\0")
          .filter(Boolean)) {
          const target = join(resultDirectory, "untracked", path);
          mkdirSync(join(target, ".."), { recursive: true });
          cpSync(join(root, path), target, { dereference: false });
        }
      }
      report.finished = new Date().toISOString();
      writeFileSync(join(resultDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
console.log(`Evaluation evidence: ${output}`);
process.exitCode = interruption.occurred ? 130 : failed ? 1 : 0;

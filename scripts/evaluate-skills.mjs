import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cases, command, grade, prepare, snapshot } from "./skill-evaluation-cases.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" }, model: { type: "string" }, help: { type: "boolean" } },
});
const [harness, ...selected] = positionals;
const names = selected.length ? [...new Set(selected)] : Object.keys(cases);
if (
  values.help ||
  !["codex", "claude"].includes(harness) ||
  names.some((name) => !Object.hasOwn(cases, name)) ||
  !values.output
) {
  console.log(
    "Usage: node scripts/evaluate-skills.mjs codex|claude [review|refactors|dependencies|audit ...] --output NEW_DIRECTORY [--model MODEL]",
  );
  console.log(
    "Runs real model inference; credentials are required. Output retains final replies, diffs, and grading results for review.",
  );
  process.exit(values.help ? 0 : 2);
}

const distribution = resolve(import.meta.dirname, "..");
const output = resolve(values.output);
if (existsSync(output)) throw new Error("evaluation output directory must not already exist");
const codexAuth = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
if (harness === "codex" && !process.env.OPENAI_API_KEY && !existsSync(codexAuth))
  throw new Error("Codex evaluation requires OPENAI_API_KEY or an existing Codex auth.json");
if (harness === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error(
    "Claude evaluation requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; user settings and keychains are not imported",
  );
mkdirSync(output, { recursive: true, mode: 0o700 });
let interrupted = false;

function run(args, cwd, env, reply) {
  return new Promise((done, reject) => {
    const child = spawn(harness, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let reportedModel;
    let timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const interrupt = () => {
      interrupted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 300000);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      const next = stderr + data;
      reportedModel ??= /^model: *([^\r\n]+)\r?\n/m.exec(next)?.[1];
      stderr = next.slice(-6000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      stop();
      if (code !== 0) {
        reject(new Error(`${harness}: ${timedOut ? "five-minute timeout" : (signal ?? code)}\n${stderr}`));
        return;
      }
      try {
        if (harness === "claude") {
          const result = JSON.parse(stdout);
          if (result.is_error) throw new Error(result.result || "Claude evaluation failed");
          writeFileSync(reply, result.result || "");
          done(Object.keys(result.modelUsage || {}).join(", ") || values.model || "harness default (not reported)");
        } else done(reportedModel || values.model || "harness default (not reported)");
      } catch (error) {
        reject(error);
      }
    });
  });
}

let failed = false;
for (const name of names) {
  if (interrupted) break;
  const temporary = mkdtempSync(join(tmpdir(), "workbench-skill-evaluation-"));
  const root = join(temporary, "project");
  const testHome = join(temporary, "home");
  const resultDirectory = join(output, name);
  mkdirSync(root);
  mkdirSync(testHome);
  mkdirSync(resultDirectory);
  const env = {
    PATH: `${join(root, ".workbench/bin")}:${process.env.PATH}`,
    HOME: testHome,
    USERPROFILE: testHome,
    TMPDIR: temporary,
    LANG: "C.UTF-8",
    CODEX_HOME: join(testHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(testHome, ".claude"),
    XDG_CONFIG_HOME: join(testHome, "config"),
    XDG_DATA_HOME: join(testHome, "data"),
    XDG_CACHE_HOME: join(testHome, "cache"),
    XDG_STATE_HOME: join(testHome, "state"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    npm_config_cache: join(testHome, "npm-cache"),
  };
  mkdirSync(env.CODEX_HOME, { mode: 0o700 });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  if (harness === "codex") {
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    else cpSync(codexAuth, join(env.CODEX_HOME, "auth.json"), { dereference: true });
  } else {
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
      if (process.env[key]) env[key] = process.env[key];
  }
  const report = {
    case: name,
    harness,
    requestedModel: values.model || "harness default",
    started: new Date().toISOString(),
    skillsSha256: snapshot(join(distribution, "skills")),
    manualReview: cases[name].review,
  };
  let before;
  try {
    report.harnessVersion = command(root, env, harness, ["--version"]).trim();
    before = prepare(root, distribution, env, name);
    report.fixtureSha256 = before.snapshot;
    console.log(`${name}: prepared; running ${harness}`);
    const reply = join(resultDirectory, "reply.md");
    const prompt = `Use ${harness === "codex" ? "$" : "/"}${cases[name].skill}. ${cases[name].request} Do not stage or commit. Work only in this disposable project. This evaluation is already running under the host resource scheduler; run its small fixture checks directly.`;
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
    if (values.model) args.push("--model", values.model);
    args.push("--", prompt);
    report.model = await run(args, root, env, reply);
    if (!existsSync(reply) || !readFileSync(reply, "utf8").trim()) throw new Error("agent produced no final reply");
    for (const directory of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
      const history = readdirSync(directory, { recursive: true }).filter((path) =>
        /(^|\/)(history\.jsonl|sessions\/.*\.jsonl|projects\/.*\.jsonl)$/.test(path),
      );
      if (history.length) throw new Error("harness retained conversation history in its disposable home");
    }
    grade(root, env, name, before);
    report.result = "objective checks passed; review reply and diff against manualReview";
    console.log(`${name}: ${report.result}`);
  } catch (error) {
    failed = true;
    report.result = "failed";
    report.error = error.message;
    console.error(`${name}: ${error.message}`);
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
process.exitCode = interrupted ? 130 : failed ? 1 : 0;

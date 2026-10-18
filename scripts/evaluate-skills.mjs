// Generated from evaluate-skills.mts; edit the TypeScript source.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cases, command, grade, prepare, snapshot } from "./skill-evaluation-cases.mjs";
import { isRecord, record, required, string, errorFrom } from "./values.mjs";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" }, model: { type: "string" }, help: { type: "boolean" } }
});
const [harness, ...selected] = positionals;
const requestedNames = selected.length ? [...new Set(selected)] : Object.keys(cases);
if (values.help || harness !== "codex" && harness !== "claude" || requestedNames.some((name) => !Object.hasOwn(cases, name)) || !values.output) {
  console.log(
    "Usage: node scripts/evaluate-skills.mjs codex|claude [review|refactors|dependencies|audit ...] --output NEW_DIRECTORY [--model MODEL]"
  );
  console.log(
    "Runs real model inference; credentials are required. Output retains final replies, diffs, and grading results for review."
  );
  process.exit(values.help ? 0 : 2);
}
const names = requestedNames.map((name) => {
  if (name !== "review" && name !== "refactors" && name !== "dependencies" && name !== "audit")
    throw new Error(`Unknown evaluation: ${name}`);
  return name;
});
const selectedHarness = harness;
const requestedModel = values.model?.length ? values.model : void 0;
const distribution = resolve(import.meta.dirname, "..");
const output = resolve(values.output);
if (existsSync(output)) throw new Error("evaluation output directory must not already exist");
const codexAuth = join(
  process.env.CODEX_HOME?.length ? process.env.CODEX_HOME : join(homedir(), ".codex"),
  "auth.json"
);
if (harness === "codex" && !process.env.OPENAI_API_KEY && !existsSync(codexAuth))
  throw new Error("Codex evaluation requires OPENAI_API_KEY or an existing Codex auth.json");
if (harness === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
  throw new Error(
    "Claude evaluation requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; user settings and keychains are not imported"
  );
mkdirSync(output, { recursive: true, mode: 448 });
const interruption = { occurred: false };
function run(args, cwd, env, reply) {
  return new Promise((done, reject) => {
    const child = spawn(selectedHarness, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let reportedModel;
    let timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!isRecord(error) || error.code !== "ESRCH") throw error;
      }
    };
    const interrupt = () => {
      interruption.occurred = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 3e5);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      const next = stderr + data;
      reportedModel ??= /^model: *([^\r\n]+)\r?\n/m.exec(next)?.[1];
      stderr = next.slice(-6e3);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      stop();
      if (code !== 0) {
        reject(
          new Error(`${String(harness)}: ${String(timedOut ? "five-minute timeout" : signal ?? code)}
${stderr}`)
        );
        return;
      }
      try {
        if (harness === "claude") {
          const result = record(JSON.parse(stdout), "Invalid Claude evaluation result");
          const replyText = result.result === void 0 ? "" : string(result.result, "Invalid Claude result text");
          if (result.is_error) throw new Error(replyText || "Claude evaluation failed");
          writeFileSync(reply, replyText);
          done(
            Object.keys(result.modelUsage === void 0 ? {} : record(result.modelUsage, "Invalid model usage")).join(
              ", "
            ) || (requestedModel ?? "harness default (not reported)")
          );
        } else done(reportedModel ?? requestedModel ?? "harness default (not reported)");
      } catch (error) {
        reject(errorFrom(error));
      }
    });
  });
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
  const env = {
    PATH: `${join(distribution, "bin")}:${String(process.env.PATH)}`,
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
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    npm_config_cache: join(testHome, "npm-cache")
  };
  mkdirSync(required(env.CODEX_HOME, "Missing Codex home"), { mode: 448 });
  mkdirSync(required(env.CLAUDE_CONFIG_DIR, "Missing Claude home"), { mode: 448 });
  if (harness === "codex") {
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    else cpSync(codexAuth, join(required(env.CODEX_HOME, "Missing Codex home"), "auth.json"), { dereference: true });
  } else {
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
      if (process.env[key]) env[key] = process.env[key];
  }
  const report = {
    case: name,
    harness,
    requestedModel: requestedModel ?? "harness default",
    started: (/* @__PURE__ */ new Date()).toISOString(),
    skillsSha256: snapshot(join(distribution, "skills")),
    manualReview: cases[name].review
  };
  let before;
  try {
    report.harnessVersion = command(root, env, harness, ["--version"]).trim();
    before = prepare(root, distribution, env, name);
    report.fixtureSha256 = before.snapshot;
    console.log(`${name}: prepared; running ${harness}`);
    const reply = join(resultDirectory, "reply.md");
    const prompt = `Use ${harness === "codex" ? "$" : "/"}${cases[name].skill}. ${cases[name].request} Do not stage or commit. Work only in this disposable project.`;
    report.prompt = prompt;
    const args = harness === "codex" ? [
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
      reply
    ] : [
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
      '{"mcpServers":{}}'
    ];
    if (requestedModel) args.push("--model", requestedModel);
    args.push("--", prompt);
    report.model = await run(args, root, env, reply);
    if (!existsSync(reply) || !readFileSync(reply, "utf8").trim()) throw new Error("agent produced no final reply");
    for (const directory of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
      const history = readdirSync(required(directory, "Missing harness home"), {
        recursive: true,
        encoding: "utf8"
      }).filter((path) => /(^|\/)(history\.jsonl|sessions\/.*\.jsonl|projects\/.*\.jsonl)$/.test(path));
      if (history.length) throw new Error("harness retained conversation history in its disposable home");
    }
    grade(root, env, name, before);
    report.result = "objective checks passed; review reply and diff against manualReview";
    console.log(`${name}: ${report.result}`);
  } catch (error) {
    failed = true;
    report.result = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`${name}: ${report.error}`);
    if (!report.model) break;
  } finally {
    try {
      if (before) {
        writeFileSync(join(resultDirectory, "changes.diff"), command(root, env, "git", ["diff", before.head]));
        writeFileSync(join(resultDirectory, "status.txt"), command(root, env, "git", ["status", "--short"]));
        for (const path of command(root, env, "git", ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
          const target = join(resultDirectory, "untracked", path);
          mkdirSync(join(target, ".."), { recursive: true });
          cpSync(join(root, path), target, { dereference: false });
        }
      }
      report.finished = (/* @__PURE__ */ new Date()).toISOString();
      writeFileSync(join(resultDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
console.log(`Evaluation evidence: ${output}`);
process.exitCode = interruption.occurred ? 130 : failed ? 1 : 0;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImV2YWx1YXRlLXNraWxscy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBjcFN5bmMsIGV4aXN0c1N5bmMsIG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IGNhc2VzLCBjb21tYW5kLCBncmFkZSwgcHJlcGFyZSwgc25hcHNob3QgfSBmcm9tIFwiLi9za2lsbC1ldmFsdWF0aW9uLWNhc2VzLm1qc1wiO1xuaW1wb3J0IHsgaXNSZWNvcmQsIHJlY29yZCwgcmVxdWlyZWQsIHN0cmluZywgZXJyb3JGcm9tIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuXG5jb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IHBhcnNlQXJncyh7XG4gIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gIG9wdGlvbnM6IHsgb3V0cHV0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSwgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LCBoZWxwOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0gfSxcbn0pO1xuY29uc3QgW2hhcm5lc3MsIC4uLnNlbGVjdGVkXSA9IHBvc2l0aW9uYWxzO1xuY29uc3QgcmVxdWVzdGVkTmFtZXMgPSBzZWxlY3RlZC5sZW5ndGggPyBbLi4ubmV3IFNldChzZWxlY3RlZCldIDogT2JqZWN0LmtleXMoY2FzZXMpO1xuaWYgKFxuICB2YWx1ZXMuaGVscCB8fFxuICAoaGFybmVzcyAhPT0gXCJjb2RleFwiICYmIGhhcm5lc3MgIT09IFwiY2xhdWRlXCIpIHx8XG4gIHJlcXVlc3RlZE5hbWVzLnNvbWUoKG5hbWUpID0+ICFPYmplY3QuaGFzT3duKGNhc2VzLCBuYW1lKSkgfHxcbiAgIXZhbHVlcy5vdXRwdXRcbikge1xuICBjb25zb2xlLmxvZyhcbiAgICBcIlVzYWdlOiBub2RlIHNjcmlwdHMvZXZhbHVhdGUtc2tpbGxzLm1qcyBjb2RleHxjbGF1ZGUgW3Jldmlld3xyZWZhY3RvcnN8ZGVwZW5kZW5jaWVzfGF1ZGl0IC4uLl0gLS1vdXRwdXQgTkVXX0RJUkVDVE9SWSBbLS1tb2RlbCBNT0RFTF1cIixcbiAgKTtcbiAgY29uc29sZS5sb2coXG4gICAgXCJSdW5zIHJlYWwgbW9kZWwgaW5mZXJlbmNlOyBjcmVkZW50aWFscyBhcmUgcmVxdWlyZWQuIE91dHB1dCByZXRhaW5zIGZpbmFsIHJlcGxpZXMsIGRpZmZzLCBhbmQgZ3JhZGluZyByZXN1bHRzIGZvciByZXZpZXcuXCIsXG4gICk7XG4gIHByb2Nlc3MuZXhpdCh2YWx1ZXMuaGVscCA/IDAgOiAyKTtcbn1cblxuY29uc3QgbmFtZXMgPSByZXF1ZXN0ZWROYW1lcy5tYXAoKG5hbWUpID0+IHtcbiAgaWYgKG5hbWUgIT09IFwicmV2aWV3XCIgJiYgbmFtZSAhPT0gXCJyZWZhY3RvcnNcIiAmJiBuYW1lICE9PSBcImRlcGVuZGVuY2llc1wiICYmIG5hbWUgIT09IFwiYXVkaXRcIilcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gZXZhbHVhdGlvbjogJHtuYW1lfWApO1xuICByZXR1cm4gbmFtZTtcbn0pO1xuY29uc3Qgc2VsZWN0ZWRIYXJuZXNzID0gaGFybmVzcztcbmNvbnN0IHJlcXVlc3RlZE1vZGVsID0gdmFsdWVzLm1vZGVsPy5sZW5ndGggPyB2YWx1ZXMubW9kZWwgOiB1bmRlZmluZWQ7XG5jb25zdCBkaXN0cmlidXRpb24gPSByZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi5cIik7XG5jb25zdCBvdXRwdXQgPSByZXNvbHZlKHZhbHVlcy5vdXRwdXQpO1xuaWYgKGV4aXN0c1N5bmMob3V0cHV0KSkgdGhyb3cgbmV3IEVycm9yKFwiZXZhbHVhdGlvbiBvdXRwdXQgZGlyZWN0b3J5IG11c3Qgbm90IGFscmVhZHkgZXhpc3RcIik7XG5jb25zdCBjb2RleEF1dGggPSBqb2luKFxuICBwcm9jZXNzLmVudi5DT0RFWF9IT01FPy5sZW5ndGggPyBwcm9jZXNzLmVudi5DT0RFWF9IT01FIDogam9pbihob21lZGlyKCksIFwiLmNvZGV4XCIpLFxuICBcImF1dGguanNvblwiLFxuKTtcbmlmIChoYXJuZXNzID09PSBcImNvZGV4XCIgJiYgIXByb2Nlc3MuZW52Lk9QRU5BSV9BUElfS0VZICYmICFleGlzdHNTeW5jKGNvZGV4QXV0aCkpXG4gIHRocm93IG5ldyBFcnJvcihcIkNvZGV4IGV2YWx1YXRpb24gcmVxdWlyZXMgT1BFTkFJX0FQSV9LRVkgb3IgYW4gZXhpc3RpbmcgQ29kZXggYXV0aC5qc29uXCIpO1xuaWYgKGhhcm5lc3MgPT09IFwiY2xhdWRlXCIgJiYgIXByb2Nlc3MuZW52LkFOVEhST1BJQ19BUElfS0VZICYmICFwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9PQVVUSF9UT0tFTilcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiQ2xhdWRlIGV2YWx1YXRpb24gcmVxdWlyZXMgQU5USFJPUElDX0FQSV9LRVkgb3IgQ0xBVURFX0NPREVfT0FVVEhfVE9LRU47IHVzZXIgc2V0dGluZ3MgYW5kIGtleWNoYWlucyBhcmUgbm90IGltcG9ydGVkXCIsXG4gICk7XG5ta2RpclN5bmMob3V0cHV0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgbW9kZTogMG83MDAgfSk7XG5jb25zdCBpbnRlcnJ1cHRpb24gPSB7IG9jY3VycmVkOiBmYWxzZSB9O1xuXG5mdW5jdGlvbiBydW4oYXJnczogcmVhZG9ubHkgc3RyaW5nW10sIGN3ZDogc3RyaW5nLCBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52LCByZXBseTogc3RyaW5nKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZTxzdHJpbmc+KChkb25lLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHNlbGVjdGVkSGFybmVzcywgYXJncywgeyBjd2QsIGVudiwgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSB9KTtcbiAgICBsZXQgc3Rkb3V0ID0gXCJcIjtcbiAgICBsZXQgc3RkZXJyID0gXCJcIjtcbiAgICBsZXQgcmVwb3J0ZWRNb2RlbDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCB0aW1lZE91dCA9IGZhbHNlO1xuICAgIGNvbnN0IHN0b3AgPSAoKSA9PiB7XG4gICAgICBpZiAoIWNoaWxkLnBpZCkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcHJvY2Vzcy5raWxsKC1jaGlsZC5waWQsIFwiU0lHS0lMTFwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmICghaXNSZWNvcmQoZXJyb3IpIHx8IGVycm9yLmNvZGUgIT09IFwiRVNSQ0hcIikgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBpbnRlcnJ1cHQgPSAoKSA9PiB7XG4gICAgICBpbnRlcnJ1cHRpb24ub2NjdXJyZWQgPSB0cnVlO1xuICAgICAgc3RvcCgpO1xuICAgIH07XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRpbWVkT3V0ID0gdHJ1ZTtcbiAgICAgIHN0b3AoKTtcbiAgICB9LCAzMDAwMDApO1xuICAgIHByb2Nlc3Mub25jZShcIlNJR0lOVFwiLCBpbnRlcnJ1cHQpO1xuICAgIHByb2Nlc3Mub25jZShcIlNJR1RFUk1cIiwgaW50ZXJydXB0KTtcbiAgICBjaGlsZC5zdGRvdXQub24oXCJkYXRhXCIsIChkYXRhOiBzdHJpbmcpID0+IHtcbiAgICAgIHN0ZG91dCArPSBkYXRhO1xuICAgIH0pO1xuICAgIGNoaWxkLnN0ZGVyci5vbihcImRhdGFcIiwgKGRhdGE6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgbmV4dCA9IHN0ZGVyciArIGRhdGE7XG4gICAgICByZXBvcnRlZE1vZGVsID8/PSAvXm1vZGVsOiAqKFteXFxyXFxuXSspXFxyP1xcbi9tLmV4ZWMobmV4dCk/LlsxXTtcbiAgICAgIHN0ZGVyciA9IG5leHQuc2xpY2UoLTYwMDApO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgcmVqZWN0KTtcbiAgICBjaGlsZC5vbihcImNsb3NlXCIsIChjb2RlLCBzaWduYWwpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKFwiU0lHSU5UXCIsIGludGVycnVwdCk7XG4gICAgICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKFwiU0lHVEVSTVwiLCBpbnRlcnJ1cHQpO1xuICAgICAgc3RvcCgpO1xuICAgICAgaWYgKGNvZGUgIT09IDApIHtcbiAgICAgICAgcmVqZWN0KFxuICAgICAgICAgIG5ldyBFcnJvcihgJHtTdHJpbmcoaGFybmVzcyl9OiAke1N0cmluZyh0aW1lZE91dCA/IFwiZml2ZS1taW51dGUgdGltZW91dFwiIDogKHNpZ25hbCA/PyBjb2RlKSl9XFxuJHtzdGRlcnJ9YCksXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChoYXJuZXNzID09PSBcImNsYXVkZVwiKSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVjb3JkKEpTT04ucGFyc2Uoc3Rkb3V0KSwgXCJJbnZhbGlkIENsYXVkZSBldmFsdWF0aW9uIHJlc3VsdFwiKTtcbiAgICAgICAgICBjb25zdCByZXBseVRleHQgPSByZXN1bHQucmVzdWx0ID09PSB1bmRlZmluZWQgPyBcIlwiIDogc3RyaW5nKHJlc3VsdC5yZXN1bHQsIFwiSW52YWxpZCBDbGF1ZGUgcmVzdWx0IHRleHRcIik7XG4gICAgICAgICAgaWYgKHJlc3VsdC5pc19lcnJvcikgdGhyb3cgbmV3IEVycm9yKHJlcGx5VGV4dCB8fCBcIkNsYXVkZSBldmFsdWF0aW9uIGZhaWxlZFwiKTtcbiAgICAgICAgICB3cml0ZUZpbGVTeW5jKHJlcGx5LCByZXBseVRleHQpO1xuICAgICAgICAgIGRvbmUoXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhyZXN1bHQubW9kZWxVc2FnZSA9PT0gdW5kZWZpbmVkID8ge30gOiByZWNvcmQocmVzdWx0Lm1vZGVsVXNhZ2UsIFwiSW52YWxpZCBtb2RlbCB1c2FnZVwiKSkuam9pbihcbiAgICAgICAgICAgICAgXCIsIFwiLFxuICAgICAgICAgICAgKSB8fFxuICAgICAgICAgICAgICAocmVxdWVzdGVkTW9kZWwgPz8gXCJoYXJuZXNzIGRlZmF1bHQgKG5vdCByZXBvcnRlZClcIiksXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIGRvbmUocmVwb3J0ZWRNb2RlbCA/PyByZXF1ZXN0ZWRNb2RlbCA/PyBcImhhcm5lc3MgZGVmYXVsdCAobm90IHJlcG9ydGVkKVwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJlamVjdChlcnJvckZyb20oZXJyb3IpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG59XG5cbmxldCBmYWlsZWQgPSBmYWxzZTtcbmZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICBpZiAoaW50ZXJydXB0aW9uLm9jY3VycmVkKSBicmVhaztcbiAgY29uc3QgdGVtcG9yYXJ5ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJ3b3JrYmVuY2gtc2tpbGwtZXZhbHVhdGlvbi1cIikpO1xuICBjb25zdCByb290ID0gam9pbih0ZW1wb3JhcnksIFwicHJvamVjdFwiKTtcbiAgY29uc3QgdGVzdEhvbWUgPSBqb2luKHRlbXBvcmFyeSwgXCJob21lXCIpO1xuICBjb25zdCByZXN1bHREaXJlY3RvcnkgPSBqb2luKG91dHB1dCwgbmFtZSk7XG4gIG1rZGlyU3luYyhyb290KTtcbiAgbWtkaXJTeW5jKHRlc3RIb21lKTtcbiAgbWtkaXJTeW5jKHJlc3VsdERpcmVjdG9yeSk7XG4gIGNvbnN0IGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSB7XG4gICAgUEFUSDogYCR7am9pbihkaXN0cmlidXRpb24sIFwiYmluXCIpfToke1N0cmluZyhwcm9jZXNzLmVudi5QQVRIKX1gLFxuICAgIEhPTUU6IHRlc3RIb21lLFxuICAgIFVTRVJQUk9GSUxFOiB0ZXN0SG9tZSxcbiAgICBUTVBESVI6IHRlbXBvcmFyeSxcbiAgICBMQU5HOiBcIkMuVVRGLThcIixcbiAgICBDT0RFWF9IT01FOiBqb2luKHRlc3RIb21lLCBcIi5jb2RleFwiKSxcbiAgICBDTEFVREVfQ09ORklHX0RJUjogam9pbih0ZXN0SG9tZSwgXCIuY2xhdWRlXCIpLFxuICAgIFhER19DT05GSUdfSE9NRTogam9pbih0ZXN0SG9tZSwgXCJjb25maWdcIiksXG4gICAgV09SS0JFTkNIX0NPTkZJR19IT01FOiBqb2luKHRlc3RIb21lLCBcIndvcmtiZW5jaC1jb25maWdcIiksXG4gICAgWERHX0RBVEFfSE9NRTogam9pbih0ZXN0SG9tZSwgXCJkYXRhXCIpLFxuICAgIFhER19DQUNIRV9IT01FOiBqb2luKHRlc3RIb21lLCBcImNhY2hlXCIpLFxuICAgIFhER19TVEFURV9IT01FOiBqb2luKHRlc3RIb21lLCBcInN0YXRlXCIpLFxuICAgIEdJVF9DT05GSUdfR0xPQkFMOiBcIi9kZXYvbnVsbFwiLFxuICAgIEdJVF9DT05GSUdfTk9TWVNURU06IFwiMVwiLFxuICAgIERJU0FCTEVfQVVUT1VQREFURVI6IFwiMVwiLFxuICAgIERJU0FCTEVfVEVMRU1FVFJZOiBcIjFcIixcbiAgICBESVNBQkxFX0VSUk9SX1JFUE9SVElORzogXCIxXCIsXG4gICAgQ0xBVURFX0NPREVfRElTQUJMRV9OT05FU1NFTlRJQUxfVFJBRkZJQzogXCIxXCIsXG4gICAgQ0xBVURFX0NPREVfU0tJUF9QUk9NUFRfSElTVE9SWTogXCIxXCIsXG4gICAgbnBtX2NvbmZpZ19jYWNoZTogam9pbih0ZXN0SG9tZSwgXCJucG0tY2FjaGVcIiksXG4gIH07XG4gIG1rZGlyU3luYyhyZXF1aXJlZChlbnYuQ09ERVhfSE9NRSwgXCJNaXNzaW5nIENvZGV4IGhvbWVcIiksIHsgbW9kZTogMG83MDAgfSk7XG4gIG1rZGlyU3luYyhyZXF1aXJlZChlbnYuQ0xBVURFX0NPTkZJR19ESVIsIFwiTWlzc2luZyBDbGF1ZGUgaG9tZVwiKSwgeyBtb2RlOiAwbzcwMCB9KTtcbiAgaWYgKGhhcm5lc3MgPT09IFwiY29kZXhcIikge1xuICAgIGlmIChwcm9jZXNzLmVudi5PUEVOQUlfQVBJX0tFWSkgZW52Lk9QRU5BSV9BUElfS0VZID0gcHJvY2Vzcy5lbnYuT1BFTkFJX0FQSV9LRVk7XG4gICAgZWxzZSBjcFN5bmMoY29kZXhBdXRoLCBqb2luKHJlcXVpcmVkKGVudi5DT0RFWF9IT01FLCBcIk1pc3NpbmcgQ29kZXggaG9tZVwiKSwgXCJhdXRoLmpzb25cIiksIHsgZGVyZWZlcmVuY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgW1wiQU5USFJPUElDX0FQSV9LRVlcIiwgXCJDTEFVREVfQ09ERV9PQVVUSF9UT0tFTlwiXSlcbiAgICAgIGlmIChwcm9jZXNzLmVudltrZXldKSBlbnZba2V5XSA9IHByb2Nlc3MuZW52W2tleV07XG4gIH1cbiAgY29uc3QgcmVwb3J0OiB7XG4gICAgY2FzZTogc3RyaW5nO1xuICAgIGhhcm5lc3M6IHN0cmluZztcbiAgICByZXF1ZXN0ZWRNb2RlbDogc3RyaW5nO1xuICAgIHN0YXJ0ZWQ6IHN0cmluZztcbiAgICBza2lsbHNTaGEyNTY6IHN0cmluZztcbiAgICBtYW51YWxSZXZpZXc6IHN0cmluZztcbiAgICBoYXJuZXNzVmVyc2lvbj86IHN0cmluZztcbiAgICBmaXh0dXJlU2hhMjU2Pzogc3RyaW5nO1xuICAgIHByb21wdD86IHN0cmluZztcbiAgICBtb2RlbD86IHN0cmluZztcbiAgICByZXN1bHQ/OiBzdHJpbmc7XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gICAgZmluaXNoZWQ/OiBzdHJpbmc7XG4gIH0gPSB7XG4gICAgY2FzZTogbmFtZSxcbiAgICBoYXJuZXNzLFxuICAgIHJlcXVlc3RlZE1vZGVsOiByZXF1ZXN0ZWRNb2RlbCA/PyBcImhhcm5lc3MgZGVmYXVsdFwiLFxuICAgIHN0YXJ0ZWQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBza2lsbHNTaGEyNTY6IHNuYXBzaG90KGpvaW4oZGlzdHJpYnV0aW9uLCBcInNraWxsc1wiKSksXG4gICAgbWFudWFsUmV2aWV3OiBjYXNlc1tuYW1lXS5yZXZpZXcsXG4gIH07XG4gIGxldCBiZWZvcmU6IFJldHVyblR5cGU8dHlwZW9mIHByZXBhcmU+IHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIHJlcG9ydC5oYXJuZXNzVmVyc2lvbiA9IGNvbW1hbmQocm9vdCwgZW52LCBoYXJuZXNzLCBbXCItLXZlcnNpb25cIl0pLnRyaW0oKTtcbiAgICBiZWZvcmUgPSBwcmVwYXJlKHJvb3QsIGRpc3RyaWJ1dGlvbiwgZW52LCBuYW1lKTtcbiAgICByZXBvcnQuZml4dHVyZVNoYTI1NiA9IGJlZm9yZS5zbmFwc2hvdDtcbiAgICBjb25zb2xlLmxvZyhgJHtuYW1lfTogcHJlcGFyZWQ7IHJ1bm5pbmcgJHtoYXJuZXNzfWApO1xuICAgIGNvbnN0IHJlcGx5ID0gam9pbihyZXN1bHREaXJlY3RvcnksIFwicmVwbHkubWRcIik7XG4gICAgY29uc3QgcHJvbXB0ID0gYFVzZSAke2hhcm5lc3MgPT09IFwiY29kZXhcIiA/IFwiJFwiIDogXCIvXCJ9JHtjYXNlc1tuYW1lXS5za2lsbH0uICR7Y2FzZXNbbmFtZV0ucmVxdWVzdH0gRG8gbm90IHN0YWdlIG9yIGNvbW1pdC4gV29yayBvbmx5IGluIHRoaXMgZGlzcG9zYWJsZSBwcm9qZWN0LmA7XG4gICAgcmVwb3J0LnByb21wdCA9IHByb21wdDtcbiAgICBjb25zdCBhcmdzID1cbiAgICAgIGhhcm5lc3MgPT09IFwiY29kZXhcIlxuICAgICAgICA/IFtcbiAgICAgICAgICAgIFwiZXhlY1wiLFxuICAgICAgICAgICAgXCItLWVwaGVtZXJhbFwiLFxuICAgICAgICAgICAgXCItLWlnbm9yZS11c2VyLWNvbmZpZ1wiLFxuICAgICAgICAgICAgXCItLWlnbm9yZS1ydWxlc1wiLFxuICAgICAgICAgICAgXCItLXNhbmRib3hcIixcbiAgICAgICAgICAgIFwid29ya3NwYWNlLXdyaXRlXCIsXG4gICAgICAgICAgICBcIi1jXCIsXG4gICAgICAgICAgICAnYXBwcm92YWxfcG9saWN5PVwibmV2ZXJcIicsXG4gICAgICAgICAgICBcIi1jXCIsXG4gICAgICAgICAgICBcInNhbmRib3hfd29ya3NwYWNlX3dyaXRlLm5ldHdvcmtfYWNjZXNzPXRydWVcIixcbiAgICAgICAgICAgIFwiLS1vdXRwdXQtbGFzdC1tZXNzYWdlXCIsXG4gICAgICAgICAgICByZXBseSxcbiAgICAgICAgICBdXG4gICAgICAgIDogW1xuICAgICAgICAgICAgXCItLXByaW50XCIsXG4gICAgICAgICAgICBcIi0tbm8tc2Vzc2lvbi1wZXJzaXN0ZW5jZVwiLFxuICAgICAgICAgICAgXCItLW91dHB1dC1mb3JtYXRcIixcbiAgICAgICAgICAgIFwianNvblwiLFxuICAgICAgICAgICAgXCItLXBlcm1pc3Npb24tbW9kZVwiLFxuICAgICAgICAgICAgXCJkb250QXNrXCIsXG4gICAgICAgICAgICBcIi0tdG9vbHNcIixcbiAgICAgICAgICAgIFwiUmVhZCxFZGl0LFdyaXRlLEJhc2gsR2xvYixHcmVwLFNraWxsXCIsXG4gICAgICAgICAgICBcIi0tYWxsb3dlZFRvb2xzXCIsXG4gICAgICAgICAgICBcIlJlYWQsRWRpdCxXcml0ZSxCYXNoLEdsb2IsR3JlcCxTa2lsbFwiLFxuICAgICAgICAgICAgXCItLXNldHRpbmctc291cmNlc1wiLFxuICAgICAgICAgICAgXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBcIi0tc3RyaWN0LW1jcC1jb25maWdcIixcbiAgICAgICAgICAgIFwiLS1tY3AtY29uZmlnXCIsXG4gICAgICAgICAgICAne1wibWNwU2VydmVyc1wiOnt9fScsXG4gICAgICAgICAgXTtcbiAgICBpZiAocmVxdWVzdGVkTW9kZWwpIGFyZ3MucHVzaChcIi0tbW9kZWxcIiwgcmVxdWVzdGVkTW9kZWwpO1xuICAgIGFyZ3MucHVzaChcIi0tXCIsIHByb21wdCk7XG4gICAgcmVwb3J0Lm1vZGVsID0gYXdhaXQgcnVuKGFyZ3MsIHJvb3QsIGVudiwgcmVwbHkpO1xuICAgIGlmICghZXhpc3RzU3luYyhyZXBseSkgfHwgIXJlYWRGaWxlU3luYyhyZXBseSwgXCJ1dGY4XCIpLnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKFwiYWdlbnQgcHJvZHVjZWQgbm8gZmluYWwgcmVwbHlcIik7XG4gICAgZm9yIChjb25zdCBkaXJlY3Rvcnkgb2YgW2Vudi5DT0RFWF9IT01FLCBlbnYuQ0xBVURFX0NPTkZJR19ESVJdKSB7XG4gICAgICBjb25zdCBoaXN0b3J5ID0gcmVhZGRpclN5bmMocmVxdWlyZWQoZGlyZWN0b3J5LCBcIk1pc3NpbmcgaGFybmVzcyBob21lXCIpLCB7XG4gICAgICAgIHJlY3Vyc2l2ZTogdHJ1ZSxcbiAgICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgfSkuZmlsdGVyKChwYXRoKSA9PiAvKF58XFwvKShoaXN0b3J5XFwuanNvbmx8c2Vzc2lvbnNcXC8uKlxcLmpzb25sfHByb2plY3RzXFwvLipcXC5qc29ubCkkLy50ZXN0KHBhdGgpKTtcbiAgICAgIGlmIChoaXN0b3J5Lmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiaGFybmVzcyByZXRhaW5lZCBjb252ZXJzYXRpb24gaGlzdG9yeSBpbiBpdHMgZGlzcG9zYWJsZSBob21lXCIpO1xuICAgIH1cbiAgICBncmFkZShyb290LCBlbnYsIG5hbWUsIGJlZm9yZSk7XG4gICAgcmVwb3J0LnJlc3VsdCA9IFwib2JqZWN0aXZlIGNoZWNrcyBwYXNzZWQ7IHJldmlldyByZXBseSBhbmQgZGlmZiBhZ2FpbnN0IG1hbnVhbFJldmlld1wiO1xuICAgIGNvbnNvbGUubG9nKGAke25hbWV9OiAke3JlcG9ydC5yZXN1bHR9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgZmFpbGVkID0gdHJ1ZTtcbiAgICByZXBvcnQucmVzdWx0ID0gXCJmYWlsZWRcIjtcbiAgICByZXBvcnQuZXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgY29uc29sZS5lcnJvcihgJHtuYW1lfTogJHtyZXBvcnQuZXJyb3J9YCk7XG4gICAgLy8gUHJlcGFyYXRpb24gb3IgaGFybmVzcyBmYWlsdXJlcyBkbyBub3QgcHJvdmlkZSB3b3JrZmxvdyBldmlkZW5jZSBmb3IgbGF0ZXIgY2FzZXMuXG4gICAgaWYgKCFyZXBvcnQubW9kZWwpIGJyZWFrO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICBpZiAoYmVmb3JlKSB7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXN1bHREaXJlY3RvcnksIFwiY2hhbmdlcy5kaWZmXCIpLCBjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1wiZGlmZlwiLCBiZWZvcmUuaGVhZF0pKTtcbiAgICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHJlc3VsdERpcmVjdG9yeSwgXCJzdGF0dXMudHh0XCIpLCBjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1wic3RhdHVzXCIsIFwiLS1zaG9ydFwiXSkpO1xuICAgICAgICAvLyBSZXRhaW4gbmV3IHRlc3RzIGFuZCByZWNvcmRzIHRvbzsgYSBHaXQgZGlmZiBhbG9uZSBvbWl0cyB1bnRyYWNrZWQgZmlsZXMuXG4gICAgICAgIGZvciAoY29uc3QgcGF0aCBvZiBjb21tYW5kKHJvb3QsIGVudiwgXCJnaXRcIiwgW1wibHMtZmlsZXNcIiwgXCItLW90aGVyc1wiLCBcIi0tZXhjbHVkZS1zdGFuZGFyZFwiLCBcIi16XCJdKVxuICAgICAgICAgIC5zcGxpdChcIlxcMFwiKVxuICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbikpIHtcbiAgICAgICAgICBjb25zdCB0YXJnZXQgPSBqb2luKHJlc3VsdERpcmVjdG9yeSwgXCJ1bnRyYWNrZWRcIiwgcGF0aCk7XG4gICAgICAgICAgbWtkaXJTeW5jKGpvaW4odGFyZ2V0LCBcIi4uXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjcFN5bmMoam9pbihyb290LCBwYXRoKSwgdGFyZ2V0LCB7IGRlcmVmZXJlbmNlOiBmYWxzZSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVwb3J0LmZpbmlzaGVkID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHJlc3VsdERpcmVjdG9yeSwgXCJyZXN1bHQuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocmVwb3J0LCBudWxsLCAyKSArIFwiXFxuXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcG9yYXJ5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG59XG5jb25zb2xlLmxvZyhgRXZhbHVhdGlvbiBldmlkZW5jZTogJHtvdXRwdXR9YCk7XG5wcm9jZXNzLmV4aXRDb2RlID0gaW50ZXJydXB0aW9uLm9jY3VycmVkID8gMTMwIDogZmFpbGVkID8gMSA6IDA7XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGFBQWE7QUFDdEIsU0FBUyxRQUFRLFlBQVksV0FBVyxhQUFhLGNBQWMsYUFBYSxRQUFRLHFCQUFxQjtBQUM3RyxTQUFTLFNBQVMsY0FBYztBQUNoQyxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLE9BQU8sU0FBUyxPQUFPLFNBQVMsZ0JBQWdCO0FBQ3pELFNBQVMsVUFBVSxRQUFRLFVBQVUsUUFBUSxpQkFBaUI7QUFFOUQsTUFBTSxFQUFFLFFBQVEsWUFBWSxJQUFJLFVBQVU7QUFBQSxFQUN4QyxrQkFBa0I7QUFBQSxFQUNsQixTQUFTLEVBQUUsUUFBUSxFQUFFLE1B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

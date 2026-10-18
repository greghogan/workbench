// Generated from check-harnesses.mts; edit the TypeScript source.
import { isRecord, required, record, records, errorFrom } from "./values.mjs";
import { errorMessage } from "./ci-results.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const skills = createRequire(import.meta.url)("../bundle/skills.cjs");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const selected = process.argv.slice(2);
const interruption = { occurred: false };
if (!selected.length || selected.some((name) => !["codex", "claude"].includes(name))) {
  console.error("Usage: node scripts/check-harnesses.mjs codex [claude]");
  process.exit(2);
}
function run(command, args, cwd, env) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let errors = "";
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!isRecord(error) || error.code !== "ESRCH") throw error;
        }
      }
    };
    const timer = setTimeout(stop, 6e4);
    const onInterrupt = () => {
      interruption.occurred = true;
      stop();
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      stop();
      if (code !== 0) reject(new Error(`${command}: ${String(signal ?? code)}
${(output + errors).slice(-6e3)}`));
      else done(output);
    });
  });
}
function respondCodex(response, item) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_probe",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
    }
  ])
    response.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
  response.end();
}
function respondClaude(response, block) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const tool = block.type === "tool_use";
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: "workbench-discovery-probe",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 }
      }
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool ? { ...block, input: {} } : { type: "text", text: "" }
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text }
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 }
    },
    { type: "message_stop" }
  ];
  for (const event of events) response.write(`event: ${event.type}
data: ${JSON.stringify(event)}

`);
  response.end();
}
async function check(harness, nested) {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-harness-"));
  const checkout = join(temporary, "project");
  const testHome = join(temporary, "home");
  const previousConfigHome = process.env.WORKBENCH_CONFIG_HOME;
  const distribution = join(checkout, ".workbench");
  const name = `workbench-probe-${randomUUID()}`;
  const agentsToken = `agents-${randomUUID()}`;
  const descriptionToken = `description-${randomUUID()}`;
  const bodyToken = `body-${randomUUID()}`;
  const hiddenToken = `explicit-${randomUUID()}`;
  const requests = [];
  const serverFailure = {};
  let server;
  try {
    mkdirSync(join(checkout, "workbench"), { recursive: true });
    mkdirSync(testHome);
    for (const language of ["rust", "python", "typescript"]) mkdirSync(join(checkout, language));
    writeFileSync(join(checkout, "AGENTS.md"), `# Test project

Fixture identity: ${agentsToken}.
`);
    writeFileSync(
      join(checkout, "workbench/config.toml"),
      'schema_version = 1\n[markdown]\nwrap_width = 120\n[compatibility]\nrequired = false\n[checks]\nenvironment = "native"\n'
    );
    writeFileSync(
      join(checkout, "workbench/projects.toml"),
      '[[project]]\nid = "probe"\npath = "."\n' + ["rust", "python", "typescript"].map((language) => `[[language_root]]
language = "${language}"
path = "${language}"
`).join("")
    );
    cpSync(join(root, "skills"), join(distribution, "skills"), { recursive: true });
    for (const [skill, description, body, explicit] of [
      [name, descriptionToken, bodyToken, false],
      ["workbench-explicit-probe", hiddenToken, "Explicit-only fixture.", true]
    ]) {
      const source = join(distribution, "skills/workflows", skill);
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, "SKILL.md"),
        `---
name: ${skill}
description: ${description}
${explicit ? "disable-model-invocation: true\n" : ""}---

${body}
`
      );
      if (explicit) {
        mkdirSync(join(source, "agents"));
        writeFileSync(join(source, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
      }
    }
    const configuration = join(testHome, "workbench-config");
    mkdirSync(configuration);
    writeFileSync(
      join(configuration, "config.toml"),
      `[skills]
enabled = ${JSON.stringify([name, "workbench-explicit-probe"])}
`
    );
    process.env.WORKBENCH_CONFIG_HOME = configuration;
    skills.syncSkills(checkout, distribution);
    const cwd = nested ? join(checkout, "rust") : checkout;
    server = createServer((request, response) => {
      void (async () => {
        try {
          let raw = "";
          for await (const chunk of request) {
            const bytes = chunk;
            if (!Buffer.isBuffer(bytes)) throw new Error("Invalid harness request bytes");
            raw += bytes.toString();
          }
          const parsed = record(JSON.parse(raw || "{}"), "Invalid harness request");
          if ((request.url ?? "").includes("count_tokens")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"input_tokens":1}');
            return;
          }
          if (!(request.url ?? "").startsWith(harness === "codex" ? "/v1/responses" : "/v1/messages")) {
            response.writeHead(404);
            response.end();
            return;
          }
          const data = Object.assign(parsed, {
            tools: records(parsed.tools, "Invalid harness tools").map((tool) => ({
              ...tool,
              name: typeof tool.name === "string" ? tool.name : void 0
            }))
          });
          requests.push(data);
          if (requests.length > 3) throw new Error("harness did not finish the probe");
          const first = requests.length === 1;
          if (harness === "codex") {
            const tool = data.tools.find(
              (tool2) => tool2.name !== void 0 && ["exec_command", "shell_command"].includes(tool2.name)
            );
            if (first && !tool) throw new Error("Codex did not expose a supported file-reading command tool");
            const path = join(checkout, ".agents/skills", name, "SKILL.md");
            const command = `cat '${path.replaceAll("'", "'\\''")}'`;
            respondCodex(
              response,
              first ? {
                id: "fc_probe",
                type: "function_call",
                call_id: "call_probe",
                name: required(required(tool, "Missing command tool").name, "Missing command tool name"),
                arguments: JSON.stringify(
                  required(tool, "Missing command tool").name === "exec_command" ? { cmd: command, login: false } : { command, workdir: cwd }
                )
              } : {
                id: "msg_probe",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Probe complete." }]
              }
            );
          } else {
            respondClaude(
              response,
              first ? { type: "tool_use", id: "toolu_probe", name: "Skill", input: { skill: name } } : { type: "text", text: "Probe complete." }
            );
          }
        } catch (error) {
          serverFailure.error = errorFrom(error);
          response.writeHead(500);
          response.end();
        }
      })();
    });
    const activeServer = server;
    await new Promise((done) => {
      activeServer.listen(0, "127.0.0.1", done);
    });
    const address = activeServer.address();
    assert.ok(address && typeof address !== "string", "Missing TCP server address");
    const base = `http://127.0.0.1:${String(address.port)}`;
    const env = {
      PATH: process.env.PATH,
      HOME: testHome,
      USERPROFILE: testHome,
      LANG: "C.UTF-8",
      TMPDIR: temporary,
      XDG_CONFIG_HOME: join(testHome, "config"),
      XDG_CACHE_HOME: join(testHome, "cache"),
      XDG_DATA_HOME: join(testHome, "data"),
      XDG_STATE_HOME: join(testHome, "state"),
      CODEX_HOME: join(testHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(testHome, ".claude"),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
    };
    mkdirSync(env.CODEX_HOME);
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    await run("git", ["-c", "init.defaultBranch=main", "init", "--quiet"], checkout, env);
    const prompt = "Run the Workbench discovery probe skill available in this project, then finish.";
    const args = harness === "codex" ? [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      'model="workbench-discovery-probe"',
      "-c",
      'model_provider="workbench_test"',
      "-c",
      'model_providers.workbench_test.name="Workbench fixture"',
      "-c",
      `model_providers.workbench_test.base_url="${base}/v1"`,
      "-c",
      'model_providers.workbench_test.wire_api="responses"',
      "-c",
      "model_providers.workbench_test.requires_openai_auth=false",
      prompt
    ] : [
      "--print",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--model",
      "workbench-discovery-probe",
      "--tools",
      "Skill",
      "--allowedTools",
      "Skill",
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--",
      prompt
    ];
    if (harness === "claude") {
      env.ANTHROPIC_BASE_URL = base;
      env.ANTHROPIC_API_KEY = "workbench-local-fixture";
    }
    const version = (await run(harness, ["--version"], cwd, env)).trim();
    await run(harness, args, cwd, env);
    if (serverFailure.error) throw serverFailure.error;
    assert.ok(requests.length >= 2, "harness must load a skill before completing");
    const initial = JSON.stringify(requests[0]);
    assert.ok(initial.includes(agentsToken), "root AGENTS.md was not automatically loaded");
    assert.ok(initial.includes(name), "applicable skill was not discovered");
    assert.ok(!initial.includes(bodyToken), "skill body was loaded before invocation");
    assert.ok(!initial.includes("workbench-explicit-probe"), "explicit-only skill leaked into implicit discovery");
    assert.ok(!initial.includes("workbench-audit"), "packaged audit must require explicit invocation");
    assert.ok(JSON.stringify(requests.slice(1)).includes(bodyToken), "invoked skill body did not reach model context");
    for (const [directory, pattern] of [
      [env.CODEX_HOME, /(^|\/)(sessions\/.*\.jsonl|history\.jsonl)$/],
      [env.CLAUDE_CONFIG_DIR, /(^|\/)(projects\/.*\.jsonl|history\.jsonl)$/]
    ]) {
      const retained = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(
        (path) => pattern.test(path)
      );
      assert.deepEqual(retained, [], "ephemeral probe retained conversation history");
    }
    console.log(
      `${version}: ${nested ? "nested" : "root"} AGENTS.md, discovery, invocation, and history isolation passed.`
    );
  } finally {
    if (previousConfigHome === void 0) delete process.env.WORKBENCH_CONFIG_HOME;
    else process.env.WORKBENCH_CONFIG_HOME = previousConfigHome;
    if (server) {
      server.closeAllConnections();
      const activeServer = server;
      await new Promise((done, reject) => {
        activeServer.close((error) => {
          if (error) reject(error);
          else done();
        });
      });
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}
let failed = false;
for (const harness of new Set(selected)) {
  for (const nested of [false, true]) {
    if (interruption.occurred) break;
    try {
      await check(harness, nested);
    } catch (error) {
      failed = true;
      console.error(`${harness} (${nested ? "nested" : "root"}): ${errorMessage(error)}`);
    }
  }
}
process.exitCode = interruption.occurred ? 130 : failed ? 1 : 0;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNoZWNrLWhhcm5lc3Nlcy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBTZXJ2ZXIsIFNlcnZlclJlc3BvbnNlIH0gZnJvbSBcIm5vZGU6aHR0cFwiO1xuaW1wb3J0IHsgaXNSZWNvcmQsIHJlcXVpcmVkLCByZWNvcmQsIHJlY29yZHMsIGVycm9yRnJvbSB9IGZyb20gXCIuL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IGVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2NpLXJlc3VsdHMubWpzXCI7XG5pbnRlcmZhY2UgSGFybmVzc1JlcXVlc3Qge1xuICB0b29sczogeyBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQgfVtdO1xufVxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IGNwU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZGRpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIgfSBmcm9tIFwibm9kZTpodHRwXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmNvbnN0IHNraWxscyA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKShcIi4uL2J1bmRsZS9za2lsbHMuY2pzXCIpIGFzIHR5cGVvZiBpbXBvcnQoXCIuLi9zcmMvc2tpbGxzLmpzXCIpO1xuXG4vLyBSZWFsIGhhcm5lc3Nlcywgc3ludGhldGljIG1vZGVsIHJlc3BvbnNlczogbm8gY3JlZGVudGlhbHMsIGluZmVyZW5jZSwgb3IgdXNlciBoaXN0b3J5LlxuY29uc3Qgcm9vdCA9IHJlc29sdmUoZmlsZVVSTFRvUGF0aChuZXcgVVJMKFwiLi5cIiwgaW1wb3J0Lm1ldGEudXJsKSkpO1xuY29uc3Qgc2VsZWN0ZWQgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5jb25zdCBpbnRlcnJ1cHRpb24gPSB7IG9jY3VycmVkOiBmYWxzZSB9O1xuaWYgKCFzZWxlY3RlZC5sZW5ndGggfHwgc2VsZWN0ZWQuc29tZSgobmFtZSkgPT4gIVtcImNvZGV4XCIsIFwiY2xhdWRlXCJdLmluY2x1ZGVzKG5hbWUpKSkge1xuICBjb25zb2xlLmVycm9yKFwiVXNhZ2U6IG5vZGUgc2NyaXB0cy9jaGVjay1oYXJuZXNzZXMubWpzIGNvZGV4IFtjbGF1ZGVdXCIpO1xuICBwcm9jZXNzLmV4aXQoMik7XG59XG5cbmZ1bmN0aW9uIHJ1bihjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLCBjd2Q6IHN0cmluZywgZW52OiBOb2RlSlMuUHJvY2Vzc0Vudikge1xuICByZXR1cm4gbmV3IFByb21pc2U8c3RyaW5nPigoZG9uZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihjb21tYW5kLCBhcmdzLCB7IGN3ZCwgZW52LCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGRldGFjaGVkOiB0cnVlIH0pO1xuICAgIGxldCBvdXRwdXQgPSBcIlwiO1xuICAgIGxldCBlcnJvcnMgPSBcIlwiO1xuICAgIGNvbnN0IHN0b3AgPSAoKSA9PiB7XG4gICAgICBpZiAoY2hpbGQucGlkKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcHJvY2Vzcy5raWxsKC1jaGlsZC5waWQsIFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoIWlzUmVjb3JkKGVycm9yKSB8fCBlcnJvci5jb2RlICE9PSBcIkVTUkNIXCIpIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoc3RvcCwgNjAwMDApO1xuICAgIGNvbnN0IG9uSW50ZXJydXB0ID0gKCkgPT4ge1xuICAgICAgaW50ZXJydXB0aW9uLm9jY3VycmVkID0gdHJ1ZTtcbiAgICAgIHN0b3AoKTtcbiAgICB9O1xuICAgIHByb2Nlc3Mub25jZShcIlNJR0lOVFwiLCBvbkludGVycnVwdCk7XG4gICAgcHJvY2Vzcy5vbmNlKFwiU0lHVEVSTVwiLCBvbkludGVycnVwdCk7XG4gICAgY2hpbGQuc3Rkb3V0Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgb3V0cHV0ICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgfSk7XG4gICAgY2hpbGQuc3RkZXJyLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgZXJyb3JzICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgfSk7XG4gICAgY2hpbGQub24oXCJlcnJvclwiLCByZWplY3QpO1xuICAgIGNoaWxkLm9uKFwiY2xvc2VcIiwgKGNvZGUsIHNpZ25hbCkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoXCJTSUdJTlRcIiwgb25JbnRlcnJ1cHQpO1xuICAgICAgcHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcihcIlNJR1RFUk1cIiwgb25JbnRlcnJ1cHQpO1xuICAgICAgc3RvcCgpO1xuICAgICAgaWYgKGNvZGUgIT09IDApIHJlamVjdChuZXcgRXJyb3IoYCR7Y29tbWFuZH06ICR7U3RyaW5nKHNpZ25hbCA/PyBjb2RlKX1cXG4keyhvdXRwdXQgKyBlcnJvcnMpLnNsaWNlKC02MDAwKX1gKSk7XG4gICAgICBlbHNlIGRvbmUob3V0cHV0KTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlc3BvbmRDb2RleChyZXNwb25zZTogU2VydmVyUmVzcG9uc2UsIGl0ZW06IHVua25vd24pIHtcbiAgcmVzcG9uc2Uud3JpdGVIZWFkKDIwMCwgeyBcImNvbnRlbnQtdHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIgfSk7XG4gIGZvciAoY29uc3QgZXZlbnQgb2YgW1xuICAgIHsgdHlwZTogXCJyZXNwb25zZS5jcmVhdGVkXCIsIHJlc3BvbnNlOiB7IGlkOiBcInJlc3BfcHJvYmVcIiwgc3RhdHVzOiBcImluX3Byb2dyZXNzXCIsIG91dHB1dDogW10gfSB9LFxuICAgIHsgdHlwZTogXCJyZXNwb25zZS5vdXRwdXRfaXRlbS5hZGRlZFwiLCBvdXRwdXRfaW5kZXg6IDAsIGl0ZW0gfSxcbiAgICB7IHR5cGU6IFwicmVzcG9uc2Uub3V0cHV0X2l0ZW0uZG9uZVwiLCBvdXRwdXRfaW5kZXg6IDAsIGl0ZW0gfSxcbiAgICB7XG4gICAgICB0eXBlOiBcInJlc3BvbnNlLmNvbXBsZXRlZFwiLFxuICAgICAgcmVzcG9uc2U6IHtcbiAgICAgICAgaWQ6IFwicmVzcF9wcm9iZVwiLFxuICAgICAgICBzdGF0dXM6IFwiY29tcGxldGVkXCIsXG4gICAgICAgIG91dHB1dDogW2l0ZW1dLFxuICAgICAgICB1c2FnZTogeyBpbnB1dF90b2tlbnM6IDEsIG91dHB1dF90b2tlbnM6IDEsIHRvdGFsX3Rva2VuczogMiB9LFxuICAgICAgfSxcbiAgICB9LFxuICBdKVxuICAgIHJlc3BvbnNlLndyaXRlKGBldmVudDogJHtldmVudC50eXBlfVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZXZlbnQpfVxcblxcbmApO1xuICByZXNwb25zZS5lbmQoKTtcbn1cblxuZnVuY3Rpb24gcmVzcG9uZENsYXVkZShcbiAgcmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlLFxuICBibG9jazpcbiAgICB8IHsgdHlwZTogc3RyaW5nOyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGlucHV0OiB7IHNraWxsOiBzdHJpbmcgfTsgdGV4dD86IG5ldmVyIH1cbiAgICB8IHsgdHlwZTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGlkPzogbmV2ZXI7IG5hbWU/OiBuZXZlcjsgaW5wdXQ/OiBuZXZlciB9LFxuKSB7XG4gIHJlc3BvbnNlLndyaXRlSGVhZCgyMDAsIHsgXCJjb250ZW50LXR5cGVcIjogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiIH0pO1xuICBjb25zdCB0b29sID0gYmxvY2sudHlwZSA9PT0gXCJ0b29sX3VzZVwiO1xuICBjb25zdCBldmVudHMgPSBbXG4gICAge1xuICAgICAgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsXG4gICAgICBtZXNzYWdlOiB7XG4gICAgICAgIGlkOiBcIm1zZ19wcm9iZVwiLFxuICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgbW9kZWw6IFwid29ya2JlbmNoLWRpc2NvdmVyeS1wcm9iZVwiLFxuICAgICAgICBjb250ZW50OiBbXSxcbiAgICAgICAgc3RvcF9yZWFzb246IG51bGwsXG4gICAgICAgIHN0b3Bfc2VxdWVuY2U6IG51bGwsXG4gICAgICAgIHVzYWdlOiB7IGlucHV0X3Rva2VuczogMSwgb3V0cHV0X3Rva2VuczogMCB9LFxuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHR5cGU6IFwiY29udGVudF9ibG9ja19zdGFydFwiLFxuICAgICAgaW5kZXg6IDAsXG4gICAgICBjb250ZW50X2Jsb2NrOiB0b29sID8geyAuLi5ibG9jaywgaW5wdXQ6IHt9IH0gOiB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0eXBlOiBcImNvbnRlbnRfYmxvY2tfZGVsdGFcIixcbiAgICAgIGluZGV4OiAwLFxuICAgICAgZGVsdGE6IHRvb2xcbiAgICAgICAgPyB7IHR5cGU6IFwiaW5wdXRfanNvbl9kZWx0YVwiLCBwYXJ0aWFsX2pzb246IEpTT04uc3RyaW5naWZ5KGJsb2NrLmlucHV0KSB9XG4gICAgICAgIDogeyB0eXBlOiBcInRleHRfZGVsdGFcIiwgdGV4dDogYmxvY2sudGV4dCB9LFxuICAgIH0sXG4gICAgeyB0eXBlOiBcImNvbnRlbnRfYmxvY2tfc3RvcFwiLCBpbmRleDogMCB9LFxuICAgIHtcbiAgICAgIHR5cGU6IFwibWVzc2FnZV9kZWx0YVwiLFxuICAgICAgZGVsdGE6IHsgc3RvcF9yZWFzb246IHRvb2wgPyBcInRvb2xfdXNlXCIgOiBcImVuZF90dXJuXCIsIHN0b3Bfc2VxdWVuY2U6IG51bGwgfSxcbiAgICAgIHVzYWdlOiB7IG91dHB1dF90b2tlbnM6IDEgfSxcbiAgICB9LFxuICAgIHsgdHlwZTogXCJtZXNzYWdlX3N0b3BcIiB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGV2ZW50IG9mIGV2ZW50cykgcmVzcG9uc2Uud3JpdGUoYGV2ZW50OiAke2V2ZW50LnR5cGV9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShldmVudCl9XFxuXFxuYCk7XG4gIHJlc3BvbnNlLmVuZCgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjaGVjayhoYXJuZXNzOiBzdHJpbmcsIG5lc3RlZDogYm9vbGVhbikge1xuICBjb25zdCB0ZW1wb3JhcnkgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIndvcmtiZW5jaC1oYXJuZXNzLVwiKSk7XG4gIGNvbnN0IGNoZWNrb3V0ID0gam9pbih0ZW1wb3JhcnksIFwicHJvamVjdFwiKTtcbiAgY29uc3QgdGVzdEhvbWUgPSBqb2luKHRlbXBvcmFyeSwgXCJob21lXCIpO1xuICBjb25zdCBwcmV2aW91c0NvbmZpZ0hvbWUgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ09ORklHX0hPTUU7XG4gIGNvbnN0IGRpc3RyaWJ1dGlvbiA9IGpvaW4oY2hlY2tvdXQsIFwiLndvcmtiZW5jaFwiKTtcbiAgY29uc3QgbmFtZSA9IGB3b3JrYmVuY2gtcHJvYmUtJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgYWdlbnRzVG9rZW4gPSBgYWdlbnRzLSR7cmFuZG9tVVVJRCgpfWA7XG4gIGNvbnN0IGRlc2NyaXB0aW9uVG9rZW4gPSBgZGVzY3JpcHRpb24tJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgYm9keVRva2VuID0gYGJvZHktJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgaGlkZGVuVG9rZW4gPSBgZXhwbGljaXQtJHtyYW5kb21VVUlEKCl9YDtcbiAgY29uc3QgcmVxdWVzdHM6IEhhcm5lc3NSZXF1ZXN0W10gPSBbXTtcbiAgY29uc3Qgc2VydmVyRmFpbHVyZTogeyBlcnJvcj86IEVycm9yIH0gPSB7fTtcbiAgbGV0IHNlcnZlcjogU2VydmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGNoZWNrb3V0LCBcIndvcmtiZW5jaFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbWtkaXJTeW5jKHRlc3RIb21lKTtcbiAgICBmb3IgKGNvbnN0IGxhbmd1YWdlIG9mIFtcInJ1c3RcIiwgXCJweXRob25cIiwgXCJ0eXBlc2NyaXB0XCJdKSBta2RpclN5bmMoam9pbihjaGVja291dCwgbGFuZ3VhZ2UpKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oY2hlY2tvdXQsIFwiQUdFTlRTLm1kXCIpLCBgIyBUZXN0IHByb2plY3RcXG5cXG5GaXh0dXJlIGlkZW50aXR5OiAke2FnZW50c1Rva2VufS5cXG5gKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihjaGVja291dCwgXCJ3b3JrYmVuY2gvY29uZmlnLnRvbWxcIiksXG4gICAgICAnc2NoZW1hX3ZlcnNpb24gPSAxXFxuW21hcmtkb3duXVxcbndyYXBfd2lkdGggPSAxMjBcXG5bY29tcGF0aWJpbGl0eV1cXG5yZXF1aXJlZCA9IGZhbHNlXFxuW2NoZWNrc11cXG5lbnZpcm9ubWVudCA9IFwibmF0aXZlXCJcXG4nLFxuICAgICk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oY2hlY2tvdXQsIFwid29ya2JlbmNoL3Byb2plY3RzLnRvbWxcIiksXG4gICAgICAnW1twcm9qZWN0XV1cXG5pZCA9IFwicHJvYmVcIlxcbnBhdGggPSBcIi5cIlxcbicgK1xuICAgICAgICBbXCJydXN0XCIsIFwicHl0aG9uXCIsIFwidHlwZXNjcmlwdFwiXVxuICAgICAgICAgIC5tYXAoKGxhbmd1YWdlKSA9PiBgW1tsYW5ndWFnZV9yb290XV1cXG5sYW5ndWFnZSA9IFwiJHtsYW5ndWFnZX1cIlxcbnBhdGggPSBcIiR7bGFuZ3VhZ2V9XCJcXG5gKVxuICAgICAgICAgIC5qb2luKFwiXCIpLFxuICAgICk7XG4gICAgY3BTeW5jKGpvaW4ocm9vdCwgXCJza2lsbHNcIiksIGpvaW4oZGlzdHJpYnV0aW9uLCBcInNraWxsc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgZm9yIChjb25zdCBbc2tpbGwsIGRlc2NyaXB0aW9uLCBib2R5LCBleHBsaWNpdF0gb2YgW1xuICAgICAgW25hbWUsIGRlc2NyaXB0aW9uVG9rZW4sIGJvZHlUb2tlbiwgZmFsc2VdLFxuICAgICAgW1wid29ya2JlbmNoLWV4cGxpY2l0LXByb2JlXCIsIGhpZGRlblRva2VuLCBcIkV4cGxpY2l0LW9ubHkgZml4dHVyZS5cIiwgdHJ1ZV0sXG4gICAgXSBhcyBjb25zdCkge1xuICAgICAgY29uc3Qgc291cmNlID0gam9pbihkaXN0cmlidXRpb24sIFwic2tpbGxzL3dvcmtmbG93c1wiLCBza2lsbCk7XG4gICAgICBta2RpclN5bmMoc291cmNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oc291cmNlLCBcIlNLSUxMLm1kXCIpLFxuICAgICAgICBgLS0tXFxubmFtZTogJHtza2lsbH1cXG5kZXNjcmlwdGlvbjogJHtkZXNjcmlwdGlvbn1cXG4ke2V4cGxpY2l0ID8gXCJkaXNhYmxlLW1vZGVsLWludm9jYXRpb246IHRydWVcXG5cIiA6IFwiXCJ9LS0tXFxuXFxuJHtib2R5fVxcbmAsXG4gICAgICApO1xuICAgICAgaWYgKGV4cGxpY2l0KSB7XG4gICAgICAgIG1rZGlyU3luYyhqb2luKHNvdXJjZSwgXCJhZ2VudHNcIikpO1xuICAgICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc291cmNlLCBcImFnZW50cy9vcGVuYWkueWFtbFwiKSwgXCJwb2xpY3k6XFxuICBhbGxvd19pbXBsaWNpdF9pbnZvY2F0aW9uOiBmYWxzZVxcblwiKTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgY29uZmlndXJhdGlvbiA9IGpvaW4odGVzdEhvbWUsIFwid29ya2JlbmNoLWNvbmZpZ1wiKTtcbiAgICBta2RpclN5bmMoY29uZmlndXJhdGlvbik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oY29uZmlndXJhdGlvbiwgXCJjb25maWcudG9tbFwiKSxcbiAgICAgIGBbc2tpbGxzXVxcbmVuYWJsZWQgPSAke0pTT04uc3RyaW5naWZ5KFtuYW1lLCBcIndvcmtiZW5jaC1leHBsaWNpdC1wcm9iZVwiXSl9XFxuYCxcbiAgICApO1xuICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9DT05GSUdfSE9NRSA9IGNvbmZpZ3VyYXRpb247XG4gICAgc2tpbGxzLnN5bmNTa2lsbHMoY2hlY2tvdXQsIGRpc3RyaWJ1dGlvbik7XG4gICAgY29uc3QgY3dkID0gbmVzdGVkID8gam9pbihjaGVja291dCwgXCJydXN0XCIpIDogY2hlY2tvdXQ7XG4gICAgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXF1ZXN0LCByZXNwb25zZSkgPT4ge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGxldCByYXcgPSBcIlwiO1xuICAgICAgICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcmVxdWVzdCkge1xuICAgICAgICAgICAgY29uc3QgYnl0ZXM6IHVua25vd24gPSBjaHVuaztcbiAgICAgICAgICAgIGlmICghQnVmZmVyLmlzQnVmZmVyKGJ5dGVzKSkgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBoYXJuZXNzIHJlcXVlc3QgYnl0ZXNcIik7XG4gICAgICAgICAgICByYXcgKz0gYnl0ZXMudG9TdHJpbmcoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcGFyc2VkID0gcmVjb3JkKEpTT04ucGFyc2UocmF3IHx8IFwie31cIiksIFwiSW52YWxpZCBoYXJuZXNzIHJlcXVlc3RcIik7XG4gICAgICAgICAgaWYgKChyZXF1ZXN0LnVybCA/PyBcIlwiKS5pbmNsdWRlcyhcImNvdW50X3Rva2Vuc1wiKSkge1xuICAgICAgICAgICAgcmVzcG9uc2Uud3JpdGVIZWFkKDIwMCwgeyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9KTtcbiAgICAgICAgICAgIHJlc3BvbnNlLmVuZCgne1wiaW5wdXRfdG9rZW5zXCI6MX0nKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCEocmVxdWVzdC51cmwgPz8gXCJcIikuc3RhcnRzV2l0aChoYXJuZXNzID09PSBcImNvZGV4XCIgPyBcIi92MS9yZXNwb25zZXNcIiA6IFwiL3YxL21lc3NhZ2VzXCIpKSB7XG4gICAgICAgICAgICByZXNwb25zZS53cml0ZUhlYWQoNDA0KTtcbiAgICAgICAgICAgIHJlc3BvbnNlLmVuZCgpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBkYXRhID0gT2JqZWN0LmFzc2lnbihwYXJzZWQsIHtcbiAgICAgICAgICAgIHRvb2xzOiByZWNvcmRzKHBhcnNlZC50b29scywgXCJJbnZhbGlkIGhhcm5lc3MgdG9vbHNcIikubWFwKCh0b29sKSA9PiAoe1xuICAgICAgICAgICAgICAuLi50b29sLFxuICAgICAgICAgICAgICBuYW1lOiB0eXBlb2YgdG9vbC5uYW1lID09PSBcInN0cmluZ1wiID8gdG9vbC5uYW1lIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgfSkpLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJlcXVlc3RzLnB1c2goZGF0YSk7XG4gICAgICAgICAgaWYgKHJlcXVlc3RzLmxlbmd0aCA+IDMpIHRocm93IG5ldyBFcnJvcihcImhhcm5lc3MgZGlkIG5vdCBmaW5pc2ggdGhlIHByb2JlXCIpO1xuICAgICAgICAgIGNvbnN0IGZpcnN0ID0gcmVxdWVzdHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgIGlmIChoYXJuZXNzID09PSBcImNvZGV4XCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHRvb2wgPSBkYXRhLnRvb2xzLmZpbmQoXG4gICAgICAgICAgICAgICh0b29sKSA9PiB0b29sLm5hbWUgIT09IHVuZGVmaW5lZCAmJiBbXCJleGVjX2NvbW1hbmRcIiwgXCJzaGVsbF9jb21tYW5kXCJdLmluY2x1ZGVzKHRvb2wubmFtZSksXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKGZpcnN0ICYmICF0b29sKSB0aHJvdyBuZXcgRXJyb3IoXCJDb2RleCBkaWQgbm90IGV4cG9zZSBhIHN1cHBvcnRlZCBmaWxlLXJlYWRpbmcgY29tbWFuZCB0b29sXCIpO1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9IGpvaW4oY2hlY2tvdXQsIFwiLmFnZW50cy9za2lsbHNcIiwgbmFtZSwgXCJTS0lMTC5tZFwiKTtcbiAgICAgICAgICAgIGNvbnN0IGNvbW1hbmQgPSBgY2F0ICcke3BhdGgucmVwbGFjZUFsbChcIidcIiwgXCInXFxcXCcnXCIpfSdgO1xuICAgICAgICAgICAgcmVzcG9uZENvZGV4KFxuICAgICAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgICAgICAgZmlyc3RcbiAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgaWQ6IFwiZmNfcHJvYmVcIixcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogXCJmdW5jdGlvbl9jYWxsXCIsXG4gICAgICAgICAgICAgICAgICAgIGNhbGxfaWQ6IFwiY2FsbF9wcm9iZVwiLFxuICAgICAgICAgICAgICAgICAgICBuYW1lOiByZXF1aXJlZChyZXF1aXJlZCh0b29sLCBcIk1pc3NpbmcgY29tbWFuZCB0b29sXCIpLm5hbWUsIFwiTWlzc2luZyBjb21tYW5kIHRvb2wgbmFtZVwiKSxcbiAgICAgICAgICAgICAgICAgICAgYXJndW1lbnRzOiBKU09OLnN0cmluZ2lmeShcbiAgICAgICAgICAgICAgICAgICAgICByZXF1aXJlZCh0b29sLCBcIk1pc3NpbmcgY29tbWFuZCB0b29sXCIpLm5hbWUgPT09IFwiZXhlY19jb21tYW5kXCJcbiAgICAgICAgICAgICAgICAgICAgICAgID8geyBjbWQ6IGNvbW1hbmQsIGxvZ2luOiBmYWxzZSB9XG4gICAgICAgICAgICAgICAgICAgICAgICA6IHsgY29tbWFuZCwgd29ya2RpcjogY3dkIH0sXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgICAgIGlkOiBcIm1zZ19wcm9iZVwiLFxuICAgICAgICAgICAgICAgICAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICAgICAgICAgICAgICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgICAgICAgICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJvdXRwdXRfdGV4dFwiLCB0ZXh0OiBcIlByb2JlIGNvbXBsZXRlLlwiIH1dLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc3BvbmRDbGF1ZGUoXG4gICAgICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgICAgICBmaXJzdFxuICAgICAgICAgICAgICAgID8geyB0eXBlOiBcInRvb2xfdXNlXCIsIGlkOiBcInRvb2x1X3Byb2JlXCIsIG5hbWU6IFwiU2tpbGxcIiwgaW5wdXQ6IHsgc2tpbGw6IG5hbWUgfSB9XG4gICAgICAgICAgICAgICAgOiB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlByb2JlIGNvbXBsZXRlLlwiIH0sXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBzZXJ2ZXJGYWlsdXJlLmVycm9yID0gZXJyb3JGcm9tKGVycm9yKTtcbiAgICAgICAgICByZXNwb25zZS53cml0ZUhlYWQoNTAwKTtcbiAgICAgICAgICByZXNwb25zZS5lbmQoKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICB9KTtcbiAgICBjb25zdCBhY3RpdmVTZXJ2ZXIgPSBzZXJ2ZXI7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKGRvbmUpID0+IHtcbiAgICAgIGFjdGl2ZVNlcnZlci5saXN0ZW4oMCwgXCIxMjcuMC4wLjFcIiwgZG9uZSk7XG4gICAgfSk7XG4gICAgY29uc3QgYWRkcmVzcyA9IGFjdGl2ZVNlcnZlci5hZGRyZXNzKCk7XG4gICAgYXNzZXJ0Lm9rKGFkZHJlc3MgJiYgdHlwZW9mIGFkZHJlc3MgIT09IFwic3RyaW5nXCIsIFwiTWlzc2luZyBUQ1Agc2VydmVyIGFkZHJlc3NcIik7XG4gICAgY29uc3QgYmFzZSA9IGBodHRwOi8vMTI3LjAuMC4xOiR7U3RyaW5nKGFkZHJlc3MucG9ydCl9YDtcbiAgICAvLyBUaGVzZSBhcmUgY2hpbGQtcHJvY2VzcyBhcHBsaWNhdGlvbiBkaXJlY3RvcmllcywgbmV2ZXIgdGhlIGludm9raW5nIHVzZXIncyBzdGF0ZS5cbiAgICBjb25zdCBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ICYgeyBDT0RFWF9IT01FOiBzdHJpbmc7IENMQVVERV9DT05GSUdfRElSOiBzdHJpbmcgfSA9IHtcbiAgICAgIFBBVEg6IHByb2Nlc3MuZW52LlBBVEgsXG4gICAgICBIT01FOiB0ZXN0SG9tZSxcbiAgICAgIFVTRVJQUk9GSUxFOiB0ZXN0SG9tZSxcbiAgICAgIExBTkc6IFwiQy5VVEYtOFwiLFxuICAgICAgVE1QRElSOiB0ZW1wb3JhcnksXG4gICAgICBYREdfQ09ORklHX0hPTUU6IGpvaW4odGVzdEhvbWUsIFwiY29uZmlnXCIpLFxuICAgICAgWERHX0NBQ0hFX0hPTUU6IGpvaW4odGVzdEhvbWUsIFwiY2FjaGVcIiksXG4gICAgICBYREdfREFUQV9IT01FOiBqb2luKHRlc3RIb21lLCBcImRhdGFcIiksXG4gICAgICBYREdfU1RBVEVfSE9NRTogam9pbih0ZXN0SG9tZSwgXCJzdGF0ZVwiKSxcbiAgICAgIENPREVYX0hPTUU6IGpvaW4odGVzdEhvbWUsIFwiLmNvZGV4XCIpLFxuICAgICAgQ0xBVURFX0NPTkZJR19ESVI6IGpvaW4odGVzdEhvbWUsIFwiLmNsYXVkZVwiKSxcbiAgICAgIERJU0FCTEVfQVVUT1VQREFURVI6IFwiMVwiLFxuICAgICAgRElTQUJMRV9URUxFTUVUUlk6IFwiMVwiLFxuICAgICAgRElTQUJMRV9FUlJPUl9SRVBPUlRJTkc6IFwiMVwiLFxuICAgICAgQ0xBVURFX0NPREVfRElTQUJMRV9OT05FU1NFTlRJQUxfVFJBRkZJQzogXCIxXCIsXG4gICAgICBDTEFVREVfQ09ERV9TS0lQX1BST01QVF9ISVNUT1JZOiBcIjFcIixcbiAgICB9O1xuICAgIG1rZGlyU3luYyhlbnYuQ09ERVhfSE9NRSk7XG4gICAgbWtkaXJTeW5jKGVudi5DTEFVREVfQ09ORklHX0RJUik7XG4gICAgYXdhaXQgcnVuKFwiZ2l0XCIsIFtcIi1jXCIsIFwiaW5pdC5kZWZhdWx0QnJhbmNoPW1haW5cIiwgXCJpbml0XCIsIFwiLS1xdWlldFwiXSwgY2hlY2tvdXQsIGVudik7XG4gICAgY29uc3QgcHJvbXB0ID0gXCJSdW4gdGhlIFdvcmtiZW5jaCBkaXNjb3ZlcnkgcHJvYmUgc2tpbGwgYXZhaWxhYmxlIGluIHRoaXMgcHJvamVjdCwgdGhlbiBmaW5pc2guXCI7XG4gICAgY29uc3QgYXJncyA9XG4gICAgICBoYXJuZXNzID09PSBcImNvZGV4XCJcbiAgICAgICAgPyBbXG4gICAgICAgICAgICBcImV4ZWNcIixcbiAgICAgICAgICAgIFwiLS1lcGhlbWVyYWxcIixcbiAgICAgICAgICAgIFwiLS1pZ25vcmUtdXNlci1jb25maWdcIixcbiAgICAgICAgICAgIFwiLS1pZ25vcmUtcnVsZXNcIixcbiAgICAgICAgICAgIFwiLS1zYW5kYm94XCIsXG4gICAgICAgICAgICBcInJlYWQtb25seVwiLFxuICAgICAgICAgICAgXCItY1wiLFxuICAgICAgICAgICAgJ2FwcHJvdmFsX3BvbGljeT1cIm5ldmVyXCInLFxuICAgICAgICAgICAgXCItY1wiLFxuICAgICAgICAgICAgJ21vZGVsPVwid29ya2JlbmNoLWRpc2NvdmVyeS1wcm9iZVwiJyxcbiAgICAgICAgICAgIFwiLWNcIixcbiAgICAgICAgICAgICdtb2RlbF9wcm92aWRlcj1cIndvcmtiZW5jaF90ZXN0XCInLFxuICAgICAgICAgICAgXCItY1wiLFxuICAgICAgICAgICAgJ21vZGVsX3Byb3ZpZGVycy53b3JrYmVuY2hfdGVzdC5uYW1lPVwiV29ya2JlbmNoIGZpeHR1cmVcIicsXG4gICAgICAgICAgICBcIi1jXCIsXG4gICAgICAgICAgICBgbW9kZWxfcHJvdmlkZXJzLndvcmtiZW5jaF90ZXN0LmJhc2VfdXJsPVwiJHtiYXNlfS92MVwiYCxcbiAgICAgICAgICAgIFwiLWNcIixcbiAgICAgICAgICAgICdtb2RlbF9wcm92aWRlcnMud29ya2JlbmNoX3Rlc3Qud2lyZV9hcGk9XCJyZXNwb25zZXNcIicsXG4gICAgICAgICAgICBcIi1jXCIsXG4gICAgICAgICAgICBcIm1vZGVsX3Byb3ZpZGVycy53b3JrYmVuY2hfdGVzdC5yZXF1aXJlc19vcGVuYWlfYXV0aD1mYWxzZVwiLFxuICAgICAgICAgICAgcHJvbXB0LFxuICAgICAgICAgIF1cbiAgICAgICAgOiBbXG4gICAgICAgICAgICBcIi0tcHJpbnRcIixcbiAgICAgICAgICAgIFwiLS1uby1zZXNzaW9uLXBlcnNpc3RlbmNlXCIsXG4gICAgICAgICAgICBcIi0tb3V0cHV0LWZvcm1hdFwiLFxuICAgICAgICAgICAgXCJqc29uXCIsXG4gICAgICAgICAgICBcIi0tbW9kZWxcIixcbiAgICAgICAgICAgIFwid29ya2JlbmNoLWRpc2NvdmVyeS1wcm9iZVwiLFxuICAgICAgICAgICAgXCItLXRvb2xzXCIsXG4gICAgICAgICAgICBcIlNraWxsXCIsXG4gICAgICAgICAgICBcIi0tYWxsb3dlZFRvb2xzXCIsXG4gICAgICAgICAgICBcIlNraWxsXCIsXG4gICAgICAgICAgICBcIi0tcGVybWlzc2lvbi1tb2RlXCIsXG4gICAgICAgICAgICBcImRvbnRBc2tcIixcbiAgICAgICAgICAgIFwiLS1zZXR0aW5nLXNvdXJjZXNcIixcbiAgICAgICAgICAgIFwicHJvamVjdFwiLFxuICAgICAgICAgICAgXCItLXN0cmljdC1tY3AtY29uZmlnXCIsXG4gICAgICAgICAgICBcIi0tbWNwLWNvbmZpZ1wiLFxuICAgICAgICAgICAgJ3tcIm1jcFNlcnZlcnNcIjp7fX0nLFxuICAgICAgICAgICAgXCItLVwiLFxuICAgICAgICAgICAgcHJvbXB0LFxuICAgICAgICAgIF07XG4gICAgaWYgKGhhcm5lc3MgPT09IFwiY2xhdWRlXCIpIHtcbiAgICAgIGVudi5BTlRIUk9QSUNfQkFTRV9VUkwgPSBiYXNlO1xuICAgICAgZW52LkFOVEhST1BJQ19BUElfS0VZID0gXCJ3b3JrYmVuY2gtbG9jYWwtZml4dHVyZVwiO1xuICAgIH1cbiAgICBjb25zdCB2ZXJzaW9uID0gKGF3YWl0IHJ1bihoYXJuZXNzLCBbXCItLXZlcnNpb25cIl0sIGN3ZCwgZW52KSkudHJpbSgpO1xuICAgIGF3YWl0IHJ1bihoYXJuZXNzLCBhcmdzLCBjd2QsIGVudik7XG4gICAgaWYgKHNlcnZlckZhaWx1cmUuZXJyb3IpIHRocm93IHNlcnZlckZhaWx1cmUuZXJyb3I7XG4gICAgYXNzZXJ0Lm9rKHJlcXVlc3RzLmxlbmd0aCA+PSAyLCBcImhhcm5lc3MgbXVzdCBsb2FkIGEgc2tpbGwgYmVmb3JlIGNvbXBsZXRpbmdcIik7XG4gICAgY29uc3QgaW5pdGlhbCA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RzWzBdKTtcbiAgICBhc3NlcnQub2soaW5pdGlhbC5pbmNsdWRlcyhhZ2VudHNUb2tlbiksIFwicm9vdCBBR0VOVFMubWQgd2FzIG5vdCBhdXRvbWF0aWNhbGx5IGxvYWRlZFwiKTtcbiAgICBhc3NlcnQub2soaW5pdGlhbC5pbmNsdWRlcyhuYW1lKSwgXCJhcHBsaWNhYmxlIHNraWxsIHdhcyBub3QgZGlzY292ZXJlZFwiKTtcbiAgICBhc3NlcnQub2soIWluaXRpYWwuaW5jbHVkZXMoYm9keVRva2VuKSwgXCJza2lsbCBib2R5IHdhcyBsb2FkZWQgYmVmb3JlIGludm9jYXRpb25cIik7XG4gICAgYXNzZXJ0Lm9rKCFpbml0aWFsLmluY2x1ZGVzKFwid29ya2JlbmNoLWV4cGxpY2l0LXByb2JlXCIpLCBcImV4cGxpY2l0LW9ubHkgc2tpbGwgbGVha2VkIGludG8gaW1wbGljaXQgZGlzY292ZXJ5XCIpO1xuICAgIGFzc2VydC5vayghaW5pdGlhbC5pbmNsdWRlcyhcIndvcmtiZW5jaC1hdWRpdFwiKSwgXCJwYWNrYWdlZCBhdWRpdCBtdXN0IHJlcXVpcmUgZXhwbGljaXQgaW52b2NhdGlvblwiKTtcbiAgICBhc3NlcnQub2soSlNPTi5zdHJpbmdpZnkocmVxdWVzdHMuc2xpY2UoMSkpLmluY2x1ZGVzKGJvZHlUb2tlbiksIFwiaW52b2tlZCBza2lsbCBib2R5IGRpZCBub3QgcmVhY2ggbW9kZWwgY29udGV4dFwiKTtcbiAgICBmb3IgKGNvbnN0IFtkaXJlY3RvcnksIHBhdHRlcm5dIG9mIFtcbiAgICAgIFtlbnYuQ09ERVhfSE9NRSwgLyhefFxcLykoc2Vzc2lvbnNcXC8uKlxcLmpzb25sfGhpc3RvcnlcXC5qc29ubCkkL10sXG4gICAgICBbZW52LkNMQVVERV9DT05GSUdfRElSLCAvKF58XFwvKShwcm9qZWN0c1xcLy4qXFwuanNvbmx8aGlzdG9yeVxcLmpzb25sKSQvXSxcbiAgICBdIGFzIGNvbnN0KSB7XG4gICAgICBjb25zdCByZXRhaW5lZCA9IHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyByZWN1cnNpdmU6IHRydWUsIGVuY29kaW5nOiBcInV0ZjhcIiB9KS5maWx0ZXIoKHBhdGgpID0+XG4gICAgICAgIHBhdHRlcm4udGVzdChwYXRoKSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJldGFpbmVkLCBbXSwgXCJlcGhlbWVyYWwgcHJvYmUgcmV0YWluZWQgY29udmVyc2F0aW9uIGhpc3RvcnlcIik7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYCR7dmVyc2lvbn06ICR7bmVzdGVkID8gXCJuZXN0ZWRcIiA6IFwicm9vdFwifSBBR0VOVFMubWQsIGRpc2NvdmVyeSwgaW52b2NhdGlvbiwgYW5kIGhpc3RvcnkgaXNvbGF0aW9uIHBhc3NlZC5gLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHByZXZpb3VzQ29uZmlnSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTkZJR19IT01FO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NPTkZJR19IT01FID0gcHJldmlvdXNDb25maWdIb21lO1xuICAgIGlmIChzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5jbG9zZUFsbENvbm5lY3Rpb25zKCk7XG4gICAgICBjb25zdCBhY3RpdmVTZXJ2ZXIgPSBzZXJ2ZXI7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigoZG9uZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGFjdGl2ZVNlcnZlci5jbG9zZSgoZXJyb3IpID0+IHtcbiAgICAgICAgICBpZiAoZXJyb3IpIHJlamVjdChlcnJvcik7XG4gICAgICAgICAgZWxzZSBkb25lKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJtU3luYyh0ZW1wb3JhcnksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG5sZXQgZmFpbGVkID0gZmFsc2U7XG5mb3IgKGNvbnN0IGhhcm5lc3Mgb2YgbmV3IFNldChzZWxlY3RlZCkpIHtcbiAgZm9yIChjb25zdCBuZXN0ZWQgb2YgW2ZhbHNlLCB0cnVlXSkge1xuICAgIGlmIChpbnRlcnJ1cHRpb24ub2NjdXJyZWQpIGJyZWFrO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjaGVjayhoYXJuZXNzLCBuZXN0ZWQpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBmYWlsZWQgPSB0cnVlO1xuICAgICAgY29uc29sZS5lcnJvcihgJHtoYXJuZXNzfSAoJHtuZXN0ZWQgPyBcIm5lc3RlZFwiIDogXCJyb290XCJ9KTogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWApO1xuICAgIH1cbiAgfVxufVxucHJvY2Vzcy5leGl0Q29kZSA9IGludGVycnVwdGlvbi5vY2N1cnJlZCA/IDEzMCA6IGZhaWxlZCA/IDEgOiAwO1xuIl0sIm1hcHBpbmdzIjoiO0FBQ0EsU0FBUyxVQUFVLFVBQVUsUUFBUSxTQUFTLGlCQUFpQjtBQUMvRCxTQUFTLG9CQUFvQjtBQUk3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsUUFBUSxXQUFXLGFBQWEsYUFBYSxRQUFRLHFCQUFxQjtBQUNuRixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGNBQWM7QUFDdkIsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxxQkFBcUI7QUFDOUIsTUFBTSxTQUFTLGNBQWMsWUFBWSxHQUFHLEVBQUUsc0JBQXNCO0FBR3BFLE1BQU0sT0FBTyxRQUFRLGNBQWMsSUFBSSxJQUFJLE1BQU0sWUFBWSxHQUFHLENBQUMsQ0FBQztBQUNsRSxNQUFNLFdBQVcsUUFBUSxLQUFLLE1BQU0sQ0FBQztBQUNyQyxNQUFNLGVBQWUsRUFBRSxVQUFVLE1BQU07QUFDdkMsSUFBSSxDQUFDLFNBQVMsVUFBVSxTQUFTLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxTQUFTLFFBQVEsRUFBRSxTQUFTLElBQUksQ0FBQyxHQUFHO0FBQ3BGLFVBQVEsTUFBTSx3REFBd0Q7QUFDdEUsVUFBUSxLQUFLLENBQUM7QUFDaEI7QUFFQSxTQUFTLElBQUks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Q0FBQztBQUMxQyxXQUFPLEdBQUcsUUFBUSxTQUFTLFdBQVcsR0FBRyw2Q0FBNkM7QUFDdEYsV0FBTyxHQUFHLFFBQVEsU0FBUyxJQUFJLEdBQUcscUNBQXFDO0FBQ3ZFLFdBQU8sR0FBRyxDQUFDLFFBQVEsU0FBUyxTQUFTLEdBQUcseUNBQXlDO0FBQ2pGLFdBQU8sR0FBRyxDQUFDLFFBQVEsU0FBUywwQkFBMEIsR0FBRyxvREFBb0Q7QUFDN0csV0FBTyxHQUFHLENBQUMsUUFBUSxTQUFTLGlCQUFpQixHQUFHLGlEQUFpRDtBQUNqRyxXQUFPLEdBQUcsS0FBSyxVQUFVLFNBQVMsTUFBTSxDQUFDLENBQUMsRUFBRSxTQUFTLFNBQVMsR0FBRyxnREFBZ0Q7QUFDakgsZUFBVyxDQUFDLFdBQVcsT0FBTyxLQUFLO0FBQUEsTUFDakMsQ0FBQyxJQUFJLFlBQVksNkNBQTZDO0FBQUEsTUFDOUQsQ0FBQyxJQUFJLG1CQUFtQiw2Q0FBNkM7QUFBQSxJQUN2RSxHQUFZO0FBQ1YsWUFBTSxXQUFXLFlBQVksV0FBVyxFQUFFLFdBQVcsTUFBTSxVQUFVLE9BQU8sQ0FBQyxFQUFFO0FBQUEsUUFBTyxDQUFDLFNBQ3JGLFFBQVEsS0FBSyxJQUFJO0FBQUEsTUFDbkI7QUFDQSxhQUFPLFVBQVUsVUFBVSxDQUFDLEdBQUcsK0NBQStDO0FBQUEsSUFDaEY7QUFDQSxZQUFRO0FBQUEsTUFDTixHQUFHLE9BQU8sS0FBSyxTQUFTLFdBQVcsTUFBTTtBQUFBLElBQzNDO0FBQUEsRUFDRixVQUFFO0FBQ0EsUUFBSSx1QkFBdUIsT0FBVyxRQUFPLFFBQVEsSUFBSTtBQUFBLFFBQ3BELFNBQVEsSUFBSSx3QkFBd0I7QUFDekMsUUFBSSxRQUFRO0FBQ1YsYUFBTyxvQkFBb0I7QUFDM0IsWUFBTSxlQUFlO0FBQ3JCLFlBQU0sSUFBSSxRQUFjLENBQUMsTUFBTSxXQUFXO0FBQ3hDLHFCQUFhLE1BQU0sQ0FBQyxVQUFVO0FBQzVCLGNBQUksTUFBTyxRQUFPLEtBQUs7QUFBQSxjQUNsQixNQUFLO0FBQUEsUUFDWixDQUFDO0FBQUEsTUFDSCxDQUFDO0FBQUEsSUFDSDtBQUNBLFdBQU8sV0FBVyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ3BEO0FBQ0Y7QUFFQSxJQUFJLFNBQVM7QUFDYixXQUFXLFdBQVcsSUFBSSxJQUFJLFFBQVEsR0FBRztBQUN2QyxhQUFXLFVBQVUsQ0FBQyxPQUFPLElBQUksR0FBRztBQUNsQyxRQUFJLGFBQWEsU0FBVTtBQUMzQixRQUFJO0FBQ0YsWUFBTSxNQUFNLFNBQVMsTUFBTTtBQUFBLElBQzdCLFNBQVMsT0FBTztBQUNkLGVBQVM7QUFDVCxjQUFRLE1BQU0sR0FBRyxPQUFPLEtBQUssU0FBUyxXQUFXLE1BQU0sTUFBTSxhQUFhLEtBQUssQ0FBQyxFQUFFO0FBQUEsSUFDcEY7QUFBQSxFQUNGO0FBQ0Y7QUFDQSxRQUFRLFdBQVcsYUFBYSxXQUFXLE1BQU0sU0FBUyxJQUFJOyIsIm5hbWVzIjpbInRvb2wiXSwiZmlsZSI6InNjcmlwdHMvY2hlY2staGFybmVzc2VzLm1qcyJ9

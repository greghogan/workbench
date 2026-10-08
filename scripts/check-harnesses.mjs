import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import skills from "../bundle/skills.cjs";

// Real harnesses, synthetic model responses: no credentials, inference, or user history.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const selected = process.argv.slice(2);
let interrupted = false;
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
          if (error.code !== "ESRCH") throw error;
        }
      }
    };
    const timer = setTimeout(stop, 60000);
    const onInterrupt = () => {
      interrupted = true;
      stop();
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      stop();
      if (code !== 0) reject(new Error(`${command}: ${signal ?? code}\n${(output + errors).slice(-6000)}`));
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
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool ? { ...block, input: {} } : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function check(harness, nested) {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-harness-"));
  const checkout = join(temporary, "project");
  const testHome = join(temporary, "home");
  const distribution = join(checkout, ".workbench");
  const name = `workbench-probe-${randomUUID()}`;
  const agentsToken = `agents-${randomUUID()}`;
  const descriptionToken = `description-${randomUUID()}`;
  const bodyToken = `body-${randomUUID()}`;
  const hiddenToken = `explicit-${randomUUID()}`;
  const requests = [];
  let serverError;
  let server;
  try {
    mkdirSync(join(checkout, "workbench"), { recursive: true });
    mkdirSync(testHome);
    for (const language of ["rust", "python", "typescript"]) mkdirSync(join(checkout, language));
    writeFileSync(join(checkout, "AGENTS.md"), `# Test project\n\nFixture identity: ${agentsToken}.\n`);
    writeFileSync(join(checkout, "workbench/config.toml"), 'schema_version = 4\n[checks]\nenvironment = "native"\n');
    writeFileSync(
      join(checkout, "workbench/projects.toml"),
      '[[project]]\nid = "probe"\npath = "."\n' +
        ["rust", "python", "typescript"]
          .map((language) => `[[language_root]]\nlanguage = "${language}"\npath = "${language}"\n`)
          .join(""),
    );
    cpSync(join(root, "skills"), join(distribution, "skills"), { recursive: true });
    for (const [skill, description, body, explicit] of [
      [name, descriptionToken, bodyToken, false],
      ["workbench-explicit-probe", hiddenToken, "Explicit-only fixture.", true],
    ]) {
      const source = join(distribution, "skills/workflows", skill);
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, "SKILL.md"),
        `---\nname: ${skill}\ndescription: ${description}\n${explicit ? "disable-model-invocation: true\n" : ""}---\n\n${body}\n`,
      );
      if (explicit) {
        mkdirSync(join(source, "agents"));
        writeFileSync(join(source, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
      }
    }
    skills.syncSkills(checkout, distribution);
    const cwd = nested ? join(checkout, "rust") : checkout;
    server = createServer(async (request, response) => {
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const data = JSON.parse(raw || "{}");
        if (request.url.includes("count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"input_tokens":1}');
          return;
        }
        if (!request.url.startsWith(harness === "codex" ? "/v1/responses" : "/v1/messages")) {
          response.writeHead(404);
          response.end();
          return;
        }
        requests.push(data);
        if (requests.length > 3) throw new Error("harness did not finish the probe");
        const first = requests.length === 1;
        if (harness === "codex") {
          const tool = data.tools.find((tool) => ["exec_command", "shell_command"].includes(tool.name));
          if (first && !tool) throw new Error("Codex did not expose a supported file-reading command tool");
          const path = join(checkout, ".agents/skills", name, "SKILL.md");
          const command = `cat '${path.replaceAll("'", "'\\''")}'`;
          respondCodex(
            response,
            first
              ? {
                  id: "fc_probe",
                  type: "function_call",
                  call_id: "call_probe",
                  name: tool.name,
                  arguments: JSON.stringify(
                    tool.name === "exec_command" ? { cmd: command, login: false } : { command, workdir: cwd },
                  ),
                }
              : {
                  id: "msg_probe",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Probe complete." }],
                },
          );
        } else {
          respondClaude(
            response,
            first
              ? { type: "tool_use", id: "toolu_probe", name: "Skill", input: { skill: name } }
              : { type: "text", text: "Probe complete." },
          );
        }
      } catch (error) {
        serverError = error;
        response.writeHead(500);
        response.end();
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${server.address().port}`;
    // These are child-process application directories, never the invoking user's state.
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
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    };
    mkdirSync(env.CODEX_HOME);
    mkdirSync(env.CLAUDE_CONFIG_DIR);
    await run("git", ["-c", "init.defaultBranch=main", "init", "--quiet"], checkout, env);
    const prompt = "Run the Workbench discovery probe skill available in this project, then finish.";
    const args =
      harness === "codex"
        ? [
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
            prompt,
          ]
        : [
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
            prompt,
          ];
    if (harness === "claude") {
      env.ANTHROPIC_BASE_URL = base;
      env.ANTHROPIC_API_KEY = "workbench-local-fixture";
    }
    const version = (await run(harness, ["--version"], cwd, env)).trim();
    await run(harness, args, cwd, env);
    if (serverError) throw serverError;
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
      [env.CLAUDE_CONFIG_DIR, /(^|\/)(projects\/.*\.jsonl|history\.jsonl)$/],
    ]) {
      const retained = readdirSync(directory, { recursive: true }).filter((path) => pattern.test(path));
      assert.deepEqual(retained, [], "ephemeral probe retained conversation history");
    }
    console.log(
      `${version}: ${nested ? "nested" : "root"} AGENTS.md, discovery, invocation, and history isolation passed.`,
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

let failed = false;
for (const harness of new Set(selected)) {
  for (const nested of [false, true]) {
    if (interrupted) break;
    try {
      await check(harness, nested);
    } catch (error) {
      failed = true;
      console.error(`${harness} (${nested ? "nested" : "root"}): ${error.message}`);
    }
  }
}
process.exitCode = interrupted ? 130 : failed ? 1 : 0;

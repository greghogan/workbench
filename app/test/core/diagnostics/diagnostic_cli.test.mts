import { startDiagnosticSession } from "../../../src/core/diagnostics/diagnostic-session.ts";
import {
  diagnostic,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome,
  configureDiagnostics,
} from "../../../src/core/diagnostics/diagnostics.mjs";
import { vi, expect, test } from "vitest";
import { launcherCommand } from "../../../src/cli/launcher.ts";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { stageFixtures } from "../../fixtures/check-stages.mjs";
import { readLog } from "../../../src/core/storage/logs/log-reader.ts";
const fixture = stageFixtures();
const executable = resolve(import.meta.dirname, "../../../../bin/workbench.mjs");
function invoke(root: string, args: string[], state = join(root, "state")) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      WORKBENCH_PROJECT_ROOT: root,
      WORKBENCH_CONFIG_HOME: join(root, "preferences"),
      WORKBENCH_STATE_HOME: state,
      WORKBENCH_SYSTEM_RUNTIME_DIRECTORY: join(root, "system-runtime"),
    },
  });
}
test("default diagnostics stay quiet, keep structured stdout intact, and retain a complete session", async () => {
  const { root } = fixture();
  const result = invoke(root, ["project", "--json", "--log-level", "debug", "--log-format", "json"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(0);
  expect(result.stderr).toBe("");
  const namespace = join(root, "state/logs/cli"),
    run = readdirSync(namespace).find((name) => /^[a-f0-9-]{36}$/.test(name));
  if (!run) throw new Error("Expected retained diagnostic session");
  const chunks: Buffer[] = [];
  await readLog(
    join(namespace, run, "events.jsonl"),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  const saved = Buffer.concat(chunks).toString();
  expect(saved).toContain('"operation":"command"');
  expect(saved).toContain('"outcome":"completed"');
});
test("unavailable persistent storage is explicit without preventing the requested inspection", () => {
  const { root } = fixture(),
    state = join(root, "valuable-file");
  writeFileSync(state, "preserve user data");
  const result = invoke(root, ["project", "--json", "--log-format", "json"], state);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(0);
  expect(result.stderr).toContain('"operation":"diagnostics.persist"');
  expect(result.stderr).toContain('"outcome":"unavailable"');
  expect(readFileSync(state, "utf8")).toBe("preserve user data");
});

test("a zero byte budget disables new CLI histories while zero age permits size-bounded saving", () => {
  const { root } = fixture();
  mkdirSync(join(root, "preferences"));
  const config = join(root, "preferences/config.toml");
  writeFileSync(config, "[logs]\ncli_max_bytes=0\ncli_max_age_days=0\n");
  const disabled = invoke(root, ["project", "--json"]);
  expect(disabled.status, disabled.stderr).toBe(0);
  expect(disabled.stderr).toBe("");
  expect(JSON.parse(disabled.stdout)).toEqual([]);
  expect(existsSync(join(root, "state/logs/cli"))).toBe(false);
  writeFileSync(config, "[logs]\ncli_max_bytes=250000000\ncli_max_age_days=0\n");
  const enabled = invoke(root, ["project", "--json"]);
  expect(enabled.status, enabled.stderr).toBe(0);
  expect(enabled.stderr).toBe("");
  expect(readdirSync(join(root, "state/logs/cli")).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(1);
});

test.each([["--help"], ["completion", "bash"], ["complete"]])(
  "help and internal discovery do not create diagnostic histories: %j",
  (...args) => {
    const { root } = fixture();
    const result = invoke(root, args);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "state/logs"))).toBe(false);
  },
);

test("a command failure identifies a readable retained session without mixing diagnostics into stdout", () => {
  const { root } = fixture();
  const result = invoke(root, ["logs", "read", join(root, "missing.log"), "--log-format", "json"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  const event = JSON.parse(result.stderr.trim()) as { fields: { diagnostics: string }; error: { message: string } };
  expect(event.error.message).toContain("missing.log");
  const read = invoke(root, ["logs", "read", event.fields.diagnostics]);
  expect(read.status, read.stderr).toBe(0);
  const events = read.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { operation: string; outcome: string });
  expect(events).toContainEqual(expect.objectContaining({ operation: "command", outcome: "started" }));
  expect(events).toContainEqual(expect.objectContaining({ operation: "command", outcome: "failed" }));
  expect(events.some((entry) => entry.operation === "command" && entry.outcome === "completed")).toBe(false);
});
test.each([LogLevel.Info, LogLevel.Warn])(
  "failed server startup retains its diagnostics at stderr level %s",
  async (level) => {
    const { root } = fixture();
    vi.stubEnv("WORKBENCH_LOG_FILE_LEVEL", undefined);
    const registration = invoke(root, ["project", "add", root]);
    expect(registration.status, registration.stderr).toBe(0);
    const result = invoke(root, ["serve", "--port", "65536", "--log-level", level, "--log-format", "json"]);
    const failure = "serve requires a loopback host and a port from 0 to 65535";
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(failure);
    if (level === LogLevel.Warn) expect(result.stderr).not.toContain('"level":"info"');
    const namespace = join(root, "state/logs/server");
    const sessions = readdirSync(namespace).filter((name) => /^[a-f0-9-]{36}$/.test(name));
    expect(sessions).toHaveLength(1);
    const session = join(namespace, sessions[0] ?? "");
    expect(result.stderr).toContain(JSON.stringify(session));

    const chunks: Buffer[] = [];
    await readLog(
      session,
      new Writable({
        write(bytes: Buffer, _encoding, callback) {
          chunks.push(bytes);
          callback();
        },
      }),
    );
    const stderr = invoke(root, ["logs", "read", session, "--stream", "stderr"]);
    expect(stderr.status, stderr.stderr).toBe(0);
    expect(stderr.stdout).toContain(failure);
    if (level === LogLevel.Warn) expect(stderr.stdout).not.toContain('"level":"info"');
    const saved = Buffer.concat(chunks).toString();
    const events = saved
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { level: string; operation: string; outcome: string });
    expect(events).toContainEqual(expect.objectContaining({ level: "info", operation: "command", outcome: "started" }));
    expect(saved).toContain(failure);
  },
);
test("shared enum validation rejects invalid diagnostic configuration before changing user preferences", () => {
  const { root } = fixture();
  const bad = invoke(root, [
    "config",
    "set",
    "diagnostics.level",
    "trace",
    "--scope",
    "global",
    "--log-format",
    "json",
  ]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("diagnostics.level requires");
  const good = invoke(root, ["config", "set", "diagnostics.level", "debug", "--scope", "global"]);
  expect(good.status, good.stdout + good.stderr).toBe(0);
  expect(readFileSync(join(root, "preferences/config.toml"), "utf8")).toContain('level = "debug"');
});

test("usage errors have one presentation, command-specific help, and structured causes in JSON mode", () => {
  const { root } = fixture();
  const text = invoke(root, ["logs", "read", "ignored.log", "--log-save"]);
  expect(text.status).toBe(1);
  expect(text.stdout).toBe("");
  expect(text.stderr).toContain("unknown option");
  expect(text.stderr.match(/unknown option/g)).toHaveLength(1);
  expect(text.stderr).toContain("workbench help logs read");
  expect(text.stderr).not.toContain("Usage:");
  vi.stubEnv("WORKBENCH_LOG_LEVEL", "invalid-inherited-level");
  const json = invoke(root, ["logs", "read", "ignored.log", "--log-format", "json", "--unknown-option"]);
  vi.stubEnv("WORKBENCH_LOG_LEVEL", undefined);
  expect(json.status).toBe(1);
  expect(json.stdout).toBe("");
  const events = json.stderr
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          fields: { command: string };
          error: { message: string; causes: { code: string }[] };
        },
    );
  expect(events).toHaveLength(1);
  expect(events[0]?.fields.command).toBe("logs read");
  expect(events[0]?.error.message).toContain("unknown option");
  expect(events[0]?.error.causes[0]?.code).toBe("commander.unknownOption");
  expect(existsSync(join(root, "state"))).toBe(false);
  const help = invoke(root, ["help", "logs", "read"]);
  expect(help.status, help.stdout + help.stderr).toBe(0);
  expect(help.stdout).toContain("Usage: workbench logs read");
  expect(help.stderr).toBe("");
});

test("shared diagnostic flags preserve launcher command selection before dispatch", () => {
  expect(launcherCommand(["--log-level", "debug", "--log-format=json", "--plain", "install"])).toBe("install");
  expect(launcherCommand(["--log-level=info", "--log-format", "text", "project", "--json"])).toBe("project");
});
test("reading retained logs does not require a valid current project schema", () => {
  const { root } = fixture(),
    path = join(root, "retained.log");
  writeFileSync(path, "retained failure evidence\n");
  writeFileSync(join(root, "workbench/config.toml"), "schema_version=999\n");
  const result = invoke(root, ["logs", "read", path]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toBe("retained failure evidence\n");
});

test("text stderr preferences still retain independently parseable JSON diagnostic events", async () => {
  const { root } = fixture();
  const result = invoke(root, ["project", "--json", "--log-format", "text"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const namespace = join(root, "state/logs/cli"),
    run = readdirSync(namespace).find((name) => /^[a-f0-9-]{36}$/.test(name));
  if (!run) throw new Error("missing session");
  const lines: Buffer[] = [];
  await readLog(
    join(namespace, run, "events.jsonl"),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        lines.push(bytes);
        callback();
      },
    }),
  );
  const events = Buffer.concat(lines)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { version: number });
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.version === 1)).toBe(true);
});
test("saved JSON diagnostics preserve quoting while redacting credential-bearing messages", async () => {
  const { root } = fixture();
  vi.stubEnv("WORKBENCH_CONFIG_HOME", join(root, "preferences"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  configureDiagnostics({ level: "debug", sink: () => undefined });
  const session = await startDiagnosticSession();
  try {
    diagnostic(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { evidence: 'token="canary-private value"' },
      Object.assign(new Error('password="canary-private value"'), { stack: "retained debug stack" }),
    );
  } finally {
    await session.close();
    configureDiagnostics();
  }
  const chunks: Buffer[] = [];
  await readLog(
    join(session.directory, "events.jsonl"),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  const text = Buffer.concat(chunks).toString();
  expect(text).not.toContain("canary-private");
  expect(text).toContain("retained debug stack");
  const events: unknown[] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  expect(events.length).toBeGreaterThan(2);
});

test("an explicit valid diagnostic flag overrides an invalid inherited value", () => {
  const { root } = fixture();
  vi.stubEnv("WORKBENCH_LOG_LEVEL", "invalid-inherited-level");
  const result = invoke(root, ["project", "--json", "--log-level", "warn"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(0);
});

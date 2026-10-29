import { fakeClock, realClock } from "./fixtures/clock.mts";
import { LogLevel, LogFormat, DiagnosticOperation, DiagnosticOutcome } from "../scripts/diagnostic-contract.mjs";
import { afterEach, expect, test, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  diagnostic,
  diagnosticError,
  restoreDiagnosticError,
  describeError,
  configureDiagnostics,
  routeDiagnostics,
  writeDiagnosticText,
  settleCleanup,
  DiagnosticCapture,
  DiagnosticRedactor,
  retainDiagnosticStream,
  UserFacingError,
  createDiagnosticEvent,
  renderDiagnosticEvent,
  wrapDiagnosticText,
  setDiagnosticTextWidth,
  formatDiagnosticSections,
} from "../scripts/diagnostics.mjs";
import { terminalColumns } from "../src/terminal-text.ts";
import { CheckProgress } from "../src/check-progress.ts";
import { processFailure } from "../scripts/process-outcome.mjs";
import { artifactResponse } from "../src/artifact-streams.ts";

afterEach(() => {
  realClock();
  configureDiagnostics();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([80, 40, 24])("text errors wrap explicitly at %s columns while JSON retains the exact event", (columns) => {
  const restore = setDiagnosticTextWidth(terminalColumns);
  try {
    const message =
      "Change review is required for this staged snapshot. Complete the review, then record it with 'workbench review changes --record'.";
    const event = createDiagnosticEvent(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: "pre-commit" },
      new UserFacingError(message),
    );
    const text = renderDiagnosticEvent(event, LogFormat.Text, columns);
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      if (terminalColumns(line) > columns) expect(line.trimStart()).toBe("'workbench review changes --record'.");
      else expect(terminalColumns(line)).toBeLessThanOrEqual(columns);
    }
    expect(
      lines
        .filter(Boolean)
        .map((line) => line.trimStart())
        .join(" "),
    ).toBe("workbench: pre-commit failed: " + message);
    expect(text).toContain("'workbench review changes --record'");
    expect(lines.slice(1).every((line) => !line || line.startsWith("  "))).toBe(true);
    expect(renderDiagnosticEvent(event, LogFormat.Json, columns)).toBe(JSON.stringify(event) + "\n");
  } finally {
    restore();
  }
});

test.each([120, 80, 40])(
  "grouped errors separate summary, affected items, and recovery within %s columns",
  (columns) => {
    const summary = formatDiagnosticSections({
      summary: "Required images are unavailable.",
      groups: [
        { heading: "Not published", items: ["native (linux-arm64)", "guix (linux-x64)"] },
        { heading: "Registry check failed", items: [] },
      ],
      next: "Prepare and publish missing profiles with workbench development images, then retry.",
    });
    const cause = new Error("Image: registry.example/project/native:linux-arm64-" + "a".repeat(64));
    const event = createDiagnosticEvent(
      LogLevel.Error,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Failed,
      { command: "pre-push" },
      new UserFacingError(summary, { cause }),
    );
    const rendered = renderDiagnosticEvent(event, LogFormat.Text, columns);
    expect(rendered).toContain("failed:\n\n");
    expect(rendered).toContain("unavailable.\n\n");
    expect(rendered).toContain("  - native (linux-arm64)");
    expect(rendered).toContain("  - guix (linux-x64)");
    expect(rendered).not.toContain("Registry check failed");
    expect(rendered).not.toContain(cause.message);
    expect(rendered.split("\n").every((line) => terminalColumns(line) <= Math.min(columns, 80))).toBe(true);
    expect(rendered.split("\n").every((line) => line === line.trimEnd())).toBe(true);
    expect(JSON.parse(renderDiagnosticEvent(event, LogFormat.Json, columns))).toMatchObject({
      error: { summary, causes: [{ message: cause.message }] },
    });
  },
);

test("diagnostic wrapping preserves paragraphs and Unicode graphemes while removing terminal controls", () => {
  const restore = setDiagnosticTextWidth(terminalColumns);
  try {
    const plain = "Warning: Café 測試 👩‍💻 " + "/".repeat(120) + "\n\n  Follow the supplied instruction.";
    const wrapped = wrapDiagnosticText(`\u001b[31m${plain}\u001b[0m`, 32);
    expect(wrapped).toBe("Warning: Café 測試 👩‍💻\n  " + "/".repeat(120) + "\n\n  Follow the supplied\n  instruction.");
    for (const line of wrapped.split("\n")) if (terminalColumns(line) > 32) expect(line).toBe("  " + "/".repeat(120));
  } finally {
    restore();
  }
});

test.each([80, 18])("source and caret frames preserve their exact spacing at %s columns", (columns) => {
  const excerpt = "  1:  invalid = value\n                   ^";
  expect(wrapDiagnosticText(excerpt, columns)).toBe(excerpt);
  const tabs = "\tconst\tselected = source.calculate(value);\n\t                        ^~~~ missing method";
  expect(wrapDiagnosticText(tabs, columns)).toBe(tabs);
  const numbered = "  |\n1 | const result = missing.call(source, other);\n  |                ^~~~~~~ unresolved name";
  expect(wrapDiagnosticText(numbered, columns)).toBe(numbered);
});

test("prose wrapping preserves original gaps and punctuation outside the chosen line breaks", () => {
  const message = "Pinned tools: 'node', 'pnpm', and 'git' must match the selected project.";
  expect(wrapDiagnosticText(message, 40).replace(/\n +/gu, " ")).toBe(message);
  expect(wrapDiagnosticText("Alpha  beta   gamma, 'delta', \"epsilon\".", 18)).toBe(
    "Alpha  beta\n  gamma, 'delta',\n  \"epsilon\".",
  );
  expect(wrapDiagnosticText("  Keep  these   spaces.  ", 80)).toBe("  Keep  these   spaces.  ");
});

test("indivisible paths, URLs, and quoted whitespace stay intact and copyable", () => {
  const path = "/home/example/.cache/workbench/check-logs/" + "0123456789".repeat(8) + "/group-0.log";
  expect(wrapDiagnosticText(`Full check logs: ${path}`, 80)).toBe(`Full check logs:\n  ${path}`);
  const url = "https://docs.example/" + "detail/".repeat(12);
  expect(wrapDiagnosticText(`See ${url}.`, 32)).toBe(`See\n  ${url}.`);
  const quoted = "'" + " ".repeat(100) + "'";
  expect(wrapDiagnosticText(`Value rejected: ${quoted}`, 24)).toBe(`Value rejected:\n  ${quoted}`);
  const command = "'workbench logs read owner'\\''s archive with spaces'";
  expect(wrapDiagnosticText(`Run ${command}.`, 24)).toBe(`Run\n  ${command}.`);
  const escaped = String.raw`"a quoted \"value\" with spaces"`;
  expect(wrapDiagnosticText(`Rejected ${escaped}.`, 24)).toBe(`Rejected\n  ${escaped}.`);
});

test("prose tabs cannot make an apparently fitting line overflow its column budget", () => {
  const restore = setDiagnosticTextWidth(terminalColumns);
  try {
    expect(wrapDiagnosticText("One\tTwo Three Four", 18)).toBe("One\tTwo\n  Three Four");
  } finally {
    restore();
  }
});

test("routing coordinates status text while keeping structured diagnostic sinks separate", () => {
  const events: string[] = [],
    statuses: string[] = [],
    routed: string[] = [];
  configureDiagnostics({
    format: "json",
    sink: (text) => {
      events.push(text);
    },
  });
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    statuses.push(String(text));
    return true;
  });
  const restore = routeDiagnostics((text, forward) => {
    routed.push(text);
    forward(text);
  });
  try {
    writeDiagnosticText("Inside route");
    diagnostic(LogLevel.Info, DiagnosticOperation.CheckLogs, DiagnosticOutcome.Completed);
  } finally {
    restore();
  }
  writeDiagnosticText("After restore");
  diagnostic(LogLevel.Info, DiagnosticOperation.CheckLogs, DiagnosticOutcome.Completed);
  expect(statuses).toEqual(["Inside route\n", "After restore\n"]);
  expect(events).toHaveLength(2);
  for (const event of events)
    expect(JSON.parse(event)).toMatchObject({ operation: "checks.logs", outcome: "completed" });
  expect(routed).toEqual(["Inside route\n", events[0]]);
});
test("retained streams drain every redacted byte through a slow writer before completion", async () => {
  const chunks = Array.from({ length: 96 }, (_, index) =>
    Buffer.from(`${String(index)} ${"x".repeat(32768)} token=private-token\n`),
  );
  const saved: Buffer[] = [];
  const destination = new Writable({
    highWaterMark: 1,
    write(bytes: Buffer, _encoding, callback) {
      setImmediate(() => {
        saved.push(Buffer.from(bytes));
        callback();
      });
    },
  });
  await retainDiagnosticStream(Readable.from(chunks), destination, []);
  await new Promise<void>((resolve) => {
    destination.end(resolve);
  });
  expect(Buffer.concat(saved).toString()).toBe(
    Buffer.concat(chunks).toString().replaceAll("private-token", "[REDACTED]"),
  );
});
test("a failed retained-log writer preserves its cause and drains the producer", async () => {
  let produced = 0;
  const source = Readable.from(
    (function* () {
      for (; produced < 96; produced++) yield Buffer.alloc(32768, "x");
    })(),
  );
  const failure = Object.assign(new Error("log disk full"), { code: "ENOSPC" });
  const destination = new Writable({
    highWaterMark: 1,
    write(_bytes, _encoding, callback) {
      callback(failure);
    },
  });
  const ended = new Promise<void>((resolve) => {
    source.once("end", resolve);
  });
  await expect(retainDiagnosticStream(source, destination)).rejects.toBe(failure);
  await ended;
  expect(produced).toBe(96);
});
test("long complete and split credential fields and URL queries never expose unlabelled tails", async () => {
  const secret = 'canary-private "quoted" \\ value '.repeat(500);
  const records = [
    JSON.stringify({ password: secret, after: "safe marker" }),
    `client-secret='${secret.replaceAll("'", "\\'")}' after=safe marker`,
    `source=https://example.invalid/file?token=${"canary-private".repeat(2000)} after=safe marker`,
    `refresh_token=${"canary-private".repeat(2000)} after=safe marker`,
  ];
  for (const text of records) {
    for (const width of [text.length, 4097, 73]) {
      const saved: Buffer[] = [];
      const chunks = Array.from({ length: Math.ceil(text.length / width) }, (_, index) =>
        text.slice(index * width, (index + 1) * width),
      );
      await pipeline(
        Readable.from(chunks),
        new DiagnosticRedactor([]),
        new Writable({
          write(bytes: Buffer, _encoding, callback) {
            saved.push(bytes);
            callback();
          },
        }),
      );
      const result = Buffer.concat(saved).toString();
      expect(result.includes("canary-private"), `credential tail at chunk width ${String(width)}`).toBe(false);
      expect(result).toContain("safe marker");
    }
  }
});
test("nested and aggregate failures retain operation, OS code, and causes across worker transport", () => {
  const original = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const failure = new AggregateError(
    [new Error("build failed", { cause: original }), new Error("cleanup failed")],
    "preparation failed",
  );
  const transported = restoreDiagnosticError(structuredClone(diagnosticError(failure, true)));
  for (const message of ["preparation failed", "build failed", "permission denied", "EACCES", "cleanup failed"])
    expect(describeError(transported)).toContain(message);
});
test("diagnostics redact credentials and URL queries, sanitize terminal controls, and keep JSON independently parseable", () => {
  vi.stubEnv("WORKBENCH_TEST_TOKEN", "canary-secret-token-567890");
  const output: string[] = [];
  configureDiagnostics({
    format: "json",
    level: "debug",
    sink: (text) => {
      output.push(text);
    },
  });
  diagnostic(
    LogLevel.Error,
    DiagnosticOperation.ArtifactConnection,
    DiagnosticOutcome.Failed,
    {
      source: "https://user:password@example.invalid/file?token=canary-secret-token-567890",
      evidence: "\x1b[2Jcanary-secret-token-567890",
    },
    new Error("password=another-private-value"),
  );
  const text = output.join("");
  for (const secret of ["canary-secret-token-567890", "another-private-value", "user:password", "?token=", "\x1b"])
    expect(text).not.toContain(secret);
  expect(JSON.parse(text)).toMatchObject({
    version: 1,
    operation: "artifact.connection",
    outcome: "failed",
    fields: { source: "https://example.invalid/file" },
  });
});
test("quoted credential fields redact complete JSON values including embedded spaces", () => {
  const output: string[] = [];
  configureDiagnostics({
    format: "json",
    sink: (text) => {
      output.push(text);
    },
  });
  diagnostic(LogLevel.Warn, DiagnosticOperation.Command, DiagnosticOutcome.Failed, {
    evidence: '{"password":"private value with spaces","token":"unlisted-private-token"}',
  });
  expect(output.join("")).not.toContain("private value");
  expect(output.join("")).not.toContain("unlisted-private-token");
});
test("log filtering and oversized error graphs have explicit limits and omissions", () => {
  const output: string[] = [];
  configureDiagnostics({
    format: "json",
    level: "warn",
    sink: (text) => {
      output.push(text);
    },
  });
  diagnostic(LogLevel.Debug, DiagnosticOperation.Command, DiagnosticOutcome.Discarded, {}, undefined, "filtered");
  const errors = Array.from({ length: 100 }, () => new Error("é".repeat(10000)));
  diagnostic(
    LogLevel.Error,
    DiagnosticOperation.Command,
    DiagnosticOutcome.Failed,
    {},
    new AggregateError(errors, "many failures"),
  );
  expect(output).toHaveLength(1);
  expect(Buffer.byteLength(output[0] ?? "")).toBeLessThanOrEqual(16384);
  expect(JSON.parse(output[0] ?? "")).toHaveProperty("omittedBytes");
});
test("cyclic causes remain bounded and a broken diagnostic sink cannot replace an operation outcome", () => {
  const failure = new Error("original");
  Object.assign(failure, { cause: failure });
  expect(describeError(failure)).toContain("cycle");
  configureDiagnostics({
    sink: () => {
      throw new Error("sink failed");
    },
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(() => {
    diagnostic(LogLevel.Error, DiagnosticOperation.Command, DiagnosticOutcome.Failed, {}, failure);
  }).not.toThrow();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("diagnostic sink failed"));
});
test("cleanup attempts every finalizer and reports primary and cleanup failures together", async () => {
  const primary = new Error("primary"),
    first = new Error("first cleanup"),
    second = new Error("second cleanup");
  const visited: number[] = [];
  const failure: unknown = await settleCleanup(
    [
      () => {
        visited.push(1);
        throw first;
      },
      () => {
        visited.push(2);
        throw second;
      },
      () => {
        visited.push(3);
      },
    ],
    primary,
  ).catch((error: unknown) => error);
  expect(visited).toEqual([1, 2, 3]);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate");
  expect(failure.errors).toEqual([primary, first, second]);
});
test("bounded capture preserves both ends of an oversized first chunk and counts omitted bytes", () => {
  const capture = new DiagnosticCapture(16);
  capture.add(Buffer.from("first---" + "x".repeat(100) + "---last!"));
  const text = capture.text();
  expect(text).toContain("first---");
  expect(text).toContain("---last!");
  expect(text).toContain("100 diagnostic bytes omitted");
});
test("capture preserves UTF-8 across its head/tail boundary and truncates only complete characters", () => {
  const full = new DiagnosticCapture(16);
  full.add(Buffer.from("aaéééééaa"));
  expect(full.text()).toBe("aaéééééaa");
  const clipped = new DiagnosticCapture(17);
  clipped.add(Buffer.from("é".repeat(100)));
  expect(clipped.text()).not.toContain("�");
  expect(clipped.text()).toContain("diagnostic bytes omitted");
});
test("diagnostic field limits retain the useful tail and classify omissions by unit", () => {
  const output: string[] = [];
  configureDiagnostics({
    format: "json",
    sink: (text) => {
      output.push(text);
    },
  });
  diagnostic(LogLevel.Warn, DiagnosticOperation.CollectionWorker, DiagnosticOutcome.Warnings, {
    stderr: "start " + "x".repeat(10000) + " actionable final warning",
  });
  const event = JSON.parse(output[0] ?? "") as { fields: { stderr: string }; omittedBytes: number };
  expect(event.fields.stderr).toContain("start");
  expect(event.fields.stderr).toContain("actionable final warning");
  expect(event.omittedBytes).toBeGreaterThan(0);
});
test("connection retries report every attempt and exhaustion with safe source identities", async () => {
  fakeClock();
  const events: { operation: string; outcome: string; fields: { attempt?: number; maximumAttempts?: number } }[] = [];
  configureDiagnostics({
    format: "json",
    sink: (text) => {
      events.push(JSON.parse(text) as (typeof events)[number]);
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
  const rejected = expect(artifactResponse("https://example.invalid/artifact?private=query")).rejects.toThrow(
    "network acquisition remained unavailable",
  );
  await vi.runAllTimersAsync();
  await rejected;
  realClock();
  const retries = events.filter((event) => event.operation === "artifact.connection");
  expect(retries.map((event) => event.fields.attempt)).toEqual(
    Array.from({ length: retries.at(-1)?.fields.maximumAttempts ?? 0 }, (_, index) => index + 1),
  );
  expect(retries.at(-1)?.outcome).toBe("exhausted");
  expect(JSON.stringify(events)).not.toContain("private=query");
  vi.unstubAllGlobals();
});
test("stream redaction protects credentials split across chunks and retained-buffer boundaries", async () => {
  const secret = "canary-secret-token-567890",
    chunks: Buffer[] = [];
  const input = [Buffer.from("a".repeat(65530) + secret.slice(0, 10)), Buffer.from(secret.slice(10) + "\nlast line\n")];
  await pipeline(
    Readable.from(input),
    new DiagnosticRedactor([secret]),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  const text = Buffer.concat(chunks).toString();
  expect(text).not.toContain(secret);
  expect(text).toContain("[REDACTED]");
  expect(text).toContain("last line");
});
test("stream redaction protects multiline credentials and oversized URL continuations", async () => {
  const secret = "first-private-line\nsecond-private-line",
    chunks: Buffer[] = [];
  const source = [
    Buffer.from("prefix " + secret.slice(0, 19)),
    Buffer.from(secret.slice(19) + "\nhttps://example.invalid/file?token=" + "private".repeat(2000)),
    Buffer.from("more-private next safe line\n"),
  ];
  await pipeline(
    Readable.from(source),
    new DiagnosticRedactor([secret]),
    new Writable({
      write(bytes: Buffer, _encoding, callback) {
        chunks.push(bytes);
        callback();
      },
    }),
  );
  const text = Buffer.concat(chunks).toString();
  expect(text).not.toContain("first-private-line");
  expect(text).not.toContain("second-private-line");
  expect(text).not.toContain("more-private");
  expect(text).toContain("next safe line");
});
test("subprocess diagnostics distinguish signal termination and retain bounded stdout and stderr", () => {
  const failure = processFailure(
    "compiler",
    { pid: 42, status: null, signal: "SIGTERM" },
    { stdout: "actual stdout cause", stderr: "actual stderr cause" },
  );
  expect(failure?.message).toContain("pid=42, status=null, signal=SIGTERM");
  expect(failure?.message).toContain("stdout cause");
  expect(failure?.message).toContain("stderr cause");
  expect(diagnosticError(failure).process).toMatchObject({
    operation: "compiler",
    pid: 42,
    status: null,
    signal: "SIGTERM",
  });
  expect(diagnosticError(restoreDiagnosticError(diagnosticError(failure))).process).toMatchObject({
    pid: 42,
    signal: "SIGTERM",
  });
});
test("paused progress makes queue omissions visible when display resumes", () => {
  let text = "";
  const output = {
    write: (bytes: string) => {
      text += bytes;
      return true;
    },
    isTTY: false,
  };
  const progress = new CheckProgress(1, output);
  progress.suspend();
  for (let index = 0; index < 1005; index++) progress.message(`message ${String(index)}`);
  progress.resume();
  progress.close(true);
  expect(text).toContain("5 progress messages omitted");
});

test("final reports observe primary and cleanup failures and cannot replace either", async () => {
  const primary = new Error("browser scenario failed"),
    cleanup = new Error("service shutdown failed"),
    report = new Error("evidence write failed");
  const observed: unknown[][] = [];
  const failure: unknown = await settleCleanup(
    [
      () => {
        throw cleanup;
      },
    ],
    primary,
    (errors) => {
      observed.push([...errors]);
      throw report;
    },
  ).catch((error: unknown) => error);
  expect(observed).toEqual([[primary, cleanup]]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, cleanup, report]);
});

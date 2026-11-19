import { DiagnosticCapture } from "../../../src/core/diagnostics/diagnostic-text.mjs";
import type { OwnedChildOptions } from "../../../src/core/runtime/owned-child.mjs";

interface BrowserFixtureConnection {
  url: string;
  httpCredentials: { username: string; password: string; origin: string };
}

export function captureBrowserService(service: AbortController) {
  const stdoutLog = new DiagnosticCapture();
  const stderrLog = new DiagnosticCapture();
  let ready: ((connection: BrowserFixtureConnection) => void) | undefined;
  const startup = new Promise<BrowserFixtureConnection>((resolve) => {
    ready = resolve;
  });
  const capture: NonNullable<OwnedChildOptions["output"]> = (stdout, stderr) => {
    for (const [stream, log] of [
      [stdout, stdoutLog],
      [stderr, stderrLog],
    ] as const)
      stream.on("data", (chunk: Buffer) => {
        if (stdoutLog.bytes + stderrLog.bytes + chunk.length > 1024 * 1024) {
          service.abort();
          return;
        }
        log.add(chunk);
        if (stream !== stdout || !ready) return;
        const output = stdoutLog.rawText();
        const url = /^Workbench web UI: (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)(?=\r?\n)/m.exec(output)?.[1];
        const username = /^Sign-in username: ([^\r\n:]+)(?=\r?\n)/m.exec(output)?.[1];
        const password = /^Sign-in password: ([A-Za-z0-9_-]{43})(?=\r?\n)/m.exec(output)?.[1];
        if (url && username && password) {
          ready({ url, httpCredentials: { username, password, origin: new URL(url).origin } });
          ready = undefined;
        }
      });
  };
  return { startup, capture, diagnostics: () => stdoutLog.text() + "\n" + stderrLog.text() };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics.js";
import type { WebMetrics } from "./observability.js";

export function localEndpoint(options: { host?: "127.0.0.1" | "::1"; port?: number }) {
  const host = options.host ?? "127.0.0.1",
    port = options.port ?? 8080;
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("serve requires a loopback host and a port from 0 to 65535");
  return { host, port };
}

/** Every local listener applies the same transport bounds and reports boundary failures. */
export function createLocalServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  metrics: WebMetrics,
): Server {
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(() => handle(request, response))
      .catch((error: unknown) => {
        diagnostic(
          LogLevel.Error,
          DiagnosticOperation.WebResponse,
          DiagnosticOutcome.Failed,
          { requestId: String(response.getHeader("x-workbench-request-id") ?? "unavailable") },
          error,
          "connection terminated after boundary failure",
        );
        response.destroy();
      });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;
  server.on("drop", () => {
    metrics.count("rejectedConnections");
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WebListener,
      DiagnosticOutcome.Rejected,
      { maximumConnections: server.maxConnections },
      undefined,
      "connection capacity exhausted",
    );
  });
  server.on("clientError", (error, socket) => {
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.WebListener,
      DiagnosticOutcome.Rejected,
      {},
      error,
      "invalid or incomplete HTTP request",
    );
    socket.destroy();
  });
  return server;
}

export function listenLocal(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** Service owners drain their actions and event clients before closing the transport. */
export function closeLocalServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Server as NetServer } from "node:net";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../../core/diagnostics/diagnostics.mjs";
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
    const reset = "code" in error && error.code === "ECONNRESET";
    diagnostic(
      reset ? LogLevel.Debug : LogLevel.Warn,
      DiagnosticOperation.WebListener,
      reset ? DiagnosticOutcome.Cancelled : DiagnosticOutcome.Rejected,
      {},
      error,
      reset ? "connection reset by peer" : "invalid or incomplete HTTP request",
    );
    socket.destroy();
  });
  return server;
}

export function listenLocal(server: Server, host: string, port: number): Promise<void> {
  return listen(server, (ready) => server.listen(port, host, ready));
}

export function listenInherited(server: NetServer, fd: number): Promise<void> {
  return listen(server, (ready) => server.listen({ fd }, ready));
}

export function listenUnix(server: NetServer, path: string): Promise<void> {
  return listen(server, (ready) => server.listen(path, ready));
}

function listen(server: NetServer, bind: (ready: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    bind(listening);
  });
}

export async function listenPrivate(server: Server, host: string, port: number): Promise<void> {
  if (port === 0) return listenLocal(server, host, port);
  const last = Math.min(65535, port + 31);
  for (let candidate = port; candidate <= last; candidate++) {
    try {
      await listenLocal(server, host, candidate);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(
    `No free Workbench listener from port ${String(port)} through ${String(last)}. Choose another starting port with --port.`,
  );
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

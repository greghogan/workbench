import { demonstrationBase } from "./project-mounts.js";
import { WebError } from "./errors.js";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedChild } from "../../scripts/owned-child.mjs";
import { createDemonstration } from "../demonstration.js";
import { settleCleanup } from "../diagnostics.js";
import { startWebServer } from "./server.js";

/** The demonstration changes only its child environment; the hub retains its personal context. */
export async function serveDemonstration(distribution: string, directory: string): Promise<void> {
  const demo = await createDemonstration(distribution, directory);
  let application: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let stop: () => void = () => undefined;
  try {
    application = await startWebServer(demo.root, {
      port: 0,
      demonstration: true,
      basePath: demonstrationBase,
      ...(process.env.WORKBENCH_DEMONSTRATION_BUNDLE
        ? { workerBundle: process.env.WORKBENCH_DEMONSTRATION_BUNDLE }
        : {}),
      collectionDefaults: demo.collectionDefaults,
    });
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    process.once("SIGINT", stop).once("SIGTERM", stop);
    console.log(
      "WORKBENCH_DEMO_READY " +
        JSON.stringify({
          kind: "workbench-demo-ready",
          url: application.url,
          root: demo.root,
          source: process.env.WORKBENCH_DEMONSTRATION_SOURCE,
        }),
    );
    await stopped;
  } finally {
    process.off("SIGINT", stop).off("SIGTERM", stop);
    await settleCleanup([() => application?.close(), () => demo.close()]);
  }
}
/** Restart a failed child against its existing files; only the hub owns deletion. */
export async function startDemonstrationService(distribution: string, signal?: AbortSignal, bundle?: string) {
  signal?.throwIfAborted();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workbench-demo-")));
  let current: Awaited<ReturnType<typeof launchDemonstration>> | undefined;
  let restarting: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  const restart = async () => {
    if (closed) throw new WebError(503, "Demonstration is stopping");
    const work = (restarting ??= (async () => {
      await current?.close();
      current = undefined;
      current = await launchDemonstration(distribution, directory, signal, bundle);
    })());
    try {
      await work;
    } finally {
      if (restarting === work) restarting = undefined;
    }
  };
  const close = () => {
    closed ??= (async () => {
      await settleCleanup([
        async () => {
          try {
            await restarting;
          } finally {
            await current?.close();
          }
        },
        () => rm(directory, { recursive: true, force: true }),
      ]);
    })();
    return closed;
  };
  try {
    await restart();
    return {
      root: join(directory, "project"),
      source: join(directory, "collection"),
      get available() {
        return !closed && !restarting && (current?.available ?? false);
      },
      handle: (request: IncomingMessage, response: ServerResponse) => {
        if (closed || restarting || !current?.available)
          throw new WebError(503, "Demonstration stopped; refresh to reconnect without resetting its files");
        return current.handle(request, response);
      },
      restart,
      close,
    };
  } catch (error) {
    await settleCleanup([close], error);
    throw error;
  }
}
async function launchDemonstration(distribution: string, directory: string, signal?: AbortSignal, bundle?: string) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const env = { ...process.env };
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    env[`WORKBENCH_${kind}_HOME`] = join(directory, kind.toLowerCase());
  env.WORKBENCH_PROJECT_ROOT = directory;
  env.WORKBENCH_DISTRIBUTION_ROOT = distribution;
  env.WORKBENCH_DEMONSTRATION_CHILD = directory;
  if (bundle) env.WORKBENCH_DEMONSTRATION_BUNDLE = bundle;
  for (const name of Object.keys(env))
    if (
      name.startsWith("GIT_") ||
      name.startsWith("WORKBENCH_LOCAL_") ||
      name === "WORKBENCH_EPHEMERAL_CHECKOUT" ||
      name === "WORKBENCH_POLICY_REVIEW"
    )
      Reflect.deleteProperty(env, name);
  let ready!: (value: { url: string; root: string; source: string }) => void, failed!: (error: Error) => void;
  const published = new Promise<{ url: string; root: string; source: string }>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const cancel = () => {
    controller.abort();
    failed(new Error("Demonstration startup cancelled"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let buffered = "",
    stderr = "",
    announced = false,
    available = false;
  const running = runOwnedChild(
    process.execPath,
    [bundle ?? join(distribution, "bundle/main.cjs"), "web-demo", distribution, directory],
    {
      // The owner removes directory on shutdown; Windows cannot remove a child's current directory.
      cwd: distribution,
      env,
      signal: controller.signal,
      output: (stdout, errors) => {
        stdout.on("data", (chunk: Buffer) => {
          if (announced) return;
          buffered += chunk.toString("utf8");
          if (Buffer.byteLength(buffered) > 16384) {
            failed(new Error("Invalid demonstration startup response"));
            controller.abort();
            return;
          }
          let line: string | undefined;
          for (;;) {
            const end = buffered.indexOf("\n");
            if (end < 0) return;
            const candidate = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            if (candidate.startsWith("WORKBENCH_DEMO_READY ")) {
              line = candidate.slice(21);
              break;
            }
          }
          try {
            const value: unknown = JSON.parse(line);
            if (
              !value ||
              typeof value !== "object" ||
              !("kind" in value) ||
              value.kind !== "workbench-demo-ready" ||
              !("url" in value) ||
              typeof value.url !== "string" ||
              !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) ||
              !("root" in value) ||
              value.root !== join(directory, "project") ||
              !("source" in value) ||
              value.source !== join(directory, "collection")
            )
              throw new Error("Invalid demonstration startup response");
            announced = true;
            available = true;
            ready({ url: value.url, root: value.root, source: value.source });
          } catch (error) {
            failed(error instanceof Error ? error : new Error(String(error)));
            controller.abort();
          }
        });
        errors.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-16384);
        });
      },
    },
  );
  void running.then(
    (outcome) => {
      available = false;
      if (!announced)
        failed(
          new Error(
            `Demonstration stopped before startup: ${outcome.error?.message ?? (stderr.length ? stderr : String(outcome.status))}`,
          ),
        );
    },
    (error: unknown) => {
      available = false;
      failed(error instanceof Error ? error : new Error(String(error)));
    },
  );
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      controller.abort();
      signal?.removeEventListener("abort", cancel);
      await running;
    })();
    return closed;
  };
  try {
    const info = await published;
    const handle = (request: IncomingMessage, response: ServerResponse): Promise<void> =>
      new Promise((resolve, reject) => {
        const target = new URL(request.url ?? "/", info.url),
          headers = { ...request.headers, host: target.host };
        if (headers.origin) headers.origin = target.origin;
        const outgoing = httpRequest(target, { method: request.method, headers }, (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          incoming.once("end", resolve).once("error", reject);
        });
        outgoing.once("error", (cause) => {
          reject(new WebError(503, "Demonstration connection interrupted; refresh to reconnect", { cause }));
        });
        response.once("close", () => {
          outgoing.destroy();
          resolve();
        });
        request.once("aborted", () => outgoing.destroy());
        request.pipe(outgoing);
      });
    return {
      ...info,
      get available() {
        return available;
      },
      handle,
      close,
    };
  } catch (error) {
    await settleCleanup([close], error);
    throw error;
  }
}

import { metadataBytes } from "../scripts/metadata-http.mjs";
import * as http from "node:http";
import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { captureOwnedChild } from "../scripts/owned-child.mjs";

test("maintainer metadata uses the configured proxy without caller startup flags or ambient credentials", async () => {
  const connections: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    connections.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    const sources = pathToFileURL(join(import.meta.dirname, "../scripts/maintenance/sources.mjs")).href;
    const result = await captureOwnedChild(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const {configureMetadataProxy, metadataRequests} = await import(${JSON.stringify(sources)});
      const restore = configureMetadataProxy();
      try { await metadataRequests()('https://registry.example.test/latest'); process.exitCode=2; }
      catch { process.stdout.write('proxy rejected connection'); }
      finally { restore(); }
    `,
      ],
      {
        cwd: import.meta.dirname,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          NODE_USE_ENV_PROXY: "0",
          HTTPS_PROXY: endpoint,
          https_proxy: endpoint,
          HTTP_PROXY: endpoint,
          http_proxy: endpoint,
          NO_PROXY: "",
          no_proxy: "",
        },
        signal: AbortSignal.timeout(15_000),
      },
      8192,
    );
    if (!("setGlobalProxyFromEnv" in http)) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Maintainer proxy support requires the pinned development Node");
      expect(connections).toHaveLength(0);
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("proxy rejected connection");
    expect(connections).toContain("registry.example.test:443");
  } finally {
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("metadata streams enforce bounds and cancel their reader", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("too large"));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(metadataBytes(response, 3, "Fixture")).rejects.toThrow("exceeds");
  expect(cancelled).toBe(true);
  expect((await metadataBytes(new Response("okay"), 4, "Fixture")).toString()).toBe("okay");
});

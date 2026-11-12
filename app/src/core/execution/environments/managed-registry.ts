import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import type { ManagedInputRepository } from "./managed-inputs.js";

/** A read-only loopback registry exposes pinned metadata through the manager's normal HTTP interface. */
export async function managedRegistry(repository: ManagedInputRepository) {
  const bytes = readFileSync(join(repository.directory, "registry.json.br"));
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    repository.declaration.source_hashes["managed-registry.json.br"]
  )
    throw new Error("Managed registry metadata does not match its declared source");
  const packages = JSON.parse(
    brotliDecompressSync(bytes, { maxOutputLength: 512 * 1024 ** 2 }).toString("utf8"),
  ) as Record<string, unknown>;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let name;
    try {
      name = decodeURIComponent(new URL(request.url ?? "", "http://localhost").pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!Object.hasOwn(packages, name)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, immutable" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(packages[name]));
  });
  server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Managed registry did not bind a loopback port");
  // pnpm keys metadata by registry URL. Each listener has a new port, so retain no duplicate metadata caches.
  let cacheDirectory: string;
  try {
    cacheDirectory = mkdtempSync(join(tmpdir(), "workbench-managed-metadata-"));
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    cacheDirectory,
    async close() {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } finally {
        rmSync(cacheDirectory, { recursive: true, force: true });
      }
    },
  };
}

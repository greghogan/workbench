import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { distributionSourceFile, parseDistributionSource } from "./distribution-identity.js";
import { specificationPin, toolSpecification } from "./tool-pin.js";

async function regularText(path: string, limit: number): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > limit) throw new Error("Unsupported npm cache metadata");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== metadata.size) throw new Error("npm cache metadata changed while reading");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Pure source binding: neither missing metadata nor inherited dispatch context can authorize a candidate. */
export function npmCacheSpecification(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const metadata = value as Record<string, unknown>;
  if (metadata.lockfileVersion !== 2 && metadata.lockfileVersion !== 3) return;
  const packages = metadata.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return;
  const entry = (packages as Record<string, unknown>)["node_modules/@workbench/cli"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  const pin = specificationPin((entry as Record<string, unknown>).resolved);
  return pin ? toolSpecification(pin) : undefined;
}

/** Stream npm's entries without coupling to its cache-key algorithm or retaining the directory listing. */
export async function cachedNpmWorkbench(
  cache: string,
  specification: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await opendir(join(cache, "_npx"));
  } catch {
    signal?.throwIfAborted();
    return;
  }
  try {
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isDirectory()) continue;
      const prefix = join(cache, "_npx", entry.name);
      try {
        const binding = npmCacheSpecification(
          JSON.parse(await regularText(join(prefix, "package-lock.json"), 1024 * 1024)),
        );
        if (binding !== specification) continue;
        const directory = await realpath(join(prefix, "node_modules/@workbench/cli")),
          base = await realpath(prefix),
          inside = relative(base, directory);
        if (inside === ".." || inside.startsWith(`..${sep}`) || resolve(base, inside) !== directory) continue;
        let source: string | undefined;
        try {
          source = await regularText(join(directory, distributionSourceFile), 16384);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (source !== undefined && toolSpecification(parseDistributionSource(JSON.parse(source))) !== binding)
          continue;
        const launcher = join(directory, "bin/workbench.mjs");
        if (!(await lstat(launcher)).isFile() || (await realpath(launcher)) !== launcher) continue;
        signal?.throwIfAborted();
        return launcher;
      } catch {
        // Incomplete, unsupported, and conflicting entries cannot authorize execution; keep looking.
        signal?.throwIfAborted();
      }
    }
  } catch {
    // npm may prune or replace its own directory while it is being inspected.
    signal?.throwIfAborted();
  }
  return;
}

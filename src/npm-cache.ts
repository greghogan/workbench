import { readBoundedFileAsync } from "./file-reads.js";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { distributionSourceFile, parseDistributionSource } from "./distribution-identity.js";
import { sameToolPin, specificationPin, toolSpecification } from "./tool-pin.js";

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
  const requested = specificationPin(specification);
  if (!requested) return;
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
          JSON.parse(
            (await readBoundedFileAsync(join(prefix, "package-lock.json"), 1024 * 1024, "npm cache metadata")).toString(
              "utf8",
            ),
          ),
        );
        const bound = specificationPin(binding);
        if (!bound || !sameToolPin(bound, requested)) continue;
        const directory = await realpath(join(prefix, "node_modules/@workbench/cli")),
          base = await realpath(prefix),
          inside = relative(base, directory);
        if (inside === ".." || inside.startsWith(`..${sep}`) || resolve(base, inside) !== directory) continue;
        let source: string | undefined;
        try {
          source = (
            await readBoundedFileAsync(join(directory, distributionSourceFile), 16384, "npm source identity")
          ).toString("utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (source !== undefined && !sameToolPin(parseDistributionSource(JSON.parse(source)), bound)) continue;
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

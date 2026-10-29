import { captureOwnedChild, processCancellation } from "./owned-child.mjs";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "./runtime-parsers.mjs";
import { record, required } from "./values.mjs";
import { pnpmPackages, pnpmIdentity } from "./pnpm-lock.mjs";

/** Ask the pinned manager to retain full publication history without editing project inputs. */
export async function retainPnpmMetadata(
  root: string,
  cli: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<void> {
  const locks = paths.map((path) => join(root, path, "pnpm-lock.yaml")).filter((path) => existsSync(path));
  if (!locks.length) return;
  const dependencies = Object.create(null) as Record<string, string>;
  const packages = Object.create(null) as Record<string, unknown>;
  for (const path of locks) {
    Object.assign(packages, pnpmPackages(readFileSync(path, "utf8")));
  }
  for (const key of Object.keys(packages)) {
    const { name, version } = pnpmIdentity(key);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9.+_-]+$/.test(version))
      throw new Error(`Unsupported locked npm package: ${key}`);
    dependencies[name] = version;
  }
  const query = mkdtempSync(join(tmpdir(), "workbench-npm-policy-metadata-"));
  const owner = signal ? undefined : processCancellation();
  const failures: unknown[] = [];
  try {
    const manifest = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "Invalid manifest");
    writeFileSync(
      join(query, "package.json"),
      JSON.stringify({ private: true, packageManager: manifest.packageManager, dependencies }),
    );
    // A disposable query importer exposes transitive names to outdated; project manifests and locks remain untouched.
    writeFileSync(
      join(query, "pnpm-lock.yaml"),
      stringify({
        lockfileVersion: "9.0",
        importers: {
          ".": {
            dependencies: Object.fromEntries(
              Object.entries(dependencies).map(([name, version]) => [name, { specifier: version, version }]),
            ),
          },
        },
        packages,
      }),
    );
    console.log(
      `Retaining pnpm policy metadata for ${String(Object.keys(dependencies).length)} locked package names...`,
    );
    const result = await captureOwnedChild(
      process.execPath,
      [cli, "package-manager-exec", "--", "outdated", "--long", "--json"],
      {
        cwd: query,
        signal: required(signal ?? owner?.signal, "Missing preparation cancellation"),
        env: {
          ...process.env,
          WORKBENCH_PROJECT_ROOT: root,
          WORKBENCH_DISTRIBUTION_ROOT: resolve(import.meta.dirname, ".."),
        },
      },
      16 * 1024 * 1024,
    );
    // outdated returns 1 when newer releases exist; malformed output or execution failures still reject preparation.
    if (result.error || (result.status !== 0 && result.status !== 1) || !result.stdout.trim())
      throw new Error(`Cannot retain pnpm policy metadata: ${String(result.error ?? result.stderr)}`);
    record(JSON.parse(result.stdout), "Invalid pnpm metadata query result");
  } catch (error) {
    failures.push(error);
  }
  owner?.close();
  try {
    rmSync(query, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "pnpm metadata retention and cleanup failed", { cause: failures[0] });
}

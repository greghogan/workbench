import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciProcessOwner } from "../scripts/ci-lifecycle.mjs";
import { processCancellation, runOwnedChild } from "../scripts/owned-child.mjs";
import { settleCleanup } from "./diagnostics.js";

export interface ContainerConfiguration {
  configuration?: { image?: string; features?: Record<string, unknown>; mounts?: unknown[] };
  mergedConfiguration?: { features?: Record<string, unknown> };
}

export function validateContainerOwnership(configured: ContainerConfiguration, builder: string): void {
  if (configured.configuration?.image && !/@sha256:[0-9a-f]{64}$/.test(configured.configuration.image))
    throw new Error("prebuilt development images must be pinned by SHA-256 digest");
  if (
    builder !== "native" &&
    (Object.keys(configured.configuration?.features ?? {}).length ||
      Object.keys(configured.mergedConfiguration?.features ?? {}).length)
  )
    throw new Error(
      "managed Dev Container profiles require their builder in the image; remove independently installed Features",
    );
}

/** Own the startup process group, including Docker clients the upstream CLI leaves attached.
 * Resource affinity/cgroup membership is inherited; only signal ownership changes.
 * Docker's --sig-proxy=false leaves the workspace running when its attached client exits.
 */
export async function containerStartup(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform === "win32")
    throw new Error("Workbench Dev Container execution requires a POSIX host; use WSL or an editor on Windows");
  // Upstream's updateUID Dockerfile has a shared filename; concurrent startups must own separate scratch directories.
  const temporary = mkdtempSync(join(tmpdir(), "workbench-devcontainer-"));
  const cancellation = processCancellation(),
    limit = new AbortController();
  let output = "",
    errors = "",
    overflow: Error | undefined,
    failure: unknown;
  let drained = false,
    outputBytes = 0;
  const owner = ciProcessOwner();
  try {
    const result = await runOwnedChild(command, args, {
      cwd: process.cwd(),
      env: { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      signal: AbortSignal.any([cancellation.signal, limit.signal]),
      ...(owner ? { owner } : {}),
      stopDescendantsOnExit: true,
      output: (stdout, stderr) => {
        stdout.setEncoding("utf8").on("data", (chunk: string) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > 16 * 1024 * 1024) {
            overflow ??= new Error("Dev Container protocol output exceeds 16 MiB");
            limit.abort(overflow);
          } else output += chunk;
        });
        stderr.setEncoding("utf8").on("data", (chunk: string) => {
          errors += chunk;
          let end;
          while ((end = errors.indexOf("\n")) >= 0) {
            const line = errors.slice(0, end);
            errors = errors.slice(end + 1);
            try {
              const event = JSON.parse(line) as { type?: string; text?: string; channel?: string; level?: number };
              if (event.text && (event.channel === "postCreate" || event.level === 3))
                process.stderr.write(event.text + (event.type === "text" && !event.text.endsWith("\n") ? "\n" : ""));
            } catch {
              process.stderr.write(`${line}\n`);
            }
          }
          // A malformed progress record must not grow an unbounded retained fragment.
          if (errors.length > 64 * 1024) {
            process.stderr.write(errors);
            errors = "";
          }
        });
      },
    });
    drained = !result.descendantsActive;
    if (errors) process.stderr.write(errors);
    if (overflow) throw overflow;
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Dev Container startup failed: ${String(result.status ?? result.signal)}`);
  } catch (error) {
    failure = error;
  }
  await settleCleanup(
    [
      () => {
        cancellation.close();
      },
      () => {
        if (drained) rmSync(temporary, { recursive: true, force: true });
      },
    ],
    failure,
  );
  return output;
}

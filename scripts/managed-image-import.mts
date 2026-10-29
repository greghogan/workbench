import { createHash } from "node:crypto";
import { join } from "node:path";
import { withCacheLock } from "../src/cache-lock.ts";
import { userDirectory } from "../src/storage.ts";
import type { ManagedProcessScope } from "./managed-process.mjs";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.mjs";

/** Serialize imports on this engine so one operation cannot remove another import's source tag. */
export async function importManagedImage(
  scope: ManagedProcessScope,
  archive: string,
  image: string,
  container?: string,
): Promise<void> {
  const docker = (args: string[]) => scope.run("docker", args, { capture: true });
  const engine = await docker(["info", "--format", "{{.ID}}"]);
  if (!engine) throw new Error("Cannot identify the Docker engine for image import");
  const lock = join(userDirectory("cache"), "image-imports", createHash("sha256").update(engine).digest("hex"));
  await withCacheLock(lock, async () => {
    const existing = new Set((await docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n"));
    const loaded = await scope.run(
      "bash",
      container
        ? [
            "-o",
            "pipefail",
            "-c",
            'docker cp "$1:$2" - | tar -xO | docker load',
            "workbench-image-import",
            container,
            archive,
          ]
        : ["-o", "pipefail", "-c", 'docker load < "$1"', "workbench-image-import", archive],
      { capture: true },
    );
    const sources = [...loaded.matchAll(/^Loaded image(?: ID)?: (.+)$/gm)].map((match) => match[1]?.trim());
    const source = sources[0];
    if (sources.length !== 1 || !source) throw new Error("Docker must report one imported image identity");
    const id = await docker(["image", "inspect", "--format", "{{.Id}}", source]);
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Docker returned an invalid imported image identity");
    await docker(["tag", id, image]);
    // Existing tags remain caller-owned. Only newly introduced managed-pack tags belong to this operation.
    if (
      source !== image &&
      !existing.has(source) &&
      /^workbench-(?:nix-prepared:[a-z0-9]{32}|guix-prepared-[a-f0-9]{64}:latest)$/.test(source)
    ) {
      try {
        if ((await docker(["image", "inspect", "--format", "{{.Id}}", source])) === id)
          await docker(["image", "rm", source]);
      } catch (error) {
        try {
          diagnostic(
            LogLevel.Warn,
            DiagnosticOperation.Command,
            DiagnosticOutcome.Failed,
            { command: "managed image source tag cleanup" },
            error,
            "image staged; source tag cleanup did not complete",
          );
        } catch {
          /* Optional cleanup diagnostics cannot invalidate successful staging. */
        }
      }
    }
  });
}

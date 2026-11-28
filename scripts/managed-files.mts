import { stageFile, type StagedFile } from "../app/src/core/runtime/file-publication.mjs";
import { createHash } from "node:crypto";

export const guixBootstrapDockerfile = ".devcontainer/guix/Dockerfile";
export const guixBootstrapProgram = "scripts/ci-guix-bootstrap.scm";

export function guixBootstrapContract(dockerfile: Buffer, program: Buffer): string {
  const digest = createHash("sha256");
  for (const content of [dockerfile, program]) digest.update(createHash("sha256").update(content).digest());
  return digest.digest("hex");
}

/** All candidates are complete before the first atomic publication. */
export function replaceManagedFiles(
  files: readonly (readonly [string, string | Uint8Array])[],
  beforeReplace?: (path: string) => void,
) {
  if (new Set(files.map(([path]) => path)).size !== files.length) throw new Error("Duplicate managed output path");
  const staged: StagedFile[] = [],
    published: string[] = [],
    failures: unknown[] = [];
  try {
    for (const [path, bytes] of files) staged.push(stageFile(path, bytes, 0o644));
    for (const file of staged) {
      file.publish(() => beforeReplace?.(file.path));
      published.push(file.path);
    }
  } catch (error) {
    failures.push(error);
  }
  for (const file of staged)
    try {
      file.discard();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Managed file replacement failed; published files: ${published.join(", ") || "none"}`,
      { cause: failures[0] },
    );
}

import { stageFile, type StagedFile } from "./file-publication.mjs";

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

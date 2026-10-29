import { readBoundedFile } from "./file-reads.js";

export const mavenMetadataLimit = 16 * 1024 * 1024;
export interface MavenFile {
  path: string;
  bytes: Buffer | undefined;
}
export function readMavenMetadata(path: string): Buffer {
  return readBoundedFile(path, mavenMetadataLimit, "Maven metadata");
}
export function optionalMavenMetadata(path: string): Buffer | undefined {
  try {
    return readMavenMetadata(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
/** Compare against the same bytes used to stage and identify this operation's inputs. */
export function assertMavenFiles(files: readonly MavenFile[]): void {
  for (const { path, bytes } of files) {
    const current = optionalMavenMetadata(path);
    if (bytes === undefined ? current !== undefined : !current?.equals(bytes))
      throw new Error(`Maven input changed during execution: ${path}`);
  }
}

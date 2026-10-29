import { createHash } from "node:crypto";
import { combineFailures } from "./diagnostic-errors.mjs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface ArtifactComparison {
  equal: boolean;
  firstDifference?: number;
  left: { bytes: number; sha256: string };
  right: { bytes: number; sha256: string };
}
/** Fixed-size buffers keep release comparison independent of archive size. */
export async function compareArtifacts(left: string, right: string): Promise<ArtifactComparison> {
  const inspect = async (path: string) => {
    const file = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size))
        throw new Error("Expected a regular rebuild artifact");
      return { file, before, hash: createHash("sha256"), bytes: 0, buffer: Buffer.alloc(65536) };
    } catch (failure) {
      try {
        await file.close();
      } catch (cleanup) {
        throw combineFailures(failure, cleanup, "Artifact inspection and cleanup failed");
      }
      throw failure;
    }
  };
  const a = await inspect(left);
  try {
    const b = await inspect(right);
    try {
      let firstDifference: number | undefined;
      for (;;) {
        // read() may return short reads; fill each window before comparing it.
        const next = async (item: typeof a) => {
          let length = 0;
          const capacity = Math.min(item.buffer.length, item.before.size - item.bytes + 1);
          while (length < capacity) {
            const value = await item.file.read(item.buffer, length, capacity - length, null);
            if (!value.bytesRead) break;
            length += value.bytesRead;
          }
          item.hash.update(item.buffer.subarray(0, length));
          item.bytes += length;
          if (item.bytes > item.before.size) throw new Error("Rebuild artifact grew during comparison");
          return length;
        };
        const [al, bl] = await Promise.all([next(a), next(b)]);
        const start = a.bytes - al;
        if (
          firstDifference === undefined &&
          (al !== bl || !a.buffer.subarray(0, al).equals(b.buffer.subarray(0, bl)))
        ) {
          for (let index = 0; index < Math.min(al, bl); index++)
            if (a.buffer[index] !== b.buffer[index]) {
              firstDifference = start + index;
              break;
            }
          if (firstDifference === undefined && al !== bl) firstDifference = start + Math.min(al, bl);
        }
        if (!al && !bl) break;
      }
      for (const item of [a, b]) {
        const after = await item.file.stat();
        if (
          !after.isFile() ||
          item.bytes !== item.before.size ||
          after.size !== item.before.size ||
          after.mtimeMs !== item.before.mtimeMs ||
          after.ctimeMs !== item.before.ctimeMs
        )
          throw new Error("Rebuild artifact changed during comparison");
      }
      return {
        equal: firstDifference === undefined,
        ...(firstDifference === undefined ? {} : { firstDifference }),
        left: { bytes: a.bytes, sha256: a.hash.digest("hex") },
        right: { bytes: b.bytes, sha256: b.hash.digest("hex") },
      };
    } finally {
      await b.file.close();
    }
  } finally {
    await a.file.close();
  }
}

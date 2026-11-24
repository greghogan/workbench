import { readBoundedFile } from "../../runtime/file-reads.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withArtifactResponse, artifactSourceUrls } from "./artifact-streams.js";
import { userDirectory } from "../../storage/storage.js";
import { ownedPath } from "../../runtime/paths.js";

export function artifactProofPath(url: string): string {
  return ownedPath(userDirectory("cache"), `authentication/${createHash("sha256").update(url).digest("hex")}`);
}

/** Retain authenticated proof bytes for offline reuse; callers reverify them against their current trust policy. */
export async function artifactProof(
  url: string,
  limit: number,
  label: string,
  signal?: AbortSignal,
  backupUrls?: string[],
) {
  artifactSourceUrls(url, backupUrls);
  const path = artifactProofPath(url);
  const offline =
    (process.env.WORKBENCH_OFFLINE === "1" || process.env.WORKBENCH_CHECK_SCOPED === "1") &&
    !process.env.WORKBENCH_CHECK_INPUTS;
  let bytes: Buffer;
  if (offline) {
    if (!existsSync(path)) throw new Error(`${label} is unavailable offline: ${url}`);
    bytes = readBoundedFile(path, limit, label);
  } else {
    bytes = await withArtifactResponse(
      url,
      async (source) => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) throw new Error(`${label} exceeds its size limit`);
          chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks);
      },
      signal,
      backupUrls,
    );
  }
  return {
    bytes,
    accept(evidence?: {
      verifiedAt: string;
      signatures: import("../../review/signature-status.js").SignatureEvidence[];
    }) {
      if (offline) return;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.partial`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
        if (evidence) {
          writeFileSync(
            temporary,
            JSON.stringify({ sha256: createHash("sha256").update(bytes).digest("hex"), ...evidence }),
            { flag: "wx", mode: 0o600 },
          );
          renameSync(temporary, `${path}.verification.json`);
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

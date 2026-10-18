import { createHash } from "node:crypto";
import { createReadStream, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** External distributions live outside the snapshot's Git tree; bind their actual frozen bytes too. */
export async function frozenDistributionTree(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string, relative: string): Promise<void> {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name),
        key = `${relative}/${name}`,
        metadata = lstatSync(child);
      if (metadata.isDirectory()) {
        hash.update(JSON.stringify([key, "directory"]));
        await walk(child, key);
      } else if (metadata.isFile()) {
        const content = createHash("sha256");
        for await (const chunk of createReadStream(child)) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected frozen distribution encoding");
          content.update(chunk);
        }
        hash.update(JSON.stringify([key, metadata.mode & 0o111, content.digest("hex")]));
      } else throw new Error("External distribution contains an uncertain file type; fresh verification required");
    }
  }
  await walk(directory, "");
  return hash.digest("hex");
}

/** Artifact identity is independent of the source-specific evidence that it can check this tree. */
export interface VerificationProof {
  version: 1;
  key: string;
}
export function verificationProof(input: {
  image: string;
  trees: { path: string; tree: string }[];
  verifier: string[];
  environment: Record<string, unknown>;
  container: Record<string, unknown>;
}): VerificationProof {
  return { version: 1, key: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}
export function sameVerification(
  saved: VerificationProof | undefined,
  current: VerificationProof | undefined,
): boolean {
  return current !== undefined && saved?.version === 1 && /^[a-f0-9]{64}$/.test(saved.key) && saved.key === current.key;
}

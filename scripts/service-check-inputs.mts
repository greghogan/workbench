import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface VerifiedInput {
  path: string;
  sha256: string;
}

export async function verifyServiceInput(input: VerifiedInput, label: string, signal: AbortSignal): Promise<void> {
  if (!isAbsolute(input.path) || !/^[0-9a-f]{64}$/.test(input.sha256))
    throw new Error(`${label} requires an absolute path and a lowercase SHA-256 digest`);
  const readStat = () => lstatSync(input.path, { bigint: true, throwIfNoEntry: false });
  const before = readStat();
  if (!before?.isFile()) throw new Error(`${label} must be a regular file: ${input.path}`);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(input.path, { signal })) hash.update(bytes as Buffer);
  const after = readStat();
  if (after?.ino !== before.ino || after.dev !== before.dev || after.ctimeNs !== before.ctimeNs)
    throw new Error(`${label} changed during verification`);
  if (hash.digest("hex") !== input.sha256) throw new Error(`${label} checksum differs from the configured digest`);
}

export async function serviceCandidate(signal: AbortSignal): Promise<VerifiedInput> {
  const directory = process.env.WORKBENCH_EXTENDED_ARTIFACTS ?? resolve("dist/workbench-artifacts");
  if (!isAbsolute(directory)) throw new Error("WORKBENCH_EXTENDED_ARTIFACTS must be an absolute directory");
  const sums = join(directory, "SHA256SUMS");
  if (!lstatSync(sums, { throwIfNoEntry: false })?.isFile())
    throw new Error(
      "Build the candidate release and set WORKBENCH_EXTENDED_ARTIFACTS to its workbench-artifacts directory",
    );
  const sha256 = /^([a-f0-9]{64}) {2}workbench\.tar\.gz$/.exec(readFileSync(sums, "utf8").trimEnd())?.[1];
  if (!sha256) throw new Error("Candidate SHA256SUMS must identify workbench.tar.gz");
  const input = { path: join(directory, "workbench.tar.gz"), sha256 };
  await verifyServiceInput(input, "Workbench candidate archive", signal);
  return input;
}

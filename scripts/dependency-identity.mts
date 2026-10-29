import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isRecord, record } from "./values.mjs";

// Installation hooks can call any other script; retain the whole script table when a hook is present.
const installationHooks = new Set([
  "pnpm:devPreinstall",
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
]);

const unorderedFields = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** Package managers parse manifests; unrelated commands and JSON presentation do not select dependencies. */
export function dependencyInputHash(path: string, bytes: Buffer): string {
  let input = bytes;
  if (basename(path) === "package.json") {
    const precision = { preserveBytes: false };
    const parsed: unknown = JSON.parse(bytes.toString("utf8"), (_key: string, value: unknown) => {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        precision.preserveBytes = true;
      return value;
    });
    const manifest = record(parsed, `${path}: invalid package manifest`);
    // JSON.stringify cannot preserve these numbers. Retain exact bytes rather than alias distinct inputs.
    if (precision.preserveBytes) return createHash("sha256").update(bytes).digest("hex");
    if (isRecord(manifest.scripts) && !Object.keys(manifest.scripts).some((name) => installationHooks.has(name)))
      delete manifest.scripts;
    input = Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(manifest)
            .sort()
            .map((key) => [key, unorderedFields.has(key) ? canonical(manifest[key]) : manifest[key]]),
        ),
      ),
    );
  }
  // Arbitrary JSON can be signed or consumed as bytes. Only normalize formats with a known semantic contract.
  return createHash("sha256").update(input).digest("hex");
}

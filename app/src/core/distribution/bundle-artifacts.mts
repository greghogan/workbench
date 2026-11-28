import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { isRecord } from "../runtime/values.mjs";
import * as zlib from "node:zlib";

export const bundleFormats = { brotli: "br", zlib: "gz", zstd: "zst" } as const;
export type BundleCompression = keyof typeof bundleFormats;
const isCompression = (value: unknown): value is BundleCompression =>
  typeof value === "string" && Object.hasOwn(bundleFormats, value);

export function decodeBundle(contents: Uint8Array, compression: BundleCompression): Buffer {
  switch (compression) {
    case "brotli":
      return zlib.brotliDecompressSync(contents);
    case "zlib":
      return zlib.gunzipSync(contents);
    case "zstd":
      if (!("zstdDecompressSync" in zlib))
        throw new Error("Zstandard verification requires Node.js with built-in Zstandard support");
      return zlib.zstdDecompressSync(contents);
  }
}

export function bundleCompression(root: string) {
  const bundle = parse(readFileSync(join(root, "workbench/config.toml"), "utf8")).bundle;
  const selected = (isRecord(bundle) ? bundle.compression : undefined) ?? "brotli";
  if (!isCompression(selected)) throw new Error(`Unknown bundle.compression: ${JSON.stringify(selected)}`);
  return selected;
}

export function bundleLoader(compression: BundleCompression): Buffer {
  return Buffer.from(
    `require("../bin/bundle-runtime.cjs")(module, __filename, ${JSON.stringify(compression)}, require);\n`,
  );
}

export function encodeBundle(contents: zlib.InputType, compression: BundleCompression): Buffer {
  const compress = {
    brotli: () => zlib.brotliCompressSync(contents),
    zlib: () => {
      const compressed = zlib.gzipSync(contents, { level: 9 });
      compressed[9] = 255; // Use the portable gzip OS marker for identical headers across hosts.
      return compressed;
    },
    zstd: () => {
      if (!("zstdCompressSync" in zlib))
        throw new Error("Zstandard bundling requires Node.js with built-in Zstandard support");
      return zlib.zstdCompressSync(contents, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
    },
  }[compression];
  return compress();
}

export function bundleArtifacts(name: string, contents: zlib.InputType, compression: unknown) {
  if (!isCompression(compression)) throw new Error(`Unknown bundle.compression: ${String(compression)}`);
  return new Map([
    [`${name}.cjs`, bundleLoader(compression)],
    [`${name}.cjs.${bundleFormats[compression]}`, encodeBundle(contents, compression)],
  ]);
}
export * from "./bundle-layout.mts";

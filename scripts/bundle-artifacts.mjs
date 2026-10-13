import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import * as zlib from "node:zlib";

export const bundleFormats = { brotli: "br", zlib: "gz", zstd: "zst" };

export function bundleCompression(root) {
  const selected = parse(readFileSync(join(root, "workbench/config.toml"), "utf8")).bundle?.compression ?? "brotli";
  if (typeof selected !== "string" || !Object.hasOwn(bundleFormats, selected))
    throw new Error(`Unknown bundle.compression: ${String(selected)}`);
  return selected;
}

export function bundleArtifacts(name, contents, compression) {
  if (typeof compression !== "string" || !Object.hasOwn(bundleFormats, compression))
    throw new Error(`Unknown bundle.compression: ${String(compression)}`);
  const compress = {
    brotli: () => zlib.brotliCompressSync(contents),
    zlib: () => {
      const compressed = zlib.gzipSync(contents, { level: 9 });
      compressed[9] = 255; // Use the portable gzip OS marker for identical headers across hosts.
      return compressed;
    },
    zstd: () => {
      if (!zlib.zstdCompressSync)
        throw new Error("Zstandard bundling requires Node.js with built-in Zstandard support");
      return zlib.zstdCompressSync(contents, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
    },
  }[compression];
  return new Map([
    [
      `${name}.cjs`,
      Buffer.from(
        `require("../bin/bundle-runtime.cjs")(module, __filename, ${JSON.stringify(compression)}, require);\n`,
      ),
    ],
    [`${name}.cjs.${bundleFormats[compression]}`, compress()],
  ]);
}

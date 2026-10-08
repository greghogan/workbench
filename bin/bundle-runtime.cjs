const { readFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { compileFunction } = require("node:vm");
const zlib = require("node:zlib");

// Use the calling CommonJS module so exports, require resolution, and caching retain Node's semantics.
module.exports = function loadBundle(target, filename, compression, localRequire) {
  const formats = {
    brotli: ["br", zlib.brotliDecompressSync],
    zlib: ["gz", zlib.gunzipSync],
    zstd: ["zst", zlib.zstdDecompressSync],
  };
  if (!Object.hasOwn(formats, compression)) throw new Error(`Unknown bundle compression: ${compression}`);
  const format = formats[compression];
  const [extension, decompress] = format;
  if (!decompress)
    throw new Error(
      "Zstandard bundles require Node.js with built-in Zstandard support (22.15+, 23.8+, or later release lines)",
    );
  const source = decompress(readFileSync(`${filename}.${extension}`)).toString("utf8");
  const execute = compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], { filename });
  execute.call(target.exports, target.exports, localRequire, target, filename, dirname(filename));
};

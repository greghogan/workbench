import fs = require("node:fs");
import path = require("node:path");
import vm = require("node:vm");
import zlib = require("node:zlib");

// Use the calling CommonJS module so exports, require resolution, and caching retain Node's semantics.
function loadBundle(target: NodeJS.Module, filename: string, compression: string, localRequire: NodeJS.Require): void {
  const formats: Record<string, readonly [string, ((buffer: Uint8Array) => Buffer) | undefined]> = {
    brotli: ["br", zlib.brotliDecompressSync],
    zlib: ["gz", zlib.gunzipSync],
    zstd: ["zst", zlib.zstdDecompressSync],
  };
  const format = Object.hasOwn(formats, compression) ? formats[compression] : undefined;
  if (!format) throw new Error(`Unknown bundle compression: ${compression}`);
  const [extension, decompress] = format;
  if (!decompress)
    throw new Error(
      "Zstandard bundles require Node.js with built-in Zstandard support (22.15+, 23.8+, or later release lines)",
    );
  const source = decompress(fs.readFileSync(`${filename}.${extension}`)).toString("utf8");
  const execute = vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], { filename });
  execute.call(target.exports, target.exports, localRequire, target, filename, path.dirname(filename));
}

export = loadBundle;

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { bundleLicenses } from "./bundle-licenses.mts";
import { writeAtomic } from "../app/src/core/runtime/file-publication.mjs";

export async function buildDiagramAssets(root: string, check: boolean) {
  const renderer = join(root, "app/src/server/browser/diagram-renderer.ts");
  if (!existsSync(renderer)) return;
  const library = createRequire(join(root, "package.json")).resolve("@mermaid-js/tiny");
  const compiled = await build({
    absWorkingDir: root,
    entryPoints: [renderer],
    platform: "browser",
    format: "iife",
    target: "es2022",
    bundle: true,
    minify: true,
    metafile: true,
    write: false,
  });
  const controller = compiled.outputFiles[0]?.text;
  if (!controller) throw new Error("Diagram renderer compilation produced no output");
  const script = readFileSync(library, "utf8") + "\n" + controller;
  if (/<\/script/i.test(script)) throw new Error("Diagram script must be safe for an inline script element");
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Diagram renderer</title>' +
    "<style>html,body{margin:0;font-family:system-ui,sans-serif}</style></head><body>" +
    '<main id="diagram"></main><script>' +
    script +
    "</script></body></html>";
  const manifest = {
    path: "/assets/diagrams.html",
    digest: createHash("sha256").update(html).digest("hex"),
    scriptHash: createHash("sha256").update(script).digest("base64"),
    file: "app/resources/browser/diagrams.html.br",
  };
  const outputs = [
    { path: manifest.file, bytes: brotliCompressSync(html, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) },
    {
      path: "app/resources/browser/DIAGRAM_NOTICES.txt",
      bytes: Buffer.from(bundleLicenses(root, [...Object.keys(compiled.metafile.inputs), library])),
    },
  ];
  for (const output of outputs) {
    const path = join(root, output.path);
    if (check) {
      if (!existsSync(path) || !readFileSync(path).equals(output.bytes))
        throw new Error(`${output.path} is stale; run pnpm run tooling:build`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeAtomic(path, output.bytes);
    }
  }
  return manifest;
}

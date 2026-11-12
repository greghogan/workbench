import { readBoundedFileAsync } from "../../core/runtime/file-reads.js";
import { ownedPath } from "../../core/runtime/paths.js";
import { projectRoot, distributionRoot } from "../../core/projects/project-context.js";
import { assetManifest } from "../browser/asset-manifest.js";
import { brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const decode = promisify(brotliDecompress);
let contents: Promise<Buffer> | undefined;

/** Keep the large renderer outside application startup and verify the bytes before serving them. */
export function diagramAsset(): Promise<Buffer> {
  if (contents) return contents;
  const pending = (async () => {
    const compressed = await readBoundedFileAsync(
      ownedPath(distributionRoot(projectRoot()), assetManifest.diagrams.file),
      16 * 1024 * 1024,
      "diagram renderer",
    );
    const html = await decode(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    if (createHash("sha256").update(html).digest("hex") !== assetManifest.diagrams.digest)
      throw new Error("Diagram renderer contents do not match this application; rebuild or reinstall Workbench");
    return html;
  })();
  contents = pending;
  void pending.catch(() => {
    if (contents === pending) contents = undefined;
  });
  return pending;
}

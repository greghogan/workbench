import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { expect, test, vi } from "vitest";
import { WorkerGeneration } from "../src/web/worker-generation.ts";
import { brotliCompressSync } from "node:zlib";

test.each([false, true])(
  "a captured worker and its lazy modules survive distribution replacement (compressed: %s)",
  async (compressed) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-generation-test-"));
    vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", root);
    let generation: WorkerGeneration | undefined;
    try {
      mkdirSync(join(root, "languages"));
      writeFileSync(join(root, "languages/index.toml"), "");
      mkdirSync(join(root, "bundle"));
      const source =
        'require("node:worker_threads").parentPort.postMessage(["original", require("./formatter.cjs").value, require("./attestation-verification.cjs").value])';
      const modules = {
        main: source,
        formatter: 'exports.value="formatter";',
        "attestation-verification": 'exports.value="verifier";',
      };
      for (const [name, contents] of Object.entries(modules)) {
        writeFileSync(
          join(root, `bundle/${name}.cjs`),
          compressed ? 'require("../bin/bundle-runtime.cjs")(module, __filename, "brotli", require);\n' : contents,
        );
        if (compressed) writeFileSync(join(root, `bundle/${name}.cjs.br`), brotliCompressSync(Buffer.from(contents)));
      }
      generation = new WorkerGeneration(root);
      for (const name of Object.keys(modules)) {
        writeFileSync(join(root, `bundle/${name}.cjs`), 'throw new Error("replacement")');
        if (compressed) writeFileSync(join(root, `bundle/${name}.cjs.br`), "replacement");
      }
      expect(readFileSync(generation.path, "utf8")).toBe(source);
      const worker = new Worker(generation.path);
      const message = new Promise<unknown>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      const exit = new Promise<void>((resolve, reject) => {
        worker.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(String(code)));
        });
      });
      expect(await message).toEqual(["original", "formatter", "verifier"]);
      await exit;
      const directory = generation.directory;
      generation.close();
      expect(existsSync(directory)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      generation?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

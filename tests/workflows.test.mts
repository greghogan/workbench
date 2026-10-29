import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";
const repository = resolve(import.meta.dirname, "..");

test.skipIf(process.platform === "win32").each(["success", "without-config", "invalid", "empty"])(
  "workflow validation requires no Git checkout and propagates tool failures (%s)",
  (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-workflows-"));
    try {
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      if (outcome !== "without-config")
        writeFileSync(join(root, ".github/actionlint.yaml"), "self-hosted-runner: {labels: [custom]}\n");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const output = join(root, "calls.json");
      if (outcome !== "empty")
        for (const file of ["build.yml", "publish.yaml"])
          writeFileSync(join(root, ".github/workflows", file), "name: fixture\n");
      writeFileSync(
        join(bin, "actionlint"),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2)));process.exit(${String(outcome === "invalid" ? 1 : 0)});\n`,
      );
      chmodSync(join(bin, "actionlint"), 0o755);
      const result = spawnSync(process.execPath, [join(repository, "scripts/check-workflows.mjs")], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: [bin, process.env.PATH].join(delimiter), CALLS: output },
      });
      if (outcome === "success" || outcome === "without-config") expect(result.status, result.stderr).toBe(0);
      else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(outcome === "empty" ? "No GitHub workflows" : "Workflow validation failed");
      }
      if (outcome !== "empty")
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
          ...(outcome === "without-config" ? [] : ["-config-file", ".github/actionlint.yaml"]),
          ".github/workflows/build.yml",
          ".github/workflows/publish.yaml",
        ]);
      else expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

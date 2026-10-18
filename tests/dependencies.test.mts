import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("pnpm setup preserves the old installation on failure and removes its local store only after replacement", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-pnpm-storage-")));
  temporary.push(root);
  const project = join(root, "project");
  const modules = join(project, "node_modules");
  const external = join(root, "cache/pnpm");
  mkdirSync(join(modules, ".pnpm"), { recursive: true });
  writeFileSync(join(modules, ".pnpm/original"), "installed dependency");
  writeFileSync(join(modules, ".modules.yaml"), "virtualStoreDir: .pnpm\n");
  writeFileSync(join(project, "package.json"), '{"packageManager":"pnpm@12.6.0"}\n');
  writeFileSync(join(project, "pnpm-workspace.yaml"), "# Default isolated linker\n");
  const run = (source: string) =>
    spawnSync(
      process.execPath,
      [resolve("bundle/main.cjs"), "dependency-setup", "--", process.execPath, "-e", source],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          WORKBENCH_PROJECT_ROOT: project,
          WORKBENCH_STORAGE_EXTERNAL: "true",
          PNPM_CONFIG_VIRTUAL_STORE_DIR: external,
          PNPM_CONFIG_STORE_DIR: join(root, "cache/downloads/pnpm"),
        },
      },
    );
  expect(run("process.exit(7)").status).not.toBe(0);
  expect(readFileSync(join(modules, ".pnpm/original"), "utf8")).toBe("installed dependency");
  const result = run(
    'const fs=require("node:fs"); const path=require("node:path"); const target=process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR; fs.mkdirSync(target,{recursive:true}); fs.writeFileSync(path.join(target,"installed"),"ready"); fs.writeFileSync("node_modules/.modules.yaml", JSON.stringify({virtualStoreDir:target,storeDir:path.join(process.env.PNPM_CONFIG_STORE_DIR,"v11")}));',
  );
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(modules, ".pnpm"))).toBe(false);
  expect(readFileSync(join(external, "installed"), "utf8")).toBe("ready");
  const wrongStore = run(
    'const fs=require("node:fs"); const target=process.env.PNPM_CONFIG_VIRTUAL_STORE_DIR; fs.writeFileSync("node_modules/.modules.yaml",JSON.stringify({virtualStoreDir:target,storeDir:process.env.PNPM_CONFIG_STORE_DIR+"-other"}));',
  );
  expect(wrongStore.status).not.toBe(0);
  expect(wrongStore.stderr).toMatch(/selected external package store/);
  expect(readFileSync(join(external, "installed"), "utf8")).toBe("ready");
});

test("Python setup replaces environments only after success, restores failed local switches, and preserves foreign links", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-dependency-links-")));
  temporary.push(root);
  const project = join(root, "project");
  const cache = join(root, "cache");
  mkdirSync(project);
  mkdirSync(cache);
  writeFileSync(join(project, "pyproject.toml"), "[project]\nname='fixture'\n");
  writeFileSync(join(cache, ".workbench-dependencies.json"), "{}\n");
  mkdirSync(join(project, ".venv"));
  writeFileSync(join(project, ".venv/pyvenv.cfg"), "home = fixture\n");
  writeFileSync(join(project, ".venv/original"), "preserve until success");
  const install =
    'const fs=require("node:fs"); const path=require("node:path"); const env=process.env.UV_PROJECT_ENVIRONMENT || ".venv"; fs.mkdirSync(env,{recursive:true}); fs.writeFileSync(path.join(env,"pyvenv.cfg"),"home = fixture\\n"); fs.writeFileSync(path.join(env,"installed"),"ready");';
  const run = (external: boolean, source: string) =>
    spawnSync(
      process.execPath,
      [resolve("bundle/main.cjs"), "dependency-setup", "--", process.execPath, "-e", source],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          WORKBENCH_PROJECT_ROOT: project,
          WORKBENCH_STORAGE_EXTERNAL: String(external),
          UV_PROJECT_ENVIRONMENT: external ? join(cache, "venv") : undefined,
        },
      },
    );
  expect(run(true, "process.exit(7)").status).not.toBe(0);
  expect(readFileSync(join(project, ".venv/original"), "utf8")).toBe("preserve until success");
  const installed = run(true, install);
  expect(installed.status, installed.stderr).toBe(0);
  expect(realpathSync(join(project, ".venv"))).toBe(join(cache, "venv"));
  expect(existsSync(join(project, ".venv.workbench-backup"))).toBe(false);
  expect(run(false, `${install}process.exit(7);`).status).not.toBe(0);
  expect(realpathSync(join(project, ".venv"))).toBe(join(cache, "venv"));
  const local = run(false, install);
  expect(local.status, local.stderr).toBe(0);
  expect(realpathSync(join(project, ".venv"))).toBe(join(project, ".venv"));
  expect(readFileSync(join(cache, "venv/installed"), "utf8")).toBe("ready");
  rmSync(join(project, ".venv"), { recursive: true });
  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep"), "user-owned");
  symlinkSync(foreign, join(project, ".venv"), "junction");
  expect(run(true, install).status).not.toBe(0);
  expect(readFileSync(join(foreign, "keep"), "utf8")).toBe("user-owned");
});

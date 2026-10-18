import { promised } from "./fixtures/promised.mjs";
import { required } from "../src/invariants.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { refreshGoInputs } from "../scripts/refresh-managed-inputs.mjs";
const temporary: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-source-refresh-"));
  temporary.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Go metadata acquisition stages locks, verifies modules, and cleans only its temporary module cache", () => {
  const root = fixture(),
    tool = join(root, "go.cjs"),
    log = join(root, "calls.jsonl");
  writeFileSync(join(root, "go.mod"), "module example.test/project\ngo 1.26.8\n");
  const sums = "example.test/dep v1.0.0 h1:archive\nexample.test/dep v1.0.0/go.mod h1:module\n";
  writeFileSync(join(root, "go.sum"), sums);
  writeFileSync(
    tool,
    `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd(),cache:process.env.GOMODCACHE})+'\\n');if(args[0]==='clean'){fs.rmSync(process.env.GOMODCACHE,{recursive:true,force:true});}else if(args[1]==='download'){const directory=path.join(process.env.GOMODCACHE,'cache/download/example.test/dep/@v');fs.mkdirSync(directory,{recursive:true});for(const [ext,bytes]of [['zip','zip bytes'],['mod','module example.test/dep'],['info','version info']])fs.writeFileSync(path.join(directory,'v1.0.0.'+ext),bytes);fs.appendFileSync('go.sum','temporary graph expansion\\n');console.log(JSON.stringify({Path:'example.test/dep',Version:'v1.0.0',Sum:process.env.BAD_SUM?'mismatch':'h1:archive',GoModSum:'h1:module',Zip:path.join(directory,'v1.0.0.zip'),GoMod:path.join(directory,'v1.0.0.mod'),Info:path.join(directory,'v1.0.0.info')}));}`,
  );
  vi.stubEnv("GOMODCACHE", undefined);
  const result = refreshGoInputs(root, [process.execPath, tool]);
  expect(readFileSync(join(root, "go.sum"), "utf8")).toBe(sums);
  expect(result.inputs).toHaveLength(3);
  expect(result.inputs.find((entry) => entry.destination.endsWith(".zip"))).toEqual({
    url: "https://proxy.golang.org/example.test/dep/@v/v1.0.0.zip",
    destination: "go/example.test/dep/@v/v1.0.0.zip",
    hash: `sha256-${createHash("sha256").update("zip bytes").digest("base64")}`,
  });
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string; cache: string });
  expect(calls.map((call) => call.args)).toEqual([
    ["mod", "download", "-json", "all"],
    ["mod", "verify"],
    ["clean", "-modcache"],
  ]);
  expect(existsSync(required(calls[0], "Expected fixture value").cwd)).toBe(false);
  vi.stubEnv("BAD_SUM", "1");
  expect(() => refreshGoInputs(root, [process.execPath, tool])).toThrow(/did not verify/);
  expect(readFileSync(join(root, "go.sum"), "utf8")).toBe(sums);
  vi.stubEnv("BAD_SUM", undefined);
  const retained = join(fixture(), "modules");
  vi.stubEnv("GOMODCACHE", retained);
  refreshGoInputs(root, [process.execPath, tool]);
  expect(existsSync(retained)).toBe(true);
});

test("metadata collection failure leaves every existing output untouched", async () => {
  const { collectManagedRefresh } = await import("../scripts/refresh-managed-inputs.mjs");
  const { replaceManagedFiles } = await import("../scripts/managed-files.mjs");
  const { mkdirSync } = await import("node:fs");
  const root = fixture();
  mkdirSync(join(root, "workbench"));
  mkdirSync(join(root, "child"));
  writeFileSync(
    join(root, "workbench/projects.toml"),
    '[[language_root]]\npath="."\n[[language_root]]\npath="child"\n',
  );
  for (const directory of [root, join(root, "child")]) {
    writeFileSync(join(directory, "pnpm-lock.yaml"), "fixture");
    writeFileSync(join(directory, "managed-bootstrap.json"), "old bootstrap");
    writeFileSync(join(directory, "managed-registry.json.br"), "old registry");
  }
  const acquire = {
    bootstrap: () => Promise.resolve({ fixture: true }),
    registry: (directory: string) =>
      promised(() => {
        if (directory !== root) throw new Error("registry unavailable");
        return Buffer.from("new registry");
      }),
  };
  await expect(collectManagedRefresh(root, acquire)).rejects.toThrow("registry unavailable");
  expect(readFileSync(join(root, "managed-bootstrap.json"), "utf8")).toBe("old bootstrap");
  acquire.registry = () => Promise.resolve(Buffer.from("new registry"));
  const files = await collectManagedRefresh(root, acquire);
  expect(readFileSync(join(root, "managed-registry.json.br"), "utf8")).toBe("old registry");
  replaceManagedFiles(files);
  expect(readFileSync(join(root, "managed-registry.json.br"), "utf8")).toBe("new registry");
  expect(readFileSync(join(root, "child/managed-bootstrap.json"), "utf8")).toContain('"fixture": true');
  expect(() => {
    replaceManagedFiles([
      [join(root, "managed-registry.json.br"), "bad"],
      [join(root, "missing/output"), "bad"],
    ]);
  }).toThrow();
  expect(readFileSync(join(root, "managed-registry.json.br"), "utf8")).toBe("new registry");
});

test("mixed-language roots merge supplemental sources and reject conflicting identities", async () => {
  const { collectManagedRefresh } = await import("../scripts/refresh-managed-inputs.mjs");
  const { mkdirSync } = await import("node:fs");
  const root = fixture();
  mkdirSync(join(root, "workbench"));
  writeFileSync(join(root, "workbench/projects.toml"), '[[language_root]]\npath="."\n');
  const names = ["uv.lock", "go.sum", ".composer-version"] as const;
  for (const name of names) writeFileSync(join(root, name), "fixture");
  const hash = createHash("sha256").update("fixture").digest("hex");
  const extra = (name: string) => ({
    schema_version: 1,
    source_hashes: { [name]: hash },
    inputs: [
      {
        url: `https://example.test/${name}`,
        hash: `sha256-${Buffer.from(hash, "hex").toString("base64")}`,
        destination: `extra/${name}`,
      },
    ],
  });
  const acquire = {
    python: () => Promise.resolve(extra(names[0])),
    go: () => Promise.resolve(extra(names[1])),
    composer: () => Promise.resolve(extra(names[2])),
  };
  const outputs = await collectManagedRefresh(root, acquire);
  expect(outputs).toHaveLength(1);
  const merged = JSON.parse(String(required(outputs[0], "Expected fixture value: outputs[0]")[1])) as {
    source_hashes: Record<string, string>;
    inputs: { destination: string }[];
  };
  expect(Object.keys(merged.source_hashes)).toEqual(names);
  expect(merged.inputs.map((input) => input.destination)).toEqual(names.map((name) => `extra/${name}`));
  acquire.composer = () => Promise.resolve({ ...extra(names[0]), source_hashes: { [names[0]]: "b".repeat(64) } });
  await expect(collectManagedRefresh(root, acquire)).rejects.toThrow(/Conflicting supplemental source identity/);
});

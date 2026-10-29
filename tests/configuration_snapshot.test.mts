import { nativeTools, assetFor } from "../src/native-assets.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as files from "../src/files.ts";
import { withConfigurationSnapshot } from "../src/configuration-snapshot.ts";
import { readConfig, readLanguageRoots, readProjects } from "../src/project-configuration.ts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-configuration-snapshot-"));
  temporary.push(root);
  mkdirSync(join(root, "workbench"));
  const config = join(root, "workbench/config.toml");
  const save = (width: number) => {
    writeFileSync(
      config,
      `schema_version=1\n[markdown]\nwrap_width=${String(width)}\n[compatibility]\nrequired=false\n`,
    );
  };
  save(120);
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="fixture"\npath="."\n');
  return { root: resolve(root), save };
}

test("one configuration operation acquires a registry once and shares frozen validated declarations", () => {
  const { root } = fixture();
  const reads = vi.spyOn(files, "readToml");
  withConfigurationSnapshot(() => {
    const config = readConfig(root);
    expect(readConfig(root)).toBe(config);
    expect(readProjects(root)).toEqual([{ id: "fixture", path: "." }]);
    expect(readLanguageRoots(root)).toEqual([]);
    expect(() => {
      if (!config.markdown) throw new Error("missing fixture markdown settings");
      config.markdown.wrap_width = 80;
    }).toThrow(TypeError);
  });
  expect(reads.mock.calls.filter(([path]) => path.endsWith("projects.toml"))).toHaveLength(1);
  expect(reads.mock.calls.filter(([path]) => path.endsWith("config.toml"))).toHaveLength(1);
});

test("a snapshot stays consistent across awaits and later operations see edited and proposed trees", async () => {
  const first = fixture(),
    proposed = fixture();
  proposed.save(100);
  await withConfigurationSnapshot(async () => {
    const config = readConfig(first.root);
    first.save(90);
    await Promise.resolve();
    expect(readConfig(first.root)).toBe(config);
    expect(readConfig(first.root).markdown?.wrap_width).toBe(120);
    expect(readConfig(proposed.root).markdown?.wrap_width).toBe(100);
  });
  withConfigurationSnapshot(() => {
    expect(readConfig(first.root).markdown?.wrap_width).toBe(90);
  });
});

test("tool declarations and authenticated assets share an operation snapshot; later operations see updates", () => {
  const { root } = fixture();
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, ".node-version"), "22.0.0");
  const registry = join(root, "scripts/native-assets.json");
  const artifact = (hash: string) => ({
    url: "https://example.invalid/node.zip",
    sha256: hash.repeat(64),
    format: "zip",
    strip: 1,
    bin: "bin",
    authenticationUnavailable: "Fixture only",
  });
  const save = (hash: string) => {
    writeFileSync(
      registry,
      JSON.stringify({ node: { "22.0.0": { [`${process.platform}-${process.arch}`]: artifact(hash) } } }),
    );
  };
  save("a");
  withConfigurationSnapshot(() => {
    const tools = nativeTools(root, root);
    const tool = tools[0];
    if (!tool) throw new Error("Missing fixture tool");
    const selected = assetFor(root, tool, root);
    writeFileSync(join(root, ".node-version"), "22.1.0");
    save("b");
    expect(nativeTools(root, root)).toBe(tools);
    expect(assetFor(root, tool, root)).toBe(selected);
    expect(selected?.sha256).toBe("a".repeat(64));
  });
  withConfigurationSnapshot(() => {
    expect(nativeTools(root, root)[0]?.version).toBe("22.1.0");
    expect(assetFor(root, { name: "node", version: "22.0.0", source: "fixture" }, root)?.sha256).toBe("b".repeat(64));
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { registerProject, updateProjectRequirements } from "../../src/project-registry.ts";
import { buildPaths, prepareBuild } from "../../src/builds.ts";
import { recordResultTools } from "../../src/tool-references.ts";
export function cacheProjectFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workbench-owned-cache-")));
  for (const kind of ["STATE", "CACHE", "CONFIG", "DATA"])
    vi.stubEnv(`WORKBENCH_${kind}_HOME`, join(base, kind.toLowerCase()));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, "../.."));
  vi.stubEnv("WORKBENCH_STORAGE_ROOT", join(base, "cache"));
  vi.stubEnv("WORKBENCH_STORAGE_EXTERNAL", "true");
  vi.stubEnv("RUSTUP_HOME", join(base, "absent-rustup"));
  vi.stubEnv("UV_PYTHON_INSTALL_DIR", join(base, "absent-python"));
  const install = (version: string) => {
    const identity = createHash("sha256").update(version).digest("hex");
    const directory = join(
      base,
      "cache/toolchains/ruby",
      version,
      `${process.platform}-${process.arch}`,
      identity.slice(0, 16),
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".workbench-artifact"), identity + "\n");
    writeFileSync(join(directory, "tool"), "fixture installation; never executed\n");
    return { tool: "ruby", version, directory, root: ".", profile: "" };
  };
  const project = (name: string) => {
    const root = join(base, name);
    mkdirSync(join(root, "workbench"), { recursive: true });
    writeFileSync(join(root, "workbench/projects.toml"), `[[project]]\nid="${name}"\npath="."\n`);
    writeFileSync(
      join(root, "workbench/config.toml"),
      "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
    );
    registerProject(root, name);
    return root;
  };
  const result = (root: string, tool: ReturnType<typeof install>) => {
    const paths = buildPaths(root, root, "native", {}, false);
    prepareBuild(paths);
    writeFileSync(join(paths.directory, "output"), "owned result");
    recordResultTools({
      directory: paths.directory,
      storageRoot: paths.storageRoot,
      identity: paths.identity,
      kind: "builds",
      tools: [tool],
    });
    return paths;
  };
  const working = (root: string, tool: ReturnType<typeof install>) => {
    updateProjectRequirements(root, [tool], "", [tool]);
  };
  return {
    base,
    install,
    project,
    result,
    working,
    close: () => {
      vi.unstubAllEnvs();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { devNull, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { synchronize } from "./sync.js";
import { registerConsumingProject } from "./project-registration.js";
import { citationPdf } from "../scripts/web-browser-fixtures.mjs";

/** One server owns the disposable consumer, its Git state, and isolated personal storage until shutdown. */
export async function createDemonstration(distribution: string, ownedDirectory?: string) {
  const directory = ownedDirectory ?? realpathSync(mkdtempSync(join(tmpdir(), "workbench-demo-")));
  const root = join(directory, "project"),
    source = join(distribution, "demo");
  const previous = new Map<string, string | undefined>();
  const set = (key: string, value: string) => {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  };
  const close = async () => {
    for (const [key, value] of previous)
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    if (existsSync(directory)) await rm(directory, { recursive: true });
  };
  try {
    mkdirSync(root);
    cpSync(join(source, "workbench"), join(root, "workbench"), { recursive: true });
    cpSync(join(source, "README.md"), join(root, "README.md"));
    for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
      set(`WORKBENCH_${kind}_HOME`, join(directory, kind.toLowerCase()));
    set("WORKBENCH_PROJECT_ROOT", root);
    set("WORKBENCH_DEMONSTRATION_ROOT", root);
    set("WORKBENCH_LOCAL_CONFIG_ROOT", root);
    set("WORKBENCH_STORAGE_ROOT", join(directory, "cache"));
    set("WORKBENCH_STORAGE_EXTERNAL", "true");
    set("XDG_DATA_DIRS", join(directory, "system"));
    set("WORKBENCH_EPHEMERAL_CHECKOUT", "0");
    set("GIT_CONFIG_GLOBAL", devNull);
    set("GIT_CONFIG_NOSYSTEM", "1");
    for (const key of [
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) {
      previous.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }
    const git = (...args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          `core.hooksPath=${join(directory, "disabled-hooks")}`,
          "-c",
          "commit.gpgSign=false",
          "-c",
          "user.name=Workbench demonstration",
          "-c",
          "user.email=demo@example.invalid",
          "-C",
          root,
          ...args,
        ],
        { encoding: "utf8" },
      );
      if (result.error || result.status !== 0)
        throw new Error(`Demonstration Git setup failed: ${result.stderr || String(result.error)}`);
    };
    const pdf = citationPdf();
    mkdirSync(join(root, "library/citations"), { recursive: true });
    writeFileSync(join(root, "library/citations/CIT-00-published.pdf"), pdf);
    writeFileSync(
      join(root, "workbench/citations/CIT-00/acquisition.yaml"),
      `sources:\n  - kind: published\n    status: acquired\n    landing-url: https://example.invalid/paper\n    sha256: ${createHash("sha256").update(pdf).digest("hex")}\n`,
    );
    git("init", "--quiet");
    registerConsumingProject(root);
    synchronize(root);
    git("add", ".");
    git("commit", "--quiet", "-m", "Demonstration baseline");
    const provider = join(directory, "collection");
    mkdirSync(join(provider, "workbench/decisions"), { recursive: true });
    cpSync(join(source, "collection/workbench/decisions/ADR-00.md"), join(provider, "workbench/decisions/ADR-00.md"));
    cpSync(join(root, "workbench/CHARTER.md"), join(provider, "workbench/CHARTER.md"));
    cpSync(join(root, "workbench/config.toml"), join(provider, "workbench/config.toml"));
    writeFileSync(join(provider, "workbench/projects.toml"), '[[project]]\nid="patterns"\npath="."\n');
    synchronize(provider);
    const providerGit = (...args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          `core.hooksPath=${join(directory, "disabled-hooks")}`,
          "-c",
          "commit.gpgSign=false",
          "-c",
          "user.name=Workbench demonstration",
          "-c",
          "user.email=demo@example.invalid",
          "-C",
          provider,
          ...args,
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(`Demonstration collection setup failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    providerGit("init", "--quiet");
    providerGit("add", ".");
    providerGit("commit", "--quiet", "-m", "Bundled demonstration collection");
    set("WORKBENCH_DEMONSTRATION_SOURCE", provider);
    const collectionDefaults = { source: provider, commit: providerGit("rev-parse", "HEAD") };
    set("WORKBENCH_DEMONSTRATION_COMMIT", collectionDefaults.commit);
    const adr = join(root, "workbench/decisions/ADR-00.md"),
      baseline = readFileSync(adr, "utf8");
    writeFileSync(adr, baseline.replace("Keep decisions connected", "Keep reviewed decisions connected"));
    git("add", "workbench/decisions/ADR-00.md");
    writeFileSync(
      adr,
      readFileSync(adr, "utf8").replace("Keep reviewed decisions connected", "Keep clear decisions connected"),
    );
    writeFileSync(
      join(root, "workbench/experiments/EXP-00/observation.txt"),
      "Illustrative supporting material awaiting per-file review. No real measurements were collected.\n",
    );
    git("add", "workbench/experiments/EXP-00/observation.txt");
    return { root, directory, collectionDefaults, close };
  } catch (error) {
    await close();
    throw error;
  }
}

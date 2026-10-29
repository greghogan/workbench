import { seedDemonstration } from "./demonstration-story.js";
import { gitNullConfiguration } from "./windows-host.js";
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { settleCleanup } from "./diagnostics.js";

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
    if (!ownedDirectory && existsSync(directory)) await rm(directory, { recursive: true });
  };
  try {
    const resumed = existsSync(root);
    if (!resumed) {
      mkdirSync(root);
      cpSync(join(source, "workbench"), join(root, "workbench"), { recursive: true });
      cpSync(join(source, "README.md"), join(root, "README.md"));
    }
    for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
      set(`WORKBENCH_${kind}_HOME`, join(directory, kind.toLowerCase()));
    set("WORKBENCH_DISTRIBUTION_ROOT", distribution);
    set("WORKBENCH_PROJECT_ROOT", root);
    set("WORKBENCH_DEMONSTRATION_ROOT", root);
    set("WORKBENCH_LOCAL_CONFIG_ROOT", root);
    set("WORKBENCH_STORAGE_ROOT", join(directory, "cache"));
    set("WORKBENCH_STORAGE_EXTERNAL", "true");
    set("XDG_DATA_DIRS", join(directory, "system"));
    set("WORKBENCH_EPHEMERAL_CHECKOUT", "0");
    set("GIT_CONFIG_GLOBAL", gitNullConfiguration);
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
    const repositoryGit = (repository: string, ...args: string[]) => {
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
          repository,
          ...args,
        ],
        { encoding: "utf8" },
      );
      if (result.error || result.status !== 0)
        throw new Error(`Demonstration Git setup failed: ${result.stderr || String(result.error)}`);
      return result.stdout.trim();
    };
    const collectionDefaults = resumed
      ? {
          source: join(directory, "collection"),
          commit: repositoryGit(join(directory, "collection"), "rev-parse", "HEAD"),
        }
      : await seedDemonstration(root, directory, source, repositoryGit);
    set("WORKBENCH_DEMONSTRATION_SOURCE", collectionDefaults.source);
    set("WORKBENCH_DEMONSTRATION_COMMIT", collectionDefaults.commit);
    return { root, directory, collectionDefaults, close };
  } catch (error) {
    await settleCleanup([close], error);
    throw error;
  }
}

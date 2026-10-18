const { existsSync, realpathSync, readFileSync } = require("node:fs");
const { dirname, join, isAbsolute } = require("node:path");
const { execFileSync } = require("node:child_process");

// Project-owned starter: the pinned Workbench executable owns storage configuration.
module.exports = {
  // pnpm owns integrity checks and extraction; managed environments supply locked local sources.
  fetchers: process.env.WORKBENCH_CHECK_INPUTS
    ? [
        {
          canFetch: () => true,
          fetch(_cafs, resolution) {
            const directory = process.env.WORKBENCH_CHECK_INPUTS;
            const declaration = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
            const entries = declaration.inputs.filter(
              (entry) =>
                entry.destination.startsWith("npm/") &&
                entry.hash === resolution.integrity &&
                (!entry.platforms || entry.platforms.includes(`linux-${process.arch}`)),
            );
            if (!entries.length) throw new Error("No declared managed source for the locked pnpm dependency");
            const entry = entries[0];
            if (
              isAbsolute(entry.destination) ||
              entry.destination.split(/[\\/]/).some((part) => !part || part === ".." || part === ".")
            )
              throw new Error("Invalid managed npm source path");
            return {
              delegate: {
                tarball: require("node:url").pathToFileURL(join(directory, entry.destination)).href,
                integrity: resolution.integrity,
              },
            };
          },
        },
      ]
    : [],
  hooks: {
    updateConfig(config) {
      const directory = realpathSync(__dirname);
      let root = directory;
      let incomplete;
      for (;;) {
        if (existsSync(join(root, "workbench/projects.toml"))) break;
        if (!incomplete && (existsSync(join(root, "workbench/config.toml")) || existsSync(join(root, ".workbench"))))
          incomplete = root;
        const parent = dirname(root);
        if (parent === root) {
          if (!incomplete) return config; // A standalone example has no Workbench integration.
          throw new Error(`Workbench pnpm storage: ${incomplete}: missing workbench/projects.toml`);
        }
        root = parent;
      }
      const distribution = [process.env.WORKBENCH_DISTRIBUTION_ROOT, root].find(
        (candidate) => candidate && existsSync(join(candidate, "languages/index.toml")),
      );
      if (!distribution) throw new Error("Workbench pnpm storage: could not locate the pinned distribution");
      let settings;
      try {
        settings = JSON.parse(
          execFileSync(process.execPath, [join(distribution, "bundle/main.cjs"), "pnpm-config", directory], {
            cwd: directory,
            env: { ...process.env, WORKBENCH_PROJECT_ROOT: root, WORKBENCH_DISTRIBUTION_ROOT: distribution },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      } catch (error) {
        throw new Error(`Workbench pnpm storage: ${error.stderr?.toString().trim() || error.message}`, {
          cause: error,
        });
      }
      if (settings.virtualStoreDir && config.nodeLinker && config.nodeLinker !== "isolated")
        throw new Error("Workbench external pnpm storage requires the isolated node linker");
      return Object.assign(config, settings);
    },
  },
};

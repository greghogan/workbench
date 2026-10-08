import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = JSON.parse(process.env.CACHE_TARGET ?? "{}");
const roots = target.paths ?? ["."];
const base = join(process.env.RUNNER_TEMP, "workbench-ci");
const data = join(base, "data");
const cache = join(base, "cache");
const variables = {
  WORKBENCH_DATA_HOME: data,
  WORKBENCH_CACHE_HOME: cache,
  WORKBENCH_STORAGE_ROOT: cache,
  WORKBENCH_STORAGE_EXTERNAL: "true",
  UV_CACHE_DIR: join(cache, "uv"),
  UV_PYTHON_INSTALL_DIR: join(data, "python"),
  GOMODCACHE: join(cache, "go-mod"),
  GOCACHE: join(cache, "go-build"),
  npm_config_cache: join(cache, "npm"),
  PIP_CACHE_DIR: join(cache, "pip"),
};
for (const path of [data, cache]) mkdirSync(path, { recursive: true });
for (const [key, value] of Object.entries(variables)) appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
const inputs = (files) =>
  roots.flatMap((root) =>
    files.flatMap((name) => {
      const path = join(root, name);
      return existsSync(path) ? [[path, readFileSync(path, "utf8")]] : [];
    }),
  );
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const platform = `${process.platform}-${process.arch}`;
const tools = hash([
  inputs([
    ".node-version",
    ".python-version",
    ".go-version",
    ".tool-versions",
    "rust-toolchain.toml",
    ".vcpkg-version",
  ]),
  readFileSync("scripts/native-assets.json", "utf8"),
  target.runtime === "python" ? target.version : undefined,
]);
const dependencies = hash([
  inputs([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "uv.lock",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "vcpkg-configuration.json",
    "vcpkg.json",
    "CMakeLists.txt",
  ]),
  inputs([".llvm-version", ".gcc-version", "rust-toolchain-miri.toml"]),
  target.environment ? inputs(["flake.nix", "flake.lock", "channels.scm", "manifest.scm"]) : undefined,
  readFileSync("workbench/projects.toml", "utf8"),
  tools,
  target.runtime,
  target.version,
  target.environment,
  inputs([".devcontainer/devcontainer.json", ".devcontainer/Dockerfile"]),
]);
const output = (key, value) =>
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<WORKBENCH_CACHE\n${value}\nWORKBENCH_CACHE\n`);
output("tools-key", `tools-v1-${platform}-${tools}`);
output(
  "tools-paths",
  [
    ...[
      "node",
      "go",
      "uv",
      "cmake",
      "ninja",
      "shellcheck",
      "shfmt",
      "actionlint",
      "vcpkg",
      "cargo-nextest",
      "cargo-llvm-cov",
    ].map((tool) => join(data, "toolchains", tool)),
    join(data, "python"),
  ].join("\n"),
);
output("dependencies-key", `dependencies-v1-${platform}-${dependencies}`);
output(
  "dependencies-paths",
  [
    ...["builds", "dependencies", "uv", "go-mod", "go-build", "npm", "pip"].map((name) => join(cache, name)),
    join(cache, "downloads", "pnpm"),
    join(homedir(), ".cargo", "registry"),
    join(homedir(), ".cargo", "git"),
  ].join("\n"),
);
if (target.runtime === "gcc") {
  const asset = JSON.parse(readFileSync("scripts/native-assets.json", "utf8")).gcc[target.version][platform];
  output(
    "gcc-key",
    `gcc-v1-${platform}-${target.version}-${hash([asset, readFileSync("src/tool-downloads.ts", "utf8")])}`,
  );
  output("gcc-path", join(data, "toolchains", "gcc"));
}
output("guix-key", `guix-source-v1-${platform}-${hash(inputs(["channels.scm"]))}`);
output("guix-paths", ["checkouts", "authentication"].map((name) => join(homedir(), ".cache", "guix", name)).join("\n"));

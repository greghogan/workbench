import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { cpuBudget } = (await import(
  pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href
)) as typeof import("../../../../scripts/cpu-budget.mjs");

const role = process.argv[2];
if (!role) throw new Error("Specify the PHP check role");
const source = process.cwd();
const build = resolve(process.env.WORKBENCH_BUILD_DIR ?? "build", "php");
const dependencies = resolve(process.env.WORKBENCH_DEPENDENCIES_DIR ?? "vendor", "php");

const compatibility = role.startsWith("compatibility-");
const toolRoot = compatibility ? "tools/compat" : "tools";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  COMPOSER_HOME: join(build, "composer-home"),
  COMPOSER_CACHE_DIR: process.env.WORKBENCH_COMPOSER_CACHE ?? join(build, "composer-downloads"),
  COMPOSER_MAX_PARALLEL_PROCESSES: String(cpuBudget()),
  COMPOSER_MAX_PARALLEL_HTTP: String(cpuBudget()),
  WORKBENCH_JOB_CPUS: String(cpuBudget()),
  WORKBENCH_PHPSTAN_CACHE: join(build, "phpstan"),
};
mkdirSync(build, { recursive: true });
function run(command: string, args: readonly string[], cwd = source, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...environment, ...extra }, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(`PHP ${String(role)} failed: ${String(result.error ?? result.status)}`);
}
function composer(root: string, args: string[]) {
  const destination = join(dependencies, root === "." ? "application" : root);
  run(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "php-package-manager-exec", "--", ...args],
    resolve(source, root),
    { COMPOSER_VENDOR_DIR: destination },
  );
}
function tool(name: string, args: string[]) {
  run("php", [join(dependencies, toolRoot, "bin", name), ...args]);
}
if (["type", "test", "compatibility-test", "coverage"].includes(role)) {
  const bootstrap = spawnSync(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "php-package-manager-exec", "--bootstrap-path"],
    { cwd: source, env: environment, encoding: "utf8" },
  );
  if (bootstrap.error || bootstrap.status !== 0)
    throw new Error(`Composer API bootstrap failed: ${bootstrap.error ?? bootstrap.stderr}`);
  environment.WORKBENCH_COMPOSER_PHAR = bootstrap.stdout.trim();
}
switch (role) {
  case "dependency-lock":
    environment.WORKBENCH_COMPOSER_RECORD_CHECKSUMS = "true";
    for (const root of [".", "tools", "tools/compat"]) {
      // Refresh in an owned, disposable install so every newly resolved archive crosses the verification hook.
      rmSync(join(dependencies, root === "." ? "application" : root), { recursive: true, force: true });
      composer(root, ["update", "--prefer-dist", "--no-interaction", "--no-progress"]);
      const manifest = resolve(source, root);
      const lock = JSON.parse(readFileSync(join(manifest, "composer.lock"), "utf8")) as {
        packages: { name: string; version: string; dist?: { type: string; reference?: string } }[];
        "packages-dev": { name: string; version: string; dist?: { type: string; reference?: string } }[];
      };
      const keys = new Set(
        [...lock.packages, ...lock["packages-dev"]]
          .filter((item) => item.dist?.type !== "path")
          .map((item) => `${item.name}@${item.version}#${item.dist?.reference ?? ""}`),
      );
      const file = join(manifest, ".composer/checksums.json");
      const checksums = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      for (const key of keys) if (!checksums[key]) throw new Error(`Missing refreshed distribution checksum: ${key}`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        file,
        `${JSON.stringify(
          Object.fromEntries(
            Object.entries(checksums)
              .filter(([key]) => keys.has(key))
              .sort(),
          ),
          null,
          2,
        )}\n`,
      );
    }
    break;
  case "setup":
  case "compatibility-setup":
    for (const root of [".", toolRoot]) {
      composer(root, ["validate", "--strict", "--no-check-publish"]);
      composer(root, ["install", "--prefer-dist", "--no-interaction", "--no-progress"]);
      composer(root, ["check-platform-reqs"]);
    }
    break;
  case "format":
  case "lint":
    tool("php-cs-fixer", [
      "check",
      "--config=.php-cs-fixer.dist.php",
      `--cache-file=${join(build, "php-cs-fixer.cache")}`,
      "--using-cache=yes",
    ]);
    break;
  case "format-write":
    tool("php-cs-fixer", [
      "fix",
      "--config=.php-cs-fixer.dist.php",
      `--cache-file=${join(build, "php-cs-fixer.cache")}`,
    ]);
    break;
  case "type": {
    environment.WORKBENCH_PHP_TOOLS_AUTOLOAD = join(dependencies, toolRoot, "autoload.php");
    tool("phpstan", ["analyse", "--configuration=phpstan.neon", "--no-progress"]);
    break;
  }
  case "test":
  case "compatibility-test":
    tool("paratest", [
      "--processes",
      String(cpuBudget()),
      "--configuration",
      compatibility ? "phpunit-compat.xml" : "phpunit.xml",
      "--cache-directory",
      join(build, compatibility ? "phpunit-compat" : "phpunit"),
    ]);
    break;
  case "coverage":
    run(process.execPath, [
      join(distribution, "bin/workbench.mjs"),
      "php-coverage-exec",
      "--",
      join(dependencies, toolRoot, "bin/paratest"),
      "--processes",
      String(cpuBudget()),
      "--cache-directory",
      join(build, "phpunit"),
      "--configuration",
      "phpunit.xml",
      "--coverage-php",
      join(build, "coverage.php"),
    ]);
    run("php", [
      join(distribution, "scripts/php-coverage.php"),
      join(build, "coverage.php"),
      source,
      join(dependencies, toolRoot, "autoload.php"),
    ]);
    break;
  case "build":
  case "release": {
    const output =
      role === "release"
        ? resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? process.env.WORKBENCH_DIST_DIR ?? "dist")
        : join(build, "package");
    mkdirSync(output, { recursive: true });
    const stage = join(build, "release-source");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage);
    for (const path of ["src", "bin", "README.md", "LICENSE", "composer.json"])
      cpSync(join(source, path), join(stage, path), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(join(stage, "composer.json"), "utf8")) as Record<string, unknown> & {
      config: Record<string, unknown>;
    };
    delete manifest["require-dev"];
    delete manifest.repositories;
    delete manifest.config["allow-plugins"];
    manifest.archive = { exclude: ["/.composer-version"] };
    writeFileSync(join(stage, "composer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    cpSync(join(source, ".composer-version"), join(stage, ".composer-version"));
    run(
      process.execPath,
      [
        join(distribution, "bin/workbench.mjs"),
        "php-package-manager-exec",
        "--",
        "archive",
        "--format=zip",
        `--dir=${output}`,
        "--file=workbench-php-reference",
        "--no-plugins",
      ],
      stage,
    );
    if (!existsSync(join(output, "workbench-php-reference.zip"))) throw new Error("PHP archive was not created");
    break;
  }
  default:
    throw new Error(`Unknown PHP check: ${role}`);
}

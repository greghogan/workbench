import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetFor } from "./native-assets.js";
import { readText } from "./core.js";
import { download, execute, extractArchive } from "./tool-downloads.js";
import { withCacheLock } from "./cache-lock.js";
import { userDirectory } from "./storage.js";
import { acquisitionIdentity } from "./artifact-policy.js";
import { cpuBudget } from "../scripts/cpu-budget.mjs";
import { required } from "./invariants.js";
import { exactVersion } from "./toolchains.js";

/** The extension cache belongs to the selected PHP executable and ABI, never merely the Xdebug release. */
export async function executePhpCoverage(directory: string, distribution: string, args: string[]): Promise<void> {
  if (process.platform !== "linux") throw new Error("Native PHP coverage is configured for Linux");
  const version = exactVersion(readText(join(directory, ".xdebug-version")).trim(), ".xdebug-version");
  const asset = required(
    assetFor(distribution, { name: "xdebug", version, source: ".xdebug-version" }),
    "missing verified Xdebug source",
  );
  const php = execute("php", ["-r", "echo PHP_BINARY;"], { capture: true }).trim();
  const configuration = execute(join(dirname(php), "php-config"), ["--configure-options"], { capture: true });
  const identity = createHash("sha256")
    .update(php)
    .update(configuration)
    .update(acquisitionIdentity(asset))
    .digest("hex");
  const destination = join(userDirectory("cache"), "toolchains", "xdebug", version, identity);
  await withCacheLock(destination, async () => {
    if (!existsSync(destination)) {
      const archive = await download(asset);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const stage = `${destination}.${randomUUID()}.partial`;
      mkdirSync(stage, { mode: 0o700 });
      try {
        const extracted = await extractArchive(archive, stage, asset);
        const source = join(extracted, `xdebug-${version}`);
        if (!existsSync(join(source, "config.m4"))) throw new Error("Xdebug source archive has an unexpected layout");
        execute(join(dirname(php), "phpize"), [], { cwd: source });
        execute(join(source, "configure"), [`--with-php-config=${join(dirname(php), "php-config")}`], { cwd: source });
        execute("make", [`-j${String(cpuBudget())}`], { cwd: source });
        const modules = join(source, "modules");
        if (!existsSync(join(modules, "xdebug.so"))) throw new Error("Xdebug build omitted its extension");
        writeFileSync(join(modules, ".workbench-extension"), identity);
        writeFileSync(join(modules, "xdebug.ini"), `zend_extension="${join(destination, "xdebug.so")}"\n`);
        renameSync(modules, destination);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    if (readText(join(destination, ".workbench-extension")) !== identity)
      throw new Error("incomplete Xdebug installation");
  });
  // Xdebug must filter before PHPUnit and Composer load; a late filter retains their branch graphs.
  const startup = mkdtempSync(join(dirname(destination), ".coverage-"));
  const filter = join(startup, "filter.php");
  const production = `${join(directory, "src")}/`.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  try {
    writeFileSync(
      filter,
      `<?php xdebug_set_filter(XDEBUG_FILTER_CODE_COVERAGE, XDEBUG_PATH_INCLUDE, ['${production}']);\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(startup, "startup.ini"), `auto_prepend_file="${filter}"\n`, { mode: 0o600 });
    execute(php, ["-d", "xdebug.mode=coverage", ...args], {
      cwd: directory,
      env: { ...process.env, PHP_INI_SCAN_DIR: `${destination}:${startup}`, XDEBUG_MODE: "coverage" },
    });
  } finally {
    rmSync(startup, { recursive: true, force: true });
  }
}

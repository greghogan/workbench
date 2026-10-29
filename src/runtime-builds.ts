import { environmentValue, platformEnvironmentNames, platformHostDirectories } from "./host-environment.js";
import { nativeHostRequirements } from "../scripts/native-host-requirements.mjs";
import { delimiter, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import { cpuBudget } from "../scripts/cpu-budget.mjs";
import type { execute } from "./tool-execution.js";

function hostPackagePrefix(pkg: string, run: typeof execute, env: NodeJS.ProcessEnv): string {
  const prefix = run("brew", ["--prefix", pkg], { env, capture: true }).trim();
  if (!isAbsolute(prefix)) throw new Error(`Invalid host package prefix for ${pkg}`);
  return prefix;
}

/** Host SDK discovery is deliberate; shell compiler, linker, and package-manager overrides are not build inputs. */
export function runtimeBuildEnvironment(
  run: typeof execute,
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of platformEnvironmentNames) {
    const value = environmentValue(source, name, platform);
    if (value !== undefined) env[name] = value;
  }
  env.PATH = platformHostDirectories(env, platform).join(delimiter);
  if (platform === "darwin") {
    env.PKG_CONFIG_PATH = nativeHostRequirements(["ruby", "php"], platform)
      .pkgConfigPackages.map((pkg) => join(hostPackagePrefix(pkg, run, env), "lib/pkgconfig"))
      .join(delimiter);
  }
  return env;
}

/** Upstream configure/make installs into a private image; only the completed image is activated. */
export function buildRuby(source: string, staging: string, destination: string, run: typeof execute): string {
  if (process.platform === "win32") throw new Error("Windows Ruby uses signed RubyInstaller binaries");
  const env = runtimeBuildEnvironment(run);
  const build = join(staging, "compile");
  const image = join(staging, "image");
  mkdirSync(build);
  run(
    join(source, "configure"),
    [
      `--prefix=${destination}`,
      "--disable-install-doc",
      "--disable-yjit",
      "--disable-zjit",
      "--with-ext=openssl,psych,+",
    ],
    { cwd: build, env },
  );
  run("make", [`-j${String(cpuBudget())}`], { cwd: build, env });
  run("make", ["install", `DESTDIR=${image}`], { cwd: build, env });
  return join(image, destination);
}

/** Compile PHP CLI with the extensions needed by Composer and the locked analysis/test tools. */
export function buildPhp(source: string, staging: string, destination: string, run: typeof execute): string {
  if (process.platform === "win32") throw new Error("Windows PHP uses native release ZIPs");
  const env = runtimeBuildEnvironment(run);
  const build = join(staging, "compile");
  const image = join(staging, "image");
  mkdirSync(build);
  run(
    join(source, "configure"),
    [
      `--prefix=${destination}`,
      "--disable-all",
      "--enable-cli",
      "--disable-cgi",
      "--disable-phpdbg",
      "--enable-tokenizer",
      "--enable-filter",
      "--enable-phar",
      "--enable-mbstring",
      "--enable-dom",
      "--enable-xml",
      "--enable-xmlwriter",
      "--enable-session",
      "--enable-ctype",
      "--enable-fileinfo",
      "--enable-simplexml",
      process.platform === "darwin" ? `--with-iconv=${hostPackagePrefix("libiconv", run, env)}` : "--with-iconv",
      "--disable-opcache-jit",
      "--with-openssl",
      "--with-zlib",
      "--with-libxml",
      "--with-curl",
    ],
    { cwd: build, env },
  );
  run("make", [`-j${String(cpuBudget())}`], { cwd: build, env });
  run("make", ["install", `INSTALL_ROOT=${image}`], { cwd: build, env });
  return join(image, destination);
}

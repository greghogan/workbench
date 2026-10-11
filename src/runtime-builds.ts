import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpuBudget } from "../scripts/cpu-budget.mjs";
import type { execute } from "./tool-downloads.js";

/** Upstream configure/make installs into a private image; only the completed image is activated. */
export function buildRuby(source: string, staging: string, destination: string, run: typeof execute): string {
  if (process.platform === "win32") throw new Error("Windows Ruby uses signed RubyInstaller binaries");
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
    { cwd: build },
  );
  run("make", [`-j${String(cpuBudget())}`], { cwd: build });
  run("make", ["install", `DESTDIR=${image}`], { cwd: build });
  return join(image, destination);
}

/** Compile PHP CLI with the extensions needed by Composer and the locked analysis/test tools. */
export function buildPhp(source: string, staging: string, destination: string, run: typeof execute): string {
  if (process.platform === "win32") throw new Error("Windows PHP uses native release ZIPs");
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
      process.platform === "darwin"
        ? `--with-iconv=${run("brew", ["--prefix", "libiconv"], { capture: true }).trim()}`
        : "--with-iconv",
      "--disable-opcache-jit",
      "--with-openssl",
      "--with-zlib",
      "--with-libxml",
      "--with-curl",
    ],
    { cwd: build },
  );
  run("make", [`-j${String(cpuBudget())}`], { cwd: build });
  run("make", ["install", `INSTALL_ROOT=${image}`], { cwd: build });
  return join(image, destination);
}

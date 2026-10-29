import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const markers = { rust: "rust-toolchain.toml", ruby: ".ruby-version", php: ".php-version", go: ".go-version" };
const packages = {
  linux: [
    "build-essential",
    "pkg-config",
    "libssl-dev",
    "libyaml-dev",
    "libffi-dev",
    "zlib1g-dev",
    "libxml2-dev",
    "libonig-dev",
    "libcurl4-openssl-dev",
    "autoconf",
  ],
  darwin: ["pkg-config", "openssl@3", "libyaml", "libffi", "oniguruma", "autoconf", "libxml2", "libiconv", "curl"],
  win32: ["mingw-w64-ucrt-x86_64-gcc", "mingw-w64-ucrt-x86_64-make", "make"],
};
const browserPackages = [
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libatk1.0-0t64",
  "libatk-bridge2.0-0t64",
  "libdbus-1-3",
  "libx11-6",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libexpat1",
  "libxcb1",
  "libxkbcommon0",
  "libudev1",
  "libasound2t64",
  "libatspi2.0-0t64",
  "fonts-liberation",
];

/** CI discovers the same language identities used by check environment construction. */
export function nativeHostLanguages(roots: readonly string[], runtime = ""): string[] {
  const languages = Object.entries(markers)
    .filter(
      ([language, marker]) =>
        roots.some((root) => existsSync(join(root, marker))) ||
        (["ruby", "php"].includes(language) && runtime === language),
    )
    .map(([language]) => language);
  if (
    roots.some((root) => {
      const path = join(root, ".tool-versions");
      return existsSync(path) && /^[\t ]*chromium-headless-shell[\t ]/m.test(readFileSync(path, "utf8"));
    })
  )
    languages.push("browser");
  return languages;
}

/** Internal host SDK requirements; selected language/tool pins remain their own authorities. */
export function nativeHostRequirements(languages: readonly string[], platform: NodeJS.Platform = process.platform) {
  const goCompiler = platform === "win32" && languages.includes("go");
  const buildTools = languages.some((language) => language === "ruby" || language === "php") || goCompiler;
  return {
    commands: goCompiler ? ["gcc"] : [],
    packages: [
      ...new Set([
        ...(buildTools && (platform === "linux" || platform === "darwin" || platform === "win32")
          ? packages[platform]
          : []),
        ...(platform === "linux" && languages.includes("browser") ? browserPackages : []),
      ]),
    ],
    pkgConfigPackages:
      buildTools && platform === "darwin" ? ["openssl@3", "libyaml", "libffi", "oniguruma", "libxml2", "curl"] : [],
    msvcLinker: platform === "win32" && languages.includes("rust"),
  };
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { expect, test } from "vitest";
import { standaloneTools } from "../src/toolchains.ts";
import { assetFor } from "../src/native-assets.ts";

const root = join(import.meta.dirname, "..");

test("the managed engine matches the browser revision supported by the locked Playwright driver", () => {
  const require = createRequire(import.meta.url);
  const browsers = JSON.parse(
    readFileSync(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"),
  ) as {
    browsers: { name: string; browserVersion: string }[];
  };
  const version = standaloneTools(root).get("chromium-headless-shell");
  if (!version) throw new Error("Missing Headless Shell pin");
  expect(version).toBe(browsers.browsers.find((browser) => browser.name === "chromium-headless-shell")?.browserVersion);
  for (const platform of ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"]) {
    const asset = assetFor(
      root,
      { name: "chromium-headless-shell", version, source: ".tool-versions" },
      root,
      platform,
    );
    expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(asset?.format).toBe("zip");
    expect(asset?.executable).toBe(`chrome-headless-shell${platform === "win32-x64" ? ".exe" : ""}`);
    expect(asset?.authenticationUnavailable?.source).toBe("https://github.com/GoogleChromeLabs/chrome-for-testing");
  }
});

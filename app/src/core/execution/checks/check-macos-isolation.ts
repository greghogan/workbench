import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { removeOwnedTree } from "../../runtime/owned-scratch.mjs";

const codesign = "/usr/bin/codesign";
const shell = "/bin/sh";
const appSandbox = "com.apple.security.app-sandbox";
const absolutePaths = "com.apple.security.temporary-exception.files.absolute-path";

function plistString(text: string): string {
  return "<string>" + text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "</string>";
}

function dictionary(values: Record<string, string>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    Object.entries(values)
      .map(([key, value]) => "<key>" + key + "</key>" + value)
      .join("") +
    "</dict></plist>\n"
  );
}

const plistPaths = (paths: readonly string[]) => "<array>" + [...new Set(paths)].map(plistString).join("") + "</array>";

/** The signed system shell passes the same App Sandbox permissions to the commands it starts. */
export function signCheckShell(parent: string, readOnly: readonly string[], writable: readonly string[]) {
  const name = "workbench-check-shell";
  const bundle = join(parent, "ScopedCheck.app");
  const contents = join(bundle, "Contents");
  const directory = join(contents, "MacOS");
  const executable = join(directory, name);
  const identifier = "org.workbench.scope." + randomUUID();
  const container = join(userInfo().homedir, "Library/Containers", identifier);
  if (lstatSync(container, { throwIfNoEntry: false })) throw new Error("The macOS scope container already exists");
  mkdirSync(directory, { recursive: true });
  copyFileSync(shell, executable);
  writeFileSync(
    join(contents, "Info.plist"),
    dictionary({
      CFBundleIdentifier: plistString(identifier),
      CFBundleName: plistString("Workbench Scoped Check"),
      CFBundleExecutable: plistString(name),
      CFBundlePackageType: plistString("APPL"),
    }),
  );
  const entitlements = join(parent, "scope.entitlements");
  writeFileSync(
    entitlements,
    dictionary({
      [appSandbox]: "<true/>",
      "com.apple.security.network.client": "<true/>",
      "com.apple.security.network.server": "<true/>",
      [absolutePaths + ".read-only"]: plistPaths(readOnly),
      [absolutePaths + ".read-write"]: plistPaths(writable),
    }),
    { mode: 0o600 },
  );
  for (const args of [
    ["--force", "--sign", "-", "--entitlements", entitlements, bundle],
    ["--verify", "--strict", bundle],
  ]) {
    const result = spawnSync(codesign, args, { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) throw new Error("Cannot sign the macOS scoped check launcher", { cause: result.error });
  }
  return {
    executable,
    release: () => {
      const info = lstatSync(container, { throwIfNoEntry: false });
      if (!info) return;
      if (!info.isDirectory() || info.uid !== process.getuid?.())
        throw new Error("The macOS scope container changed ownership");
      removeOwnedTree(container);
    },
  };
}

export const macosCheckTools = [shell, codesign] as const;

import { posix } from "node:path";

export function unsafeArchiveText(value: string): boolean {
  return (
    /[\\:]/.test(value) ||
    value.split("").some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function archivePath(path: string): string {
  if (!path || unsafeArchiveText(path) || path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`unsafe tool archive path: ${JSON.stringify(path)}`);
  const normalized = posix.normalize(path.replace(/^\.\//, "").replace(/\/$/, ""));
  if (!normalized || normalized === ".") throw new Error("unsafe empty tool archive path");
  if (
    process.platform === "win32" &&
    normalized
      .split("/")
      .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  )
    throw new Error("unsafe Windows tool archive path");
  return normalized;
}

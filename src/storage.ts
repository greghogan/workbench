import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** User-owned installations are durable data; downloads and build products are cache. */
export function userDirectory(kind: "config" | "data" | "cache"): string {
  const explicit = process.env[`WORKBENCH_${kind.toUpperCase()}_HOME`];
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error(`WORKBENCH_${kind.toUpperCase()}_HOME must be absolute`);
    return explicit;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local || !isAbsolute(local)) throw new Error("LOCALAPPDATA must identify the user's local data folder");
    return kind === "config" ? join(local, "workbench") : join(local, "workbench", kind);
  }
  if (process.platform === "darwin")
    return join(homedir(), "Library", kind === "cache" ? "Caches" : "Application Support", "workbench");
  const xdg = process.env[`XDG_${kind.toUpperCase()}_HOME`];
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), { config: ".config", cache: ".cache", data: ".local/share" }[kind]),
    "workbench",
  );
}

import { readdirSync, readFileSync } from "node:fs";

/** A persistent interpreter is needed inside Docker/manager namespaces, not just on the host PATH. */
export function profileRequiresBinfmt(architecture: string, directory = "/proc/sys/fs/binfmt_misc"): boolean {
  try {
    if (readFileSync(`${directory}/status`, "utf8").trim() !== "enabled") return true;
    const interpreter = architecture === "arm64" ? "aarch64" : "x86_64";
    return !readdirSync(directory).some((name) => {
      if (!name.includes(interpreter)) return false;
      const registration = readFileSync(`${directory}/${name}`, "utf8");
      return /^enabled$/m.test(registration) && /^flags:.*F/m.test(registration);
    });
  } catch {
    return true;
  }
}

import type { ToolAsset } from "./tool-downloads.js";

/** Package runtimes may require a newer libc than the compiler's version probe does. */
export function assertAssetHost(asset: ToolAsset, host?: { platform: NodeJS.Platform; glibc?: string }): void {
  if (asset.glibcMinimum === undefined) return;
  const version = (value: string) => {
    if (!/^\d+\.\d+$/.test(value)) return undefined;
    const parts = value.split(".");
    return { major: Number(parts[0]), minor: Number(parts[1]) };
  };
  const minimum = version(asset.glibcMinimum);
  if (!minimum) throw new Error("artifact glibc minimum must be a major.minor version");
  const platform = host?.platform ?? process.platform;
  const glibc = host
    ? host.glibc
    : (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
  const current = glibc === undefined ? undefined : version(glibc);
  if (
    platform !== "linux" ||
    !current ||
    !(current.major > minimum.major || (current.major === minimum.major && current.minor >= minimum.minor))
  )
    throw new Error(
      `${asset.url}: requires Linux with glibc >=${asset.glibcMinimum}; host is ${platform}, glibc ${glibc ?? "unavailable"}`,
    );
}

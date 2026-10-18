// Generated from ci-native-prerequisites.mts; edit the TypeScript source.
import { strings } from "./values.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
const roots = strings(JSON.parse(process.env.CHECK_ROOTS ?? "[]"), "Invalid check roots");
if (process.platform === "win32" && roots.some((root) => existsSync(join(root, "rust-toolchain.toml")))) {
  const sdk = process.env.VCToolsInstallDir;
  const linker = sdk && join(sdk, "bin", "Hostx64", "x64", "link.exe");
  if (!linker || !existsSync(linker)) throw new Error("Windows Rust checks require the MSVC SDK environment");
  if (process.env.GITHUB_ENV) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_ENV, `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=${linker}
`);
  }
}
const need = roots.some((root) => existsSync(join(root, ".ruby-version")) || existsSync(join(root, ".php-version"))) || ["ruby", "php"].includes(process.env.RUNTIME ?? "") || process.platform === "win32" && roots.some((root) => existsSync(join(root, ".go-version")));
if (!need) process.exit(0);
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${cmd} failed: ${String(r.status)}`);
}
if (process.platform === "linux") {
  run("sudo", ["apt-get", "update"]);
  run("sudo", [
    "apt-get",
    "install",
    "--no-install-recommends",
    "-y",
    "build-essential",
    "pkg-config",
    "libssl-dev",
    "libyaml-dev",
    "libffi-dev",
    "zlib1g-dev",
    "libxml2-dev",
    "libonig-dev",
    "libcurl4-openssl-dev",
    "autoconf"
  ]);
} else if (process.platform === "darwin") {
  run("brew", [
    "install",
    "pkg-config",
    "openssl@3",
    "libyaml",
    "libffi",
    "oniguruma",
    "autoconf",
    "libxml2",
    "libiconv",
    "curl"
  ]);
  const { appendFileSync } = await import("node:fs");
  if (process.env.GITHUB_ENV) {
    const packages = ["openssl@3", "libyaml", "libffi", "oniguruma", "libxml2", "curl"];
    const paths = packages.map(
      (pkg) => join(spawnSync("brew", ["--prefix", pkg], { encoding: "utf8" }).stdout.trim(), "lib/pkgconfig")
    );
    appendFileSync(process.env.GITHUB_ENV, `PKG_CONFIG_PATH=${paths.join(":")}:${process.env.PKG_CONFIG_PATH ?? ""}
`);
  }
} else if (process.platform === "win32") {
  const msys = "C:/msys64";
  run(join(msys, "usr/bin/bash.exe"), [
    "-lc",
    "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-make make"
  ]);
  if (process.env.GITHUB_PATH) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_PATH, `${msys}/ucrt64/bin
${msys}/usr/bin
`);
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLW5hdGl2ZS1wcmVyZXF1aXNpdGVzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzdHJpbmdzIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuY29uc3Qgcm9vdHMgPSBzdHJpbmdzKEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuQ0hFQ0tfUk9PVFMgPz8gXCJbXVwiKSwgXCJJbnZhbGlkIGNoZWNrIHJvb3RzXCIpO1xuLy8gR2l0IEJhc2ggYWxzbyBzdXBwbGllcyBsaW5rLmV4ZTsgUnVzdCBtdXN0IHNlbGVjdCB0aGUgZGVjbGFyZWQgTVNWQyBsaW5rZXIgZXhwbGljaXRseS5cbmlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgJiYgcm9vdHMuc29tZSgocm9vdDogc3RyaW5nKSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJydXN0LXRvb2xjaGFpbi50b21sXCIpKSkpIHtcbiAgY29uc3Qgc2RrID0gcHJvY2Vzcy5lbnYuVkNUb29sc0luc3RhbGxEaXI7XG4gIGNvbnN0IGxpbmtlciA9IHNkayAmJiBqb2luKHNkaywgXCJiaW5cIiwgXCJIb3N0eDY0XCIsIFwieDY0XCIsIFwibGluay5leGVcIik7XG4gIGlmICghbGlua2VyIHx8ICFleGlzdHNTeW5jKGxpbmtlcikpIHRocm93IG5ldyBFcnJvcihcIldpbmRvd3MgUnVzdCBjaGVja3MgcmVxdWlyZSB0aGUgTVNWQyBTREsgZW52aXJvbm1lbnRcIik7XG4gIGlmIChwcm9jZXNzLmVudi5HSVRIVUJfRU5WKSB7XG4gICAgY29uc3QgeyBhcHBlbmRGaWxlU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTtcbiAgICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfRU5WLCBgQ0FSR09fVEFSR0VUX1g4Nl82NF9QQ19XSU5ET1dTX01TVkNfTElOS0VSPSR7bGlua2VyfVxcbmApO1xuICB9XG59XG5jb25zdCBuZWVkID1cbiAgcm9vdHMuc29tZSgocm9vdDogc3RyaW5nKSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCIucnVieS12ZXJzaW9uXCIpKSB8fCBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCIucGhwLXZlcnNpb25cIikpKSB8fFxuICBbXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKHByb2Nlc3MuZW52LlJVTlRJTUUgPz8gXCJcIikgfHxcbiAgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiByb290cy5zb21lKChyb290KSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCIuZ28tdmVyc2lvblwiKSkpKTtcbmlmICghbmVlZCkgcHJvY2Vzcy5leGl0KDApO1xuZnVuY3Rpb24gcnVuKGNtZDogc3RyaW5nLCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSkge1xuICBjb25zdCByID0gc3Bhd25TeW5jKGNtZCwgYXJncywgeyBzdGRpbzogXCJpbmhlcml0XCIgfSk7XG4gIGlmIChyLmVycm9yIHx8IHIuc3RhdHVzICE9PSAwKSB0aHJvdyByLmVycm9yID8/IG5ldyBFcnJvcihgJHtjbWR9IGZhaWxlZDogJHtTdHJpbmcoci5zdGF0dXMpfWApO1xufVxuaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwibGludXhcIikge1xuICBydW4oXCJzdWRvXCIsIFtcImFwdC1nZXRcIiwgXCJ1cGRhdGVcIl0pO1xuICBydW4oXCJzdWRvXCIsIFtcbiAgICBcImFwdC1nZXRcIixcbiAgICBcImluc3RhbGxcIixcbiAgICBcIi0tbm8taW5zdGFsbC1yZWNvbW1lbmRzXCIsXG4gICAgXCIteVwiLFxuICAgIFwiYnVpbGQtZXNzZW50aWFsXCIsXG4gICAgXCJwa2ctY29uZmlnXCIsXG4gICAgXCJsaWJzc2wtZGV2XCIsXG4gICAgXCJsaWJ5YW1sLWRldlwiLFxuICAgIFwibGliZmZpLWRldlwiLFxuICAgIFwiemxpYjFnLWRldlwiLFxuICAgIFwibGlieG1sMi1kZXZcIixcbiAgICBcImxpYm9uaWctZGV2XCIsXG4gICAgXCJsaWJjdXJsNC1vcGVuc3NsLWRldlwiLFxuICAgIFwiYXV0b2NvbmZcIixcbiAgXSk7XG59IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHtcbiAgcnVuKFwiYnJld1wiLCBbXG4gICAgXCJpbnN0YWxsXCIsXG4gICAgXCJwa2ctY29uZmlnXCIsXG4gICAgXCJvcGVuc3NsQDNcIixcbiAgICBcImxpYnlhbWxcIixcbiAgICBcImxpYmZmaVwiLFxuICAgIFwib25pZ3VydW1hXCIsXG4gICAgXCJhdXRvY29uZlwiLFxuICAgIFwibGlieG1sMlwiLFxuICAgIFwibGliaWNvbnZcIixcbiAgICBcImN1cmxcIixcbiAgXSk7XG4gIGNvbnN0IHsgYXBwZW5kRmlsZVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gIGlmIChwcm9jZXNzLmVudi5HSVRIVUJfRU5WKSB7XG4gICAgY29uc3QgcGFja2FnZXMgPSBbXCJvcGVuc3NsQDNcIiwgXCJsaWJ5YW1sXCIsIFwibGliZmZpXCIsIFwib25pZ3VydW1hXCIsIFwibGlieG1sMlwiLCBcImN1cmxcIl07XG4gICAgY29uc3QgcGF0aHMgPSBwYWNrYWdlcy5tYXAoKHBrZykgPT5cbiAgICAgIGpvaW4oc3Bhd25TeW5jKFwiYnJld1wiLCBbXCItLXByZWZpeFwiLCBwa2ddLCB7IGVuY29kaW5nOiBcInV0ZjhcIiB9KS5zdGRvdXQudHJpbSgpLCBcImxpYi9wa2djb25maWdcIiksXG4gICAgKTtcbiAgICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfRU5WLCBgUEtHX0NPTkZJR19QQVRIPSR7cGF0aHMuam9pbihcIjpcIil9OiR7cHJvY2Vzcy5lbnYuUEtHX0NPTkZJR19QQVRIID8/IFwiXCJ9XFxuYCk7XG4gIH1cbn0gZWxzZSBpZiAocHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiKSB7XG4gIGNvbnN0IG1zeXMgPSBcIkM6L21zeXM2NFwiO1xuICBydW4oam9pbihtc3lzLCBcInVzci9iaW4vYmFzaC5leGVcIiksIFtcbiAgICBcIi1sY1wiLFxuICAgIFwicGFjbWFuIC1TIC0tbmVlZGVkIC0tbm9jb25maXJtIG1pbmd3LXc2NC11Y3J0LXg4Nl82NC1nY2MgbWluZ3ctdzY0LXVjcnQteDg2XzY0LW1ha2UgbWFrZVwiLFxuICBdKTtcbiAgaWYgKHByb2Nlc3MuZW52LkdJVEhVQl9QQVRIKSB7XG4gICAgY29uc3QgeyBhcHBlbmRGaWxlU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTtcbiAgICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfUEFUSCwgYCR7bXN5c30vdWNydDY0L2JpblxcbiR7bXN5c30vdXNyL2JpblxcbmApO1xuICB9XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxTQUFTLGVBQWU7QUFDeEIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLE1BQU0sUUFBUSxRQUFRLEtBQUssTUFBTSxRQUFRLElBQUksZUFBZSxJQUFJLEdBQUcscUJBQXFCO0FBRXhGLElBQUksUUFBUSxhQUFhLFdBQVcsTUFBTSxLQUFLLENBQUMsU0FBaUIsV0FBVyxLQUFLLE1BQU0scUJBQXFCLENBQUMsQ0FBQyxHQUFHO0FBQy9HLFFBQU0sTUFBTSxRQUFRLElBQUk7QUFDeEIsUUFBTSxTQUFTLE9BQU8sS0FBSyxLQUFLLE9BQU8sV0FBVyxPQUFPLFVBQVU7QUFDbkUsTUFBSSxDQUFDLFVBQVUsQ0FBQyxXQUFXLE1BQU0sRUFBRyxPQUFNLElBQUksTUFBTSxzREFBc0Q7QUFDMUcsTUFBSSxRQUFRLElBQUksWUFBWTtBQUMxQixVQUFNLEVBQUUsZUFBZSxJQUFJLE1BQU0sT0FBTyxTQUFTO0FBQ2pELG1CQUFlLFFBQVEsSUFBSSxZQUFZLDhDQUE4QyxNQUFNO0FBQUEsQ0FBSTtBQUFBLEVBQ2pHO0FBQ0Y7QUFDQSxNQUFNLE9BQ0osTUFBTSxLQUFLLENBQUMsU0FBaUIsV0FBVyxLQUFLLE1BQU0sZUFBZSxDQUFDLEtBQUssV0FBVyxLQUFLLE1BQU0sY0FBYyxDQUFDLENBQUMsS0FDOUcsQ0FBQyxRQUFRLEtBQUssRUFBRSxTQUFTLFFBQVEsSUFBSSxXQUFXLEVBQUUsS0FDakQsUUFBUSxhQUFhLFdBQVcsTUFBTSxLQUFLLENBQUMsU0FBUyxXQUFXLEtBQUssTUFBTSxhQUFhLENBQUMsQ0FBQztBQUM3RixJQUFJLENBQUMsS0FBTSxTQUFRLEtBQUssQ0FBQztBQUN6QixTQUFTLElBQUksS0FBYSxNQUF5QjtBQUNqRCxRQUFNLElBQUksVUFBVSxLQUFLLE1BQU0sRUFBRSxPQUFPLFVBQVUsQ0FBQztBQUNuRCxNQUFJLEVBQUUsU0FBUyxFQUFFLFdBQVcsRUFBRyxPQUFNLEVBQUUsU0FBUyxJQUFJLE1BQU0sR0FBRyxHQUFHLFlBQVksT0FBTyxFQUFFLE1BQU0sQ0FBQyxFQUFFO0FBQ2hHO0FBQ0EsSUFBSSxRQUFRLGFBQWEsU0FBUztBQUNoQyxNQUFJLFFBQVEsQ0FBQyxXQUFXLFFBQVEsQ0FBQztBQUNqQyxNQUFJLFFBQVE7QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsQ0FBQztBQUNILFdBQVcsUUFBUSxhQUFhLFVBQVU7QUFDeEMsTUFBSSxRQUFRO0FBQUEsSUFDVjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sRUFBRSxlQUFlLElBQUksTUFBTSxPQUFPLFNBQVM7QUFDakQsTUFBSSxRQUFRLElBQUksWUFBWTtBQUMxQixVQUFNLFdBQVcsQ0FBQyxhQUFhLFdBQVcsVUFBVSxhQUFhLFdBQVcsTUFBTTtBQUNsRixVQUFNLFFBQVEsU0FBUztBQUFBLE1BQUksQ0FBQyxRQUMxQixLQUFLLFVBQVUsUUFBUSxDQUFDLFlBQVksR0FBRyxHQUFHLEVBQUUsVUFBVSxPQUFPLENBQUMsRUFBRSxPQUFPLEtBQUssR0FBRyxlQUFlO0FBQUEsSUFDaEc7QUFDQSxtQkFBZSxRQUFRLElBQUksWUFBWSxtQkFBbUIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxJQUFJLFFBQVEsSUFBSSxtQkFBbUIsRUFBRTtBQUFBLENBQUk7QUFBQSxFQUNwSDtBQUNGLFdBQVcsUUFBUSxhQUFhLFNBQVM7QUFDdkMsUUFBTSxPQUFPO0FBQ2IsTUFBSSxLQUFLLE1BQU0sa0JBQWtCLEdBQUc7QUFBQSxJQUNsQztBQUFBLElBQ0E7QUFBQSxFQUNGLENBQUM7QUFDRCxNQUFJLFFBQVEsSUFBSSxhQUFhO0FBQzNCLFVBQU0sRUFBRSxlQUFlLElBQUksTUFBTSxPQUFPLFNBQVM7QUFDakQsbUJBQWUsUUFBUSxJQUFJLGFBQWEsR0FBRyxJQUFJO0FBQUEsRUFBZ0IsSUFBSTtBQUFBLENBQVk7QUFBQSxFQUNqRjtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvY2ktbmF0aXZlLXByZXJlcXVpc2l0ZXMubWpzIn0=

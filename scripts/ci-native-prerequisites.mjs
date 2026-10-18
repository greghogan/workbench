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
const need = roots.some((root) => existsSync(join(root, ".ruby-version")) || existsSync(join(root, ".php-version"))) || ["ruby", "php"].includes(process.env.RUNTIME ?? "");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNpLW5hdGl2ZS1wcmVyZXF1aXNpdGVzLm10cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBzdHJpbmdzIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuY29uc3Qgcm9vdHMgPSBzdHJpbmdzKEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuQ0hFQ0tfUk9PVFMgPz8gXCJbXVwiKSwgXCJJbnZhbGlkIGNoZWNrIHJvb3RzXCIpO1xuLy8gR2l0IEJhc2ggYWxzbyBzdXBwbGllcyBsaW5rLmV4ZTsgUnVzdCBtdXN0IHNlbGVjdCB0aGUgZGVjbGFyZWQgTVNWQyBsaW5rZXIgZXhwbGljaXRseS5cbmlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgJiYgcm9vdHMuc29tZSgocm9vdDogc3RyaW5nKSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCJydXN0LXRvb2xjaGFpbi50b21sXCIpKSkpIHtcbiAgY29uc3Qgc2RrID0gcHJvY2Vzcy5lbnYuVkNUb29sc0luc3RhbGxEaXI7XG4gIGNvbnN0IGxpbmtlciA9IHNkayAmJiBqb2luKHNkaywgXCJiaW5cIiwgXCJIb3N0eDY0XCIsIFwieDY0XCIsIFwibGluay5leGVcIik7XG4gIGlmICghbGlua2VyIHx8ICFleGlzdHNTeW5jKGxpbmtlcikpIHRocm93IG5ldyBFcnJvcihcIldpbmRvd3MgUnVzdCBjaGVja3MgcmVxdWlyZSB0aGUgTVNWQyBTREsgZW52aXJvbm1lbnRcIik7XG4gIGlmIChwcm9jZXNzLmVudi5HSVRIVUJfRU5WKSB7XG4gICAgY29uc3QgeyBhcHBlbmRGaWxlU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTtcbiAgICBhcHBlbmRGaWxlU3luYyhwcm9jZXNzLmVudi5HSVRIVUJfRU5WLCBgQ0FSR09fVEFSR0VUX1g4Nl82NF9QQ19XSU5ET1dTX01TVkNfTElOS0VSPSR7bGlua2VyfVxcbmApO1xuICB9XG59XG5jb25zdCBuZWVkID1cbiAgcm9vdHMuc29tZSgocm9vdDogc3RyaW5nKSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCIucnVieS12ZXJzaW9uXCIpKSB8fCBleGlzdHNTeW5jKGpvaW4ocm9vdCwgXCIucGhwLXZlcnNpb25cIikpKSB8fFxuICBbXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKHByb2Nlc3MuZW52LlJVTlRJTUUgPz8gXCJcIik7XG5pZiAoIW5lZWQpIHByb2Nlc3MuZXhpdCgwKTtcbmZ1bmN0aW9uIHJ1bihjbWQ6IHN0cmluZywgYXJnczogcmVhZG9ubHkgc3RyaW5nW10pIHtcbiAgY29uc3QgciA9IHNwYXduU3luYyhjbWQsIGFyZ3MsIHsgc3RkaW86IFwiaW5oZXJpdFwiIH0pO1xuICBpZiAoci5lcnJvciB8fCByLnN0YXR1cyAhPT0gMCkgdGhyb3cgci5lcnJvciA/PyBuZXcgRXJyb3IoYCR7Y21kfSBmYWlsZWQ6ICR7U3RyaW5nKHIuc3RhdHVzKX1gKTtcbn1cbmlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcImxpbnV4XCIpIHtcbiAgcnVuKFwic3Vkb1wiLCBbXCJhcHQtZ2V0XCIsIFwidXBkYXRlXCJdKTtcbiAgcnVuKFwic3Vkb1wiLCBbXG4gICAgXCJhcHQtZ2V0XCIsXG4gICAgXCJpbnN0YWxsXCIsXG4gICAgXCItLW5vLWluc3RhbGwtcmVjb21tZW5kc1wiLFxuICAgIFwiLXlcIixcbiAgICBcImJ1aWxkLWVzc2VudGlhbFwiLFxuICAgIFwicGtnLWNvbmZpZ1wiLFxuICAgIFwibGlic3NsLWRldlwiLFxuICAgIFwibGlieWFtbC1kZXZcIixcbiAgICBcImxpYmZmaS1kZXZcIixcbiAgICBcInpsaWIxZy1kZXZcIixcbiAgICBcImxpYnhtbDItZGV2XCIsXG4gICAgXCJsaWJvbmlnLWRldlwiLFxuICAgIFwibGliY3VybDQtb3BlbnNzbC1kZXZcIixcbiAgICBcImF1dG9jb25mXCIsXG4gIF0pO1xufSBlbHNlIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiKSB7XG4gIHJ1bihcImJyZXdcIiwgW1xuICAgIFwiaW5zdGFsbFwiLFxuICAgIFwicGtnLWNvbmZpZ1wiLFxuICAgIFwib3BlbnNzbEAzXCIsXG4gICAgXCJsaWJ5YW1sXCIsXG4gICAgXCJsaWJmZmlcIixcbiAgICBcIm9uaWd1cnVtYVwiLFxuICAgIFwiYXV0b2NvbmZcIixcbiAgICBcImxpYnhtbDJcIixcbiAgICBcImxpYmljb252XCIsXG4gICAgXCJjdXJsXCIsXG4gIF0pO1xuICBjb25zdCB7IGFwcGVuZEZpbGVTeW5jIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOmZzXCIpO1xuICBpZiAocHJvY2Vzcy5lbnYuR0lUSFVCX0VOVikge1xuICAgIGNvbnN0IHBhY2thZ2VzID0gW1wib3BlbnNzbEAzXCIsIFwibGlieWFtbFwiLCBcImxpYmZmaVwiLCBcIm9uaWd1cnVtYVwiLCBcImxpYnhtbDJcIiwgXCJjdXJsXCJdO1xuICAgIGNvbnN0IHBhdGhzID0gcGFja2FnZXMubWFwKChwa2cpID0+XG4gICAgICBqb2luKHNwYXduU3luYyhcImJyZXdcIiwgW1wiLS1wcmVmaXhcIiwgcGtnXSwgeyBlbmNvZGluZzogXCJ1dGY4XCIgfSkuc3Rkb3V0LnRyaW0oKSwgXCJsaWIvcGtnY29uZmlnXCIpLFxuICAgICk7XG4gICAgYXBwZW5kRmlsZVN5bmMocHJvY2Vzcy5lbnYuR0lUSFVCX0VOViwgYFBLR19DT05GSUdfUEFUSD0ke3BhdGhzLmpvaW4oXCI6XCIpfToke3Byb2Nlc3MuZW52LlBLR19DT05GSUdfUEFUSCA/PyBcIlwifVxcbmApO1xuICB9XG59IGVsc2UgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuICBjb25zdCBtc3lzID0gXCJDOi9tc3lzNjRcIjtcbiAgcnVuKGpvaW4obXN5cywgXCJ1c3IvYmluL2Jhc2guZXhlXCIpLCBbXG4gICAgXCItbGNcIixcbiAgICBcInBhY21hbiAtUyAtLW5lZWRlZCAtLW5vY29uZmlybSBtaW5ndy13NjQtdWNydC14ODZfNjQtZ2NjIG1pbmd3LXc2NC11Y3J0LXg4Nl82NC1tYWtlIG1ha2VcIixcbiAgXSk7XG4gIGlmIChwcm9jZXNzLmVudi5HSVRIVUJfUEFUSCkge1xuICAgIGNvbnN0IHsgYXBwZW5kRmlsZVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gICAgYXBwZW5kRmlsZVN5bmMocHJvY2Vzcy5lbnYuR0lUSFVCX1BBVEgsIGAke21zeXN9L3VjcnQ2NC9iaW5cXG4ke21zeXN9L3Vzci9iaW5cXG5gKTtcbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWTtBQUNyQixNQUFNLFFBQVEsUUFBUSxLQUFLLE1BQU0sUUFBUSxJQUFJLGVBQWUsSUFBSSxHQUFHLHFCQUFxQjtBQUV4RixJQUFJLFFBQVEsYUFBYSxXQUFXLE1BQU0sS0FBSyxDQUFDLFNBQWlCLFdBQVcsS0FBSyxNQUFNLHFCQUFxQixDQUFDLENBQUMsR0FBRztBQUMvRyxRQUFNLE1BQU0sUUFBUSxJQUFJO0FBQ3hCLFFBQU0sU0FBUyxPQUFPLEtBQUssS0FBSyxPQUFPLFdBQVcsT0FBTyxVQUFVO0FBQ25FLE1BQUksQ0FBQyxVQUFVLENBQUMsV0FBVyxNQUFNLEVBQUcsT0FBTSxJQUFJLE1BQU0sc0RBQXNEO0FBQzFHLE1BQUksUUFBUSxJQUFJLFlBQVk7QUFDMUIsVUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sU0FBUztBQUNqRCxtQkFBZSxRQUFRLElBQUksWUFBWSw4Q0FBOEMsTUFBTTtBQUFBLENBQUk7QUFBQSxFQUNqRztBQUNGO0FBQ0EsTUFBTSxPQUNKLE1BQU0sS0FBSyxDQUFDLFNBQWlCLFdBQVcsS0FBSyxNQUFNLGVBQWUsQ0FBQyxLQUFLLFdBQVcsS0FBSyxNQUFNLGNBQWMsQ0FBQyxDQUFDLEtBQzlHLENBQUMsUUFBUSxLQUFLLEVBQUUsU0FBUyxRQUFRLElBQUksV0FBVyxFQUFFO0FBQ3BELElBQUksQ0FBQyxLQUFNLFNBQVEsS0FBSyxDQUFDO0FBQ3pCLFNBQVMsSUFBSSxLQUFhLE1BQXlCO0FBQ2pELFFBQU0sSUFBSSxVQUFVLEtBQUssTUFBTSxFQUFFLE9BQU8sVUFBVSxDQUFDO0FBQ25ELE1BQUksRUFBRSxTQUFTLEVBQUUsV0FBVyxFQUFHLE9BQU0sRUFBRSxTQUFTLElBQUksTUFBTSxHQUFHLEdBQUcsWUFBWSxPQUFPLEVBQUUsTUFBTSxDQUFDLEVBQUU7QUFDaEc7QUFDQSxJQUFJLFFBQVEsYUFBYSxTQUFTO0FBQ2hDLE1BQUksUUFBUSxDQUFDLFdBQVcsUUFBUSxDQUFDO0FBQ2pDLE1BQUksUUFBUTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBQ0gsV0FBVyxRQUFRLGFBQWEsVUFBVTtBQUN4QyxNQUFJLFFBQVE7QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sU0FBUztBQUNqRCxNQUFJLFFBQVEsSUFBSSxZQUFZO0FBQzFCLFVBQU0sV0FBVyxDQUFDLGFBQWEsV0FBVyxVQUFVLGFBQWEsV0FBVyxNQUFNO0FBQ2xGLFVBQU0sUUFBUSxTQUFTO0FBQUEsTUFBSSxDQUFDLFFBQzFCLEtBQUssVUFBVSxRQUFRLENBQUMsWUFBWSxHQUFHLEdBQUcsRUFBRSxVQUFVLE9BQU8sQ0FBQyxFQUFFLE9BQU8sS0FBSyxHQUFHLGVBQWU7QUFBQSxJQUNoRztBQUNBLG1CQUFlLFFBQVEsSUFBSSxZQUFZLG1CQUFtQixNQUFNLEtBQUssR0FBRyxDQUFDLElBQUksUUFBUSxJQUFJLG1CQUFtQixFQUFFO0FBQUEsQ0FBSTtBQUFBLEVBQ3BIO0FBQ0YsV0FBVyxRQUFRLGFBQWEsU0FBUztBQUN2QyxRQUFNLE9BQU87QUFDYixNQUFJLEtBQUssTUFBTSxrQkFBa0IsR0FBRztBQUFBLElBQ2xDO0FBQUEsSUFDQTtBQUFBLEVBQ0YsQ0FBQztBQUNELE1BQUksUUFBUSxJQUFJLGFBQWE7QUFDM0IsVUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sU0FBUztBQUNqRCxtQkFBZSxRQUFRLElBQUksYUFBYSxHQUFHLElBQUk7QUFBQSxFQUFnQixJQUFJO0FBQUEsQ0FBWTtBQUFBLEVBQ2pGO0FBQ0Y7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9jaS1uYXRpdmUtcHJlcmVxdWlzaXRlcy5tanMifQ==

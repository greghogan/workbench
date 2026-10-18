// Generated from build-tooling.mts; edit the TypeScript source.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { format, resolveConfig } from "prettier";
async function buildTooling(root, check = false) {
  const emit = async (source, standalone = false) => {
    const reference = relative(root, source).split("\\").join("/").startsWith("examples/");
    const commonjs = source.endsWith(".cts");
    const destination = source.slice(0, -4) + (commonjs ? ".cjs" : ".mjs");
    const contents = readFileSync(source, "utf8");
    const banner = `// Generated from ${basename(source)}; edit the TypeScript source.`;
    let code;
    if (standalone) {
      const result = await build({
        entryPoints: [source],
        outfile: destination,
        bundle: true,
        packages: "external",
        platform: "node",
        target: "es2022",
        format: "esm",
        sourcemap: "inline",
        sourcesContent: true,
        banner: { js: banner },
        write: false
      });
      const output = result.outputFiles[0];
      if (!output) throw new Error(`${source}: fixture compilation produced no output`);
      code = output.text;
    } else {
      const result = await transform(contents, {
        loader: "ts",
        target: "es2022",
        format: commonjs ? "cjs" : "esm",
        sourcefile: basename(source),
        // Formatting reference JavaScript would invalidate the original emission map.
        sourcemap: reference ? false : "inline",
        sourcesContent: true,
        banner
      });
      code = result.code;
    }
    if (reference) code = await format(code, { ...await resolveConfig(destination), filepath: destination });
    code = code.replace(
      /(sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,)([^\s]+)/,
      (_, prefix, encoded) => {
        const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        map.file = relative(root, destination).split("\\").join("/");
        return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
      }
    );
    if (check) {
      if (!existsSync(destination) || readFileSync(destination, "utf8") !== code)
        throw new Error(`${relative(root, destination)} is stale; run pnpm run tooling:build`);
      if (process.platform !== "win32" && (statSync(source).mode & 73) !== (statSync(destination).mode & 73))
        throw new Error(`${relative(root, destination)} has stale executable permissions; run pnpm run tooling:build`);
    } else {
      writeFileSync(destination, code);
      chmodSync(destination, statSync(source).mode & 511);
    }
  };
  const skipped = /* @__PURE__ */ new Set([
    "node_modules",
    "vendor",
    "target",
    "build",
    "dist",
    "coverage",
    ".venv",
    ".direnv",
    ".git"
  ]);
  const visit = async (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(directory, entry.name);
      if (entry.isDirectory() && !skipped.has(entry.name)) await visit(source);
      else if (entry.isFile() && /\.[mc]ts$/.test(entry.name) && !/\.d\.[mc]ts$/.test(entry.name)) await emit(source);
    }
  };
  for (const directory of ["scripts", "examples", "bin"]) await visit(join(root, directory));
  for (const name of ["vitest.config.mts", "eslint.config.mts"])
    if (existsSync(join(root, name))) await emit(join(root, name));
  for (const name of ["ci-docker", "ci-workbench"]) await emit(join(root, `tests/fixtures/${name}.mts`), true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildTooling(resolve(import.meta.dirname, ".."), process.argv.includes("--check"));
export {
  buildTooling
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJ1aWxkLXRvb2xpbmcubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNobW9kU3luYywgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgYnVpbGQsIHRyYW5zZm9ybSB9IGZyb20gXCJlc2J1aWxkXCI7XG5pbXBvcnQgeyBmb3JtYXQsIHJlc29sdmVDb25maWcgfSBmcm9tIFwicHJldHRpZXJcIjtcbmltcG9ydCB0eXBlIHsgQ292ZXJhZ2VTb3VyY2VNYXAgfSBmcm9tIFwiLi9ub2RlLWNvdmVyYWdlLXJlcG9ydHMubWpzXCI7XG5cbi8qKiBLZWVwIGNvcGllZCByZWZlcmVuY2UgaGVscGVycyBhbmQgaW5zdGFsbGVkIHBhY2thZ2VzIGV4ZWN1dGFibGUgd2l0aCBvcmRpbmFyeSBOb2RlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkVG9vbGluZyhyb290OiBzdHJpbmcsIGNoZWNrID0gZmFsc2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZW1pdCA9IGFzeW5jIChzb3VyY2U6IHN0cmluZywgc3RhbmRhbG9uZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3QgcmVmZXJlbmNlID0gcmVsYXRpdmUocm9vdCwgc291cmNlKS5zcGxpdChcIlxcXFxcIikuam9pbihcIi9cIikuc3RhcnRzV2l0aChcImV4YW1wbGVzL1wiKTtcbiAgICBjb25zdCBjb21tb25qcyA9IHNvdXJjZS5lbmRzV2l0aChcIi5jdHNcIik7XG4gICAgY29uc3QgZGVzdGluYXRpb24gPSBzb3VyY2Uuc2xpY2UoMCwgLTQpICsgKGNvbW1vbmpzID8gXCIuY2pzXCIgOiBcIi5tanNcIik7XG4gICAgY29uc3QgY29udGVudHMgPSByZWFkRmlsZVN5bmMoc291cmNlLCBcInV0ZjhcIik7XG4gICAgY29uc3QgYmFubmVyID0gYC8vIEdlbmVyYXRlZCBmcm9tICR7YmFzZW5hbWUoc291cmNlKX07IGVkaXQgdGhlIFR5cGVTY3JpcHQgc291cmNlLmA7XG4gICAgbGV0IGNvZGU6IHN0cmluZztcbiAgICBpZiAoc3RhbmRhbG9uZSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYnVpbGQoe1xuICAgICAgICBlbnRyeVBvaW50czogW3NvdXJjZV0sXG4gICAgICAgIG91dGZpbGU6IGRlc3RpbmF0aW9uLFxuICAgICAgICBidW5kbGU6IHRydWUsXG4gICAgICAgIHBhY2thZ2VzOiBcImV4dGVybmFsXCIsXG4gICAgICAgIHBsYXRmb3JtOiBcIm5vZGVcIixcbiAgICAgICAgdGFyZ2V0OiBcImVzMjAyMlwiLFxuICAgICAgICBmb3JtYXQ6IFwiZXNtXCIsXG4gICAgICAgIHNvdXJjZW1hcDogXCJpbmxpbmVcIixcbiAgICAgICAgc291cmNlc0NvbnRlbnQ6IHRydWUsXG4gICAgICAgIGJhbm5lcjogeyBqczogYmFubmVyIH0sXG4gICAgICAgIHdyaXRlOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgb3V0cHV0ID0gcmVzdWx0Lm91dHB1dEZpbGVzWzBdO1xuICAgICAgaWYgKCFvdXRwdXQpIHRocm93IG5ldyBFcnJvcihgJHtzb3VyY2V9OiBmaXh0dXJlIGNvbXBpbGF0aW9uIHByb2R1Y2VkIG5vIG91dHB1dGApO1xuICAgICAgY29kZSA9IG91dHB1dC50ZXh0O1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0cmFuc2Zvcm0oY29udGVudHMsIHtcbiAgICAgICAgbG9hZGVyOiBcInRzXCIsXG4gICAgICAgIHRhcmdldDogXCJlczIwMjJcIixcbiAgICAgICAgZm9ybWF0OiBjb21tb25qcyA/IFwiY2pzXCIgOiBcImVzbVwiLFxuICAgICAgICBzb3VyY2VmaWxlOiBiYXNlbmFtZShzb3VyY2UpLFxuICAgICAgICAvLyBGb3JtYXR0aW5nIHJlZmVyZW5jZSBKYXZhU2NyaXB0IHdvdWxkIGludmFsaWRhdGUgdGhlIG9yaWdpbmFsIGVtaXNzaW9uIG1hcC5cbiAgICAgICAgc291cmNlbWFwOiByZWZlcmVuY2UgPyBmYWxzZSA6IFwiaW5saW5lXCIsXG4gICAgICAgIHNvdXJjZXNDb250ZW50OiB0cnVlLFxuICAgICAgICBiYW5uZXIsXG4gICAgICB9KTtcbiAgICAgIGNvZGUgPSByZXN1bHQuY29kZTtcbiAgICB9XG4gICAgaWYgKHJlZmVyZW5jZSkgY29kZSA9IGF3YWl0IGZvcm1hdChjb2RlLCB7IC4uLihhd2FpdCByZXNvbHZlQ29uZmlnKGRlc3RpbmF0aW9uKSksIGZpbGVwYXRoOiBkZXN0aW5hdGlvbiB9KTtcbiAgICAvLyBBIHBvcnRhYmxlIGdlbmVyYXRlZC1maWxlIGlkZW50aXR5IGRpc3Rpbmd1aXNoZXMgaWRlbnRpY2FsIGhlbHBlcnMgZXZlbiBhZnRlciBjb3B5aW5nIG9yIHJlbmFtaW5nIHRoZW0uXG4gICAgY29kZSA9IGNvZGUucmVwbGFjZShcbiAgICAgIC8oc291cmNlTWFwcGluZ1VSTD1kYXRhOmFwcGxpY2F0aW9uXFwvanNvbig/OjtjaGFyc2V0PXV0Zi04KT87YmFzZTY0LCkoW15cXHNdKykvLFxuICAgICAgKF8sIHByZWZpeDogc3RyaW5nLCBlbmNvZGVkOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgbWFwID0gSlNPTi5wYXJzZShCdWZmZXIuZnJvbShlbmNvZGVkLCBcImJhc2U2NFwiKS50b1N0cmluZyhcInV0ZjhcIikpIGFzIENvdmVyYWdlU291cmNlTWFwO1xuICAgICAgICBtYXAuZmlsZSA9IHJlbGF0aXZlKHJvb3QsIGRlc3RpbmF0aW9uKS5zcGxpdChcIlxcXFxcIikuam9pbihcIi9cIik7XG4gICAgICAgIHJldHVybiBwcmVmaXggKyBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeShtYXApKS50b1N0cmluZyhcImJhc2U2NFwiKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgICBpZiAoY2hlY2spIHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhkZXN0aW5hdGlvbikgfHwgcmVhZEZpbGVTeW5jKGRlc3RpbmF0aW9uLCBcInV0ZjhcIikgIT09IGNvZGUpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtyZWxhdGl2ZShyb290LCBkZXN0aW5hdGlvbil9IGlzIHN0YWxlOyBydW4gcG5wbSBydW4gdG9vbGluZzpidWlsZGApO1xuICAgICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09IFwid2luMzJcIiAmJiAoc3RhdFN5bmMoc291cmNlKS5tb2RlICYgMG8xMTEpICE9PSAoc3RhdFN5bmMoZGVzdGluYXRpb24pLm1vZGUgJiAwbzExMSkpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtyZWxhdGl2ZShyb290LCBkZXN0aW5hdGlvbil9IGhhcyBzdGFsZSBleGVjdXRhYmxlIHBlcm1pc3Npb25zOyBydW4gcG5wbSBydW4gdG9vbGluZzpidWlsZGApO1xuICAgIH0gZWxzZSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGRlc3RpbmF0aW9uLCBjb2RlKTtcbiAgICAgIGNobW9kU3luYyhkZXN0aW5hdGlvbiwgc3RhdFN5bmMoc291cmNlKS5tb2RlICYgMG83NzcpO1xuICAgIH1cbiAgfTtcbiAgY29uc3Qgc2tpcHBlZCA9IG5ldyBTZXQoW1xuICAgIFwibm9kZV9tb2R1bGVzXCIsXG4gICAgXCJ2ZW5kb3JcIixcbiAgICBcInRhcmdldFwiLFxuICAgIFwiYnVpbGRcIixcbiAgICBcImRpc3RcIixcbiAgICBcImNvdmVyYWdlXCIsXG4gICAgXCIudmVudlwiLFxuICAgIFwiLmRpcmVudlwiLFxuICAgIFwiLmdpdFwiLFxuICBdKTtcbiAgY29uc3QgdmlzaXQgPSBhc3luYyAoZGlyZWN0b3J5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKGRpcmVjdG9yeSwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pLnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpKSB7XG4gICAgICBjb25zdCBzb3VyY2UgPSBqb2luKGRpcmVjdG9yeSwgZW50cnkubmFtZSk7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSAmJiAhc2tpcHBlZC5oYXMoZW50cnkubmFtZSkpIGF3YWl0IHZpc2l0KHNvdXJjZSk7XG4gICAgICBlbHNlIGlmIChlbnRyeS5pc0ZpbGUoKSAmJiAvXFwuW21jXXRzJC8udGVzdChlbnRyeS5uYW1lKSAmJiAhL1xcLmRcXC5bbWNddHMkLy50ZXN0KGVudHJ5Lm5hbWUpKSBhd2FpdCBlbWl0KHNvdXJjZSk7XG4gICAgfVxuICB9O1xuICBmb3IgKGNvbnN0IGRpcmVjdG9yeSBvZiBbXCJzY3JpcHRzXCIsIFwiZXhhbXBsZXNcIiwgXCJiaW5cIl0pIGF3YWl0IHZpc2l0KGpvaW4ocm9vdCwgZGlyZWN0b3J5KSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXCJ2aXRlc3QuY29uZmlnLm10c1wiLCBcImVzbGludC5jb25maWcubXRzXCJdKVxuICAgIGlmIChleGlzdHNTeW5jKGpvaW4ocm9vdCwgbmFtZSkpKSBhd2FpdCBlbWl0KGpvaW4ocm9vdCwgbmFtZSkpO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiY2ktZG9ja2VyXCIsIFwiY2ktd29ya2JlbmNoXCJdKSBhd2FpdCBlbWl0KGpvaW4ocm9vdCwgYHRlc3RzL2ZpeHR1cmVzLyR7bmFtZX0ubXRzYCksIHRydWUpO1xufVxuXG5pZiAocHJvY2Vzcy5hcmd2WzFdICYmIHJlc29sdmUocHJvY2Vzcy5hcmd2WzFdKSA9PT0gZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKVxuICBhd2FpdCBidWlsZFRvb2xpbmcocmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4uXCIpLCBwcm9jZXNzLmFyZ3Yu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

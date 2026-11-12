// Generated from builder-store-gc.mts; edit the TypeScript source.
import { isMainScript } from "./script-entry.mjs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { withManagedProcesses } from "./managed-process.mjs";
import {
  diagnostic,
  LogLevel,
  DiagnosticOperation,
  DiagnosticOutcome
} from "../app/src/core/diagnostics/diagnostics.mjs";
const inputIdentity = /^[a-f0-9]{64}$/;
function retainStoreRoots(options) {
  if (!inputIdentity.test(options.inputs) || options.retained?.some((value) => !inputIdentity.test(value)))
    throw new Error("Invalid builder store retention identity");
  const targets = [
    ...new Set(
      options.targets.map((target) => {
        const path = realpathSync(target);
        const local = relative(realpathSync(options.store), path);
        if (!local || isAbsolute(local) || local === ".." || local.startsWith(".." + sep))
          throw new Error(`Builder GC target is outside its store: ${target}`);
        const item = local.split(sep)[0];
        if (!item || !/^[a-z0-9]{32}-[^/]+$/.test(item)) throw new Error(`Invalid builder store target: ${target}`);
        return join(options.store, item);
      })
    )
  ];
  if (!targets.length) throw new Error("Builder GC requires retained runtime and profile roots");
  if (existsSync(options.directory) && !lstatSync(options.directory).isDirectory())
    throw new Error("Builder GC root namespace must be a real directory");
  mkdirSync(options.directory, { recursive: true });
  const marker = join(options.directory, ".workbench-roots.json");
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8") !== '{"version":1}\n') throw new Error("Invalid builder GC ownership marker");
  } else {
    if (readdirSync(options.directory).length) throw new Error("Builder GC root namespace is not owned by Workbench");
    writeFileSync(marker, '{"version":1}\n', { flag: "wx", mode: 384 });
  }
  const destination = join(options.directory, options.inputs);
  if (!existsSync(destination)) {
    const stage = join(options.directory, `.partial-${randomUUID()}`);
    mkdirSync(stage);
    try {
      targets.forEach((target, index) => {
        symlinkSync(target, join(stage, String(index)), lstatSync(target).isDirectory() ? "junction" : "file");
      });
      renameSync(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    if (!lstatSync(destination).isDirectory()) throw new Error("Builder GC generation must be a real directory");
    const previous = readdirSync(destination).map((name) => {
      if (!/^\d+$/.test(name) || !lstatSync(join(destination, name)).isSymbolicLink())
        throw new Error("Builder GC generation contains unexpected files");
      return realpathSync(join(destination, name));
    });
    if (JSON.stringify(previous.sort()) !== JSON.stringify([...targets].sort()))
      throw new Error("Builder GC targets changed for the same image inputs");
  }
  if (options.retained === void 0) return;
  const keep = /* @__PURE__ */ new Set([options.inputs, ...options.retained]);
  for (const name of readdirSync(options.directory)) {
    if (!inputIdentity.test(name) || keep.has(name)) continue;
    const directory = join(options.directory, name);
    if (!lstatSync(directory).isDirectory()) throw new Error("Builder GC generation must be a real directory");
    const files = readdirSync(directory);
    if (files.some((file) => !/^\d+$/.test(file) || !lstatSync(join(directory, file)).isSymbolicLink()))
      throw new Error("Builder GC generation contains unexpected files");
    rmSync(directory, { recursive: true });
  }
}
async function collectPrivateBuilderStore(builder) {
  if (!existsSync("/.dockerenv") || !/^[a-f0-9]{24}$/.test(process.env.WORKBENCH_PRIVATE_BUILDER ?? ""))
    throw new Error("Builder store GC requires an owned private Docker builder");
  const output = process.env.WORKBENCH_MANAGED_OUTPUT ?? "/output";
  const store = builder === "guix" ? "/gnu/store" : "/nix/store";
  const profiles = JSON.parse(
    readFileSync(join(output, builder === "guix" ? "guix-profiles.json" : "profiles.json"), "utf8")
  );
  if (!Array.isArray(profiles)) throw new Error("Missing builder profile roots");
  const targets = profiles.flatMap((profile) => {
    if (builder === "nix" && typeof profile === "string") return [profile];
    if (builder === "guix" && profile && typeof profile === "object" && "profile" in profile && "runtime" in profile && "manager" in profile && typeof profile.profile === "string" && typeof profile.runtime === "string" && typeof profile.manager === "string")
      return [profile.profile, profile.runtime, profile.manager];
    throw new Error("Invalid builder profile roots");
  });
  targets.push(readFileSync(join(output, "image-path"), "utf8").trim());
  targets.push(...builder === "guix" ? ["/opt/workbench-guix"] : ["/opt/workbench-bootstrap", "/opt/nix-runtime"]);
  const retained = process.env.WORKBENCH_BUILDER_RETAIN_INPUTS === void 0 ? void 0 : JSON.parse(process.env.WORKBENCH_BUILDER_RETAIN_INPUTS);
  if (retained !== void 0 && (!Array.isArray(retained) || retained.some((value) => typeof value !== "string")))
    throw new Error("Invalid retained builder profile identities");
  retainStoreRoots({
    store,
    directory: builder === "guix" ? "/var/guix/gcroots/workbench" : "/nix/var/nix/gcroots/workbench",
    inputs: process.env.WORKBENCH_IMAGE_INPUTS ?? "",
    retained,
    targets
  });
  if (process.env.WORKBENCH_BUILDER_GC === "true") {
    try {
      await withManagedProcesses(async (scope) => {
        await scope.run(
          builder === "guix" ? "/opt/workbench-guix/bin/guix" : "nix-store",
          builder === "guix" ? ["gc"] : ["--gc"]
        );
      });
    } catch (error) {
      diagnostic(
        LogLevel.Warn,
        DiagnosticOperation.Command,
        DiagnosticOutcome.Failed,
        { command: "private builder store cleanup" },
        error,
        "prepared output and durable profile roots are preserved"
      );
    }
  }
}
if (isMainScript(import.meta.url)) {
  const builder = process.argv[2];
  if (builder !== "guix" && builder !== "nix") throw new Error("Expected nix or guix builder");
  await collectPrivateBuilderStore(builder);
}
export {
  collectPrivateBuilderStore,
  retainStoreRoots
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJ1aWxkZXItc3RvcmUtZ2MubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzTWFpblNjcmlwdCB9IGZyb20gXCIuL3NjcmlwdC1lbnRyeS5tanNcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIGxzdGF0U3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIHJtU3luYyxcbiAgc3ltbGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQge1xuICBkaWFnbm9zdGljLFxuICBMb2dMZXZlbCxcbiAgRGlhZ25vc3RpY09wZXJhdGlvbixcbiAgRGlhZ25vc3RpY091dGNvbWUsXG59IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvZGlhZ25vc3RpY3MvZGlhZ25vc3RpY3MubWpzXCI7XG5cbmNvbnN0IGlucHV0SWRlbnRpdHkgPSAvXlthLWYwLTldezY0fSQvO1xudHlwZSBCdWlsZGVyID0gXCJuaXhcIiB8IFwiZ3VpeFwiO1xuXG4vKiogR0Mgcm9vdHMgYmVsb25nIHRvIHRoaXMgcHJpdmF0ZSBzdG9yZTsgcHVibGlzaGluZyBhIG5ldyBzZXQgbmV2ZXIgcmVtb3ZlcyB0aGUgcHJldmlvdXMgd29ya2luZyBzZXQgZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gcmV0YWluU3RvcmVSb290cyhvcHRpb25zOiB7XG4gIHN0b3JlOiBzdHJpbmc7XG4gIGRpcmVjdG9yeTogc3RyaW5nO1xuICBpbnB1dHM6IHN0cmluZztcbiAgcmV0YWluZWQ6IHJlYWRvbmx5IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICB0YXJnZXRzOiByZWFkb25seSBzdHJpbmdbXTtcbn0pOiB2b2lkIHtcbiAgaWYgKCFpbnB1dElkZW50aXR5LnRlc3Qob3B0aW9ucy5pbnB1dHMpIHx8IG9wdGlvbnMucmV0YWluZWQ/LnNvbWUoKHZhbHVlKSA9PiAhaW5wdXRJZGVudGl0eS50ZXN0KHZhbHVlKSkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBidWlsZGVyIHN0b3JlIHJldGVudGlvbiBpZGVudGl0eVwiKTtcbiAgY29uc3QgdGFyZ2V0cyA9IFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgb3B0aW9ucy50YXJnZXRzLm1hcCgodGFyZ2V0KSA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSByZWFscGF0aFN5bmModGFyZ2V0KTtcbiAgICAgICAgY29uc3QgbG9jYWwgPSByZWxhdGl2ZShyZWFscGF0aFN5bmMob3B0aW9ucy5zdG9yZSksIHBhdGgpO1xuICAgICAgICBpZiAoIWxvY2FsIHx8IGlzQWJzb2x1dGUobG9jYWwpIHx8IGxvY2FsID09PSBcIi4uXCIgfHwgbG9jYWwuc3RhcnRzV2l0aChcIi4uXCIgKyBzZXApKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQnVpbGRlciBHQyB0YXJnZXQgaXMgb3V0c2lkZSBpdHMgc3RvcmU6ICR7dGFyZ2V0fWApO1xuICAgICAgICBjb25zdCBpdGVtID0gbG9jYWwuc3BsaXQoc2VwKVswXTtcbiAgICAgICAgaWYgKCFpdGVtIHx8ICEvXlthLXowLTldezMyfS1bXi9dKyQvLnRlc3QoaXRlbSkpIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBidWlsZGVyIHN0b3JlIHRhcmdldDogJHt0YXJnZXR9YCk7XG4gICAgICAgIHJldHVybiBqb2luKG9wdGlvbnMuc3RvcmUsIGl0ZW0pO1xuICAgICAgfSksXG4gICAgKSxcbiAgXTtcbiAgaWYgKCF0YXJnZXRzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBHQyByZXF1aXJlcyByZXRhaW5lZCBydW50aW1lIGFuZCBwcm9maWxlIHJvb3RzXCIpO1xuICBpZiAoZXhpc3RzU3luYyhvcHRpb25zLmRpcmVjdG9yeSkgJiYgIWxzdGF0U3luYyhvcHRpb25zLmRpcmVjdG9yeSkuaXNEaXJlY3RvcnkoKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIHJvb3QgbmFtZXNwYWNlIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgbWtkaXJTeW5jKG9wdGlvbnMuZGlyZWN0b3J5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgbWFya2VyID0gam9pbihvcHRpb25zLmRpcmVjdG9yeSwgXCIud29ya2JlbmNoLXJvb3RzLmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKG1hcmtlcikpIHtcbiAgICBpZiAocmVhZEZpbGVTeW5jKG1hcmtlciwgXCJ1dGY4XCIpICE9PSAne1widmVyc2lvblwiOjF9XFxuJykgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBidWlsZGVyIEdDIG93bmVyc2hpcCBtYXJrZXJcIik7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHJlYWRkaXJTeW5jKG9wdGlvbnMuZGlyZWN0b3J5KS5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgR0Mgcm9vdCBuYW1lc3BhY2UgaXMgbm90IG93bmVkIGJ5IFdvcmtiZW5jaFwiKTtcbiAgICAvLyBjb2RlcWxbanMvZmlsZS1zeXN0ZW0tcmFjZV0gRXhjbHVzaXZlIGNyZWF0aW9uICh3eCkgcmVqZWN0cyBhIGNvbmN1cnJlbnQgbWFya2VyOyBpdCBjYW5ub3Qgb3ZlcndyaXRlIGFuIGV4aXN0aW5nIGZpbGUuXG4gICAgd3JpdGVGaWxlU3luYyhtYXJrZXIsICd7XCJ2ZXJzaW9uXCI6MX1cXG4nLCB7IGZsYWc6IFwid3hcIiwgbW9kZTogMG82MDAgfSk7XG4gIH1cbiAgY29uc3QgZGVzdGluYXRpb24gPSBqb2luKG9wdGlvbnMuZGlyZWN0b3J5LCBvcHRpb25zLmlucHV0cyk7XG4gIGlmICghZXhpc3RzU3luYyhkZXN0aW5hdGlvbikpIHtcbiAgICBjb25zdCBzdGFnZSA9IGpvaW4ob3B0aW9ucy5kaXJlY3RvcnksIGAucGFydGlhbC0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgICBta2RpclN5bmMoc3RhZ2UpO1xuICAgIHRyeSB7XG4gICAgICB0YXJnZXRzLmZvckVhY2goKHRhcmdldCwgaW5kZXgpID0+IHtcbiAgICAgICAgc3ltbGlua1N5bmModGFyZ2V0LCBqb2luKHN0YWdlLCBTdHJpbmcoaW5kZXgpKSwgbHN0YXRTeW5jKHRhcmdldCkuaXNEaXJlY3RvcnkoKSA/IFwianVuY3Rpb25cIiA6IFwiZmlsZVwiKTtcbiAgICAgIH0pO1xuICAgICAgcmVuYW1lU3luYyhzdGFnZSwgZGVzdGluYXRpb24pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoc3RhZ2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKCFsc3RhdFN5bmMoZGVzdGluYXRpb24pLmlzRGlyZWN0b3J5KCkpIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgR0MgZ2VuZXJhdGlvbiBtdXN0IGJlIGEgcmVhbCBkaXJlY3RvcnlcIik7XG4gICAgY29uc3QgcHJldmlvdXMgPSByZWFkZGlyU3luYyhkZXN0aW5hdGlvbikubWFwKChuYW1lKSA9PiB7XG4gICAgICBpZiAoIS9eXFxkKyQvLnRlc3QobmFtZSkgfHwgIWxzdGF0U3luYyhqb2luKGRlc3RpbmF0aW9uLCBuYW1lKSkuaXNTeW1ib2xpY0xpbmsoKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBHQyBnZW5lcmF0aW9uIGNvbnRhaW5zIHVuZXhwZWN0ZWQgZmlsZXNcIik7XG4gICAgICByZXR1cm4gcmVhbHBhdGhTeW5jKGpvaW4oZGVzdGluYXRpb24sIG5hbWUpKTtcbiAgICB9KTtcbiAgICBpZiAoSlNPTi5zdHJpbmdpZnkocHJldmlvdXMuc29ydCgpKSAhPT0gSlNPTi5zdHJpbmdpZnkoWy4uLnRhcmdldHNdLnNvcnQoKSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIHRhcmdldHMgY2hhbmdlZCBmb3IgdGhlIHNhbWUgaW1hZ2UgaW5wdXRzXCIpO1xuICB9XG4gIGlmIChvcHRpb25zLnJldGFpbmVkID09PSB1bmRlZmluZWQpIHJldHVybjsgLy8gTWlzc2luZyBhY2NlcHRlZC1wcm9maWxlIGV2aWRlbmNlIHByZXNlcnZlcyBvbGRlciByb290cy5cbiAgY29uc3Qga2VlcCA9IG5ldyBTZXQoW29wdGlvbnMuaW5wdXRzLCAuLi5vcHRpb25zLnJldGFpbmVkXSk7XG4gIGZvciAoY29uc3QgbmFtZSBvZiByZWFkZGlyU3luYyhvcHRpb25zLmRpcmVjdG9yeSkpIHtcbiAgICBpZiAoIWlucHV0SWRlbnRpdHkudGVzdChuYW1lKSB8fCBrZWVwLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgY29uc3QgZGlyZWN0b3J5ID0gam9pbihvcHRpb25zLmRpcmVjdG9yeSwgbmFtZSk7XG4gICAgaWYgKCFsc3RhdFN5bmMoZGlyZWN0b3J5KS5pc0RpcmVjdG9yeSgpKSB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIGdlbmVyYXRpb24gbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICAgIGNvbnN0IGZpbGVzID0gcmVhZGRpclN5bmMoZGlyZWN0b3J5KTtcbiAgICBpZiAoZmlsZXMuc29tZSgoZmlsZSkgPT4gIS9eXFxkKyQvLnRlc3QoZmlsZSkgfHwgIWxzdGF0U3luYyhqb2luKGRpcmVjdG9yeSwgZmlsZSkpLmlzU3ltYm9saWNMaW5rKCkpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBHQyBnZW5lcmF0aW9uIGNvbnRhaW5zIHVuZXhwZWN0ZWQgZmlsZXNcIik7XG4gICAgcm1TeW5jKGRpcmVjdG9yeSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn1cblxuLyoqIE9ubHkgdGhlIG93bmVkIERvY2tlciBwcmVwYXJhdGlvbiBwYXRoIGludm9rZXMgY29sbGVjdGlvbjsgdGhlIGhvc3QgbWFuYWdlciBzdG9yZSBpcyBuZXZlciBzZWxlY3RlZCBoZXJlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RQcml2YXRlQnVpbGRlclN0b3JlKGJ1aWxkZXI6IEJ1aWxkZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFleGlzdHNTeW5jKFwiLy5kb2NrZXJlbnZcIikgfHwgIS9eW2EtZjAtOV17MjR9JC8udGVzdChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfUFJJVkFURV9CVUlMREVSID8/IFwiXCIpKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgc3RvcmUgR0MgcmVxdWlyZXMgYW4gb3duZWQgcHJpdmF0ZSBEb2NrZXIgYnVpbGRlclwiKTtcbiAgY29uc3Qgb3V0cHV0ID0gcHJvY2Vzcy5lbnYuV09SS0JFTkNIX01BTkFHRURfT1VUUFVUID8/IFwiL291dHB1dFwiO1xuICBjb25zdCBzdG9yZSA9IGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvZ251L3N0b3JlXCIgOiBcIi9uaXgvc3RvcmVcIjtcbiAgY29uc3QgcHJvZmlsZXM6IHVua25vd24gPSBKU09OLnBhcnNlKFxuICAgIHJlYWRGaWxlU3luYyhqb2luKG91dHB1dCwgYnVpbGRlciA9PT0gXCJndWl4XCIgPyBcImd1aXgtcHJvZmlsZXMuanNvblwiIDogXCJwcm9maWxlcy5qc29uXCIpLCBcInV0ZjhcIiksXG4gICk7XG4gIGlmICghQXJyYXkuaXNBcnJheShwcm9maWxlcykpIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgYnVpbGRlciBwcm9maWxlIHJvb3RzXCIpO1xuICBjb25zdCB0YXJnZXRzOiBzdHJpbmdbXSA9IHByb2ZpbGVzLmZsYXRNYXAoKHByb2ZpbGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoYnVpbGRlciA9PT0gXCJuaXhcIiAmJiB0eXBlb2YgcHJvZmlsZSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIFtwcm9maWxlXTtcbiAgICBpZiAoXG4gICAgICBidWlsZGVyID09PSBcImd1aXhcIiAmJlxuICAgICAgcHJvZmlsZSAmJlxuICAgICAgdHlwZW9mIHByb2ZpbGUgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgIFwicHJvZmlsZVwiIGluIHByb2ZpbGUgJiZcbiAgICAgIFwicnVudGltZVwiIGluIHByb2ZpbGUgJiZcbiAgICAgIFwibWFuYWdlclwiIGluIHByb2ZpbGUgJiZcbiAgICAgIHR5cGVvZiBwcm9maWxlLnByb2ZpbGUgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgIHR5cGVvZiBwcm9maWxlLnJ1bnRpbWUgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgIHR5cGVvZiBwcm9maWxlLm1hbmFnZXIgPT09IFwic3RyaW5nXCJcbiAgICApXG4gICAgICByZXR1cm4gW3Byb2ZpbGUucHJvZmlsZSwgcHJvZmlsZS5ydW50aW1lLCBwcm9maWxlLm1hbmFnZXJdO1xuICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgYnVpbGRlciBwcm9maWxlIHJvb3RzXCIpO1xuICB9KTtcbiAgdGFyZ2V0cy5wdXNoKHJlYWRGaWxlU3luYyhqb2luKG91dHB1dCwgXCJpbWFnZS1wYXRoXCIpLCBcInV0ZjhcIikudHJpbSgpKTtcbiAgdGFyZ2V0cy5wdXNoKC4uLihidWlsZGVyID09PSBcImd1aXhcIiA/IFtcIi9vcHQvd29ya2JlbmNoLWd1aXhcIl0gOiBbXCIvb3B0L3dvcmtiZW5jaC1ib290c3RyYXBcIiwgXCIvb3B0L25peC1ydW50aW1lXCJdKSk7XG4gIGNvbnN0IHJldGFpbmVkOiB1bmtub3duID1cbiAgICBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERFUl9SRVRBSU5fSU5QVVRTID09PSB1bmRlZmluZWRcbiAgICAgID8gdW5kZWZpbmVkXG4gICAgICA6IEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxERVJfUkVUQUlOX0lOUFVUUyk7XG4gIGlmIChcbiAgICByZXRhaW5lZCAhPT0gdW5kZWZpbmVkICYmXG4gICAgKCFBcnJheS5pc0FycmF5KHJldGFpbmVkKSB8fCByZXRhaW5lZC5zb21lKCh2YWx1ZTogdW5rbm93bikgPT4gdHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSlcbiAgKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgcmV0YWluZWQgYnVpbGRlciBwcm9maWxlIGlkZW50aXRpZXNcIik7XG4gIHJldGFpblN0b3JlUm9vdHMoe1xuICAgIHN0b3JlLFxuICAgIGRpcmVjdG9yeTogYnVpbGRlciA9PT0gXCJndWl4XCIgPyBcIi92YXIvZ3VpeC9nY3Jvb3RzL3dvcmtiZW5jaFwiIDogXCIvbml4L3Zhci9uaXgvZ2Nyb290cy93b3JrYmVuY2hcIixcbiAgICBpbnB1dHM6IHByb2Nlc3MuZW52LldPUktCRU5DSF9JTUFHRV9JTlBVVFMgPz8gXCJcIixcbiAgICByZXRhaW5lZDogcmV0YWluZWQgYXMgc3RyaW5nW10gfCB1bmRlZmluZWQsXG4gICAgdGFyZ2V0cyxcbiAgfSk7XG4gIGlmIChwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERFUl9HQyA9PT0gXCJ0cnVlXCIpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgd2l0aE1hbmFnZWRQcm9jZXNzZXMoYXN5bmMgKHNjb3BlKSA9PiB7XG4gICAgICAgIGF3YWl0IHNjb3BlLnJ1bihcbiAgICAgICAgICBidWlsZGVyID09PSBcImd1aXhcIiA/IFwiL29wdC93b3JrYmVuY2gtZ3VpeC9iaW4vZ3VpeFwiIDogXCJuaXgtc3RvcmVcIixcbiAgICAgICAgICBidWlsZGVyID09PSBcImd1aXhcIiA/IFtcImdjXCJdIDogW1wiLS1nY1wiXSxcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBkaWFnbm9zdGljKFxuICAgICAgICBMb2dMZXZlbC5XYXJuLFxuICAgICAgICBEaWFnbm9zdGljT3BlcmF0aW9uLkNvbW1hbmQsXG4gICAgICAgIERpYWdub3N0aWNPdXRjb21lLkZhaWxlZCxcbiAgICAgICAgeyBjb21tYW5kOiBcInByaXZhdGUgYnVpbGRlciBzdG9yZSBjbGVhbnVwXCIgfSxcbiAgICAgICAgZXJyb3IsXG4gICAgICAgIFwicHJlcGFyZWQgb3V0cHV0IGFuZCBkdXJhYmxlIHByb2ZpbGUgcm9vdHMgYXJlIHByZXNlcnZlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuaWYgKGlzTWFpblNjcmlwdChpbXBvcnQubWV0YS51cmwpKSB7XG4gIGNvbnN0IGJ1aWxkZXIgPSBwcm9jZXNzLmFyZ3ZbMl07XG4gIGlmIChidWlsZGVyICE9PSBcImd1aXhcIiAmJiBidWlsZGVyICE9PSBcIm5peFwiKSB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCBuaXggb3IgZ3VpeCBidWlsZGVyXCIpO1xuICBhd2FpdCBjb2xsZWN0UHJpdmF0ZUJ1aWxkZXJTdG9yZShidWlsZGVyKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsb0JBQW9CO0FBQzdCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLFlBQVksTUFBTSxVQUFVLFdBQVc7QUFDaEQsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyw0QkFBNEI7QUFDckM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLE1BQU0sZ0JBQWdCO0FBSWYsU0FBUyxpQkFBaUIsU0FNeEI7QUFDUCxNQUFJLENBQUMsY0FBYyxLQUFLLFFBQVEsTUFBTSxLQUFLLFFBQVEsVUFBVSxLQUFLLENBQUMsVUFBVSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUM7QUFDckcsVUFBTSxJQUFJLE1BQU0sMENBQTBDO0FBQzVELFFBQU0sVUFBVTtBQUFBLElBQ2QsR0FBRyxJQUFJO0FBQUEsTUFDTCxRQUFRLFFBQVEs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

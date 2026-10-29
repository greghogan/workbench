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
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImJ1aWxkZXItc3RvcmUtZ2MubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGlzTWFpblNjcmlwdCB9IGZyb20gXCIuL3NjcmlwdC1lbnRyeS5tanNcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIGxzdGF0U3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFscGF0aFN5bmMsXG4gIHJlbmFtZVN5bmMsXG4gIHJtU3luYyxcbiAgc3ltbGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgd2l0aE1hbmFnZWRQcm9jZXNzZXMgfSBmcm9tIFwiLi9tYW5hZ2VkLXByb2Nlc3MubWpzXCI7XG5pbXBvcnQgeyBkaWFnbm9zdGljLCBMb2dMZXZlbCwgRGlhZ25vc3RpY09wZXJhdGlvbiwgRGlhZ25vc3RpY091dGNvbWUgfSBmcm9tIFwiLi9kaWFnbm9zdGljcy5tanNcIjtcblxuY29uc3QgaW5wdXRJZGVudGl0eSA9IC9eW2EtZjAtOV17NjR9JC87XG50eXBlIEJ1aWxkZXIgPSBcIm5peFwiIHwgXCJndWl4XCI7XG5cbi8qKiBHQyByb290cyBiZWxvbmcgdG8gdGhpcyBwcml2YXRlIHN0b3JlOyBwdWJsaXNoaW5nIGEgbmV3IHNldCBuZXZlciByZW1vdmVzIHRoZSBwcmV2aW91cyB3b3JraW5nIHNldCBmaXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXRhaW5TdG9yZVJvb3RzKG9wdGlvbnM6IHtcbiAgc3RvcmU6IHN0cmluZztcbiAgZGlyZWN0b3J5OiBzdHJpbmc7XG4gIGlucHV0czogc3RyaW5nO1xuICByZXRhaW5lZDogcmVhZG9ubHkgc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gIHRhcmdldHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xufSk6IHZvaWQge1xuICBpZiAoIWlucHV0SWRlbnRpdHkudGVzdChvcHRpb25zLmlucHV0cykgfHwgb3B0aW9ucy5yZXRhaW5lZD8uc29tZSgodmFsdWUpID0+ICFpbnB1dElkZW50aXR5LnRlc3QodmFsdWUpKSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGJ1aWxkZXIgc3RvcmUgcmV0ZW50aW9uIGlkZW50aXR5XCIpO1xuICBjb25zdCB0YXJnZXRzID0gW1xuICAgIC4uLm5ldyBTZXQoXG4gICAgICBvcHRpb25zLnRhcmdldHMubWFwKCh0YXJnZXQpID0+IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IHJlYWxwYXRoU3luYyh0YXJnZXQpO1xuICAgICAgICBjb25zdCBsb2NhbCA9IHJlbGF0aXZlKHJlYWxwYXRoU3luYyhvcHRpb25zLnN0b3JlKSwgcGF0aCk7XG4gICAgICAgIGlmICghbG9jYWwgfHwgaXNBYnNvbHV0ZShsb2NhbCkgfHwgbG9jYWwgPT09IFwiLi5cIiB8fCBsb2NhbC5zdGFydHNXaXRoKFwiLi5cIiArIHNlcCkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBCdWlsZGVyIEdDIHRhcmdldCBpcyBvdXRzaWRlIGl0cyBzdG9yZTogJHt0YXJnZXR9YCk7XG4gICAgICAgIGNvbnN0IGl0ZW0gPSBsb2NhbC5zcGxpdChzZXApWzBdO1xuICAgICAgICBpZiAoIWl0ZW0gfHwgIS9eW2EtejAtOV17MzJ9LVteL10rJC8udGVzdChpdGVtKSkgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGJ1aWxkZXIgc3RvcmUgdGFyZ2V0OiAke3RhcmdldH1gKTtcbiAgICAgICAgcmV0dXJuIGpvaW4ob3B0aW9ucy5zdG9yZSwgaXRlbSk7XG4gICAgICB9KSxcbiAgICApLFxuICBdO1xuICBpZiAoIXRhcmdldHMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIHJlcXVpcmVzIHJldGFpbmVkIHJ1bnRpbWUgYW5kIHByb2ZpbGUgcm9vdHNcIik7XG4gIGlmIChleGlzdHNTeW5jKG9wdGlvbnMuZGlyZWN0b3J5KSAmJiAhbHN0YXRTeW5jKG9wdGlvbnMuZGlyZWN0b3J5KS5pc0RpcmVjdG9yeSgpKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgR0Mgcm9vdCBuYW1lc3BhY2UgbXVzdCBiZSBhIHJlYWwgZGlyZWN0b3J5XCIpO1xuICBta2RpclN5bmMob3B0aW9ucy5kaXJlY3RvcnksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBtYXJrZXIgPSBqb2luKG9wdGlvbnMuZGlyZWN0b3J5LCBcIi53b3JrYmVuY2gtcm9vdHMuanNvblwiKTtcbiAgaWYgKGV4aXN0c1N5bmMobWFya2VyKSkge1xuICAgIGlmIChyZWFkRmlsZVN5bmMobWFya2VyLCBcInV0ZjhcIikgIT09ICd7XCJ2ZXJzaW9uXCI6MX1cXG4nKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGJ1aWxkZXIgR0Mgb3duZXJzaGlwIG1hcmtlclwiKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAocmVhZGRpclN5bmMob3B0aW9ucy5kaXJlY3RvcnkpLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBHQyByb290IG5hbWVzcGFjZSBpcyBub3Qgb3duZWQgYnkgV29ya2JlbmNoXCIpO1xuICAgIC8vIGNvZGVxbFtqcy9maWxlLXN5c3RlbS1yYWNlXSBFeGNsdXNpdmUgY3JlYXRpb24gKHd4KSByZWplY3RzIGEgY29uY3VycmVudCBtYXJrZXI7IGl0IGNhbm5vdCBvdmVyd3JpdGUgYW4gZXhpc3RpbmcgZmlsZS5cbiAgICB3cml0ZUZpbGVTeW5jKG1hcmtlciwgJ3tcInZlcnNpb25cIjoxfVxcbicsIHsgZmxhZzogXCJ3eFwiLCBtb2RlOiAwbzYwMCB9KTtcbiAgfVxuICBjb25zdCBkZXN0aW5hdGlvbiA9IGpvaW4ob3B0aW9ucy5kaXJlY3RvcnksIG9wdGlvbnMuaW5wdXRzKTtcbiAgaWYgKCFleGlzdHNTeW5jKGRlc3RpbmF0aW9uKSkge1xuICAgIGNvbnN0IHN0YWdlID0gam9pbihvcHRpb25zLmRpcmVjdG9yeSwgYC5wYXJ0aWFsLSR7cmFuZG9tVVVJRCgpfWApO1xuICAgIG1rZGlyU3luYyhzdGFnZSk7XG4gICAgdHJ5IHtcbiAgICAgIHRhcmdldHMuZm9yRWFjaCgodGFyZ2V0LCBpbmRleCkgPT4ge1xuICAgICAgICBzeW1saW5rU3luYyh0YXJnZXQsIGpvaW4oc3RhZ2UsIFN0cmluZyhpbmRleCkpLCBsc3RhdFN5bmModGFyZ2V0KS5pc0RpcmVjdG9yeSgpID8gXCJqdW5jdGlvblwiIDogXCJmaWxlXCIpO1xuICAgICAgfSk7XG4gICAgICByZW5hbWVTeW5jKHN0YWdlLCBkZXN0aW5hdGlvbik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhzdGFnZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBpZiAoIWxzdGF0U3luYyhkZXN0aW5hdGlvbikuaXNEaXJlY3RvcnkoKSkgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBHQyBnZW5lcmF0aW9uIG11c3QgYmUgYSByZWFsIGRpcmVjdG9yeVwiKTtcbiAgICBjb25zdCBwcmV2aW91cyA9IHJlYWRkaXJTeW5jKGRlc3RpbmF0aW9uKS5tYXAoKG5hbWUpID0+IHtcbiAgICAgIGlmICghL15cXGQrJC8udGVzdChuYW1lKSB8fCAhbHN0YXRTeW5jKGpvaW4oZGVzdGluYXRpb24sIG5hbWUpKS5pc1N5bWJvbGljTGluaygpKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIGdlbmVyYXRpb24gY29udGFpbnMgdW5leHBlY3RlZCBmaWxlc1wiKTtcbiAgICAgIHJldHVybiByZWFscGF0aFN5bmMoam9pbihkZXN0aW5hdGlvbiwgbmFtZSkpO1xuICAgIH0pO1xuICAgIGlmIChKU09OLnN0cmluZ2lmeShwcmV2aW91cy5zb3J0KCkpICE9PSBKU09OLnN0cmluZ2lmeShbLi4udGFyZ2V0c10uc29ydCgpKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgR0MgdGFyZ2V0cyBjaGFuZ2VkIGZvciB0aGUgc2FtZSBpbWFnZSBpbnB1dHNcIik7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmV0YWluZWQgPT09IHVuZGVmaW5lZCkgcmV0dXJuOyAvLyBNaXNzaW5nIGFjY2VwdGVkLXByb2ZpbGUgZXZpZGVuY2UgcHJlc2VydmVzIG9sZGVyIHJvb3RzLlxuICBjb25zdCBrZWVwID0gbmV3IFNldChbb3B0aW9ucy5pbnB1dHMsIC4uLm9wdGlvbnMucmV0YWluZWRdKTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHJlYWRkaXJTeW5jKG9wdGlvbnMuZGlyZWN0b3J5KSkge1xuICAgIGlmICghaW5wdXRJZGVudGl0eS50ZXN0KG5hbWUpIHx8IGtlZXAuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICBjb25zdCBkaXJlY3RvcnkgPSBqb2luKG9wdGlvbnMuZGlyZWN0b3J5LCBuYW1lKTtcbiAgICBpZiAoIWxzdGF0U3luYyhkaXJlY3RvcnkpLmlzRGlyZWN0b3J5KCkpIHRocm93IG5ldyBFcnJvcihcIkJ1aWxkZXIgR0MgZ2VuZXJhdGlvbiBtdXN0IGJlIGEgcmVhbCBkaXJlY3RvcnlcIik7XG4gICAgY29uc3QgZmlsZXMgPSByZWFkZGlyU3luYyhkaXJlY3RvcnkpO1xuICAgIGlmIChmaWxlcy5zb21lKChmaWxlKSA9PiAhL15cXGQrJC8udGVzdChmaWxlKSB8fCAhbHN0YXRTeW5jKGpvaW4oZGlyZWN0b3J5LCBmaWxlKSkuaXNTeW1ib2xpY0xpbmsoKSkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJCdWlsZGVyIEdDIGdlbmVyYXRpb24gY29udGFpbnMgdW5leHBlY3RlZCBmaWxlc1wiKTtcbiAgICBybVN5bmMoZGlyZWN0b3J5LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG4vKiogT25seSB0aGUgb3duZWQgRG9ja2VyIHByZXBhcmF0aW9uIHBhdGggaW52b2tlcyBjb2xsZWN0aW9uOyB0aGUgaG9zdCBtYW5hZ2VyIHN0b3JlIGlzIG5ldmVyIHNlbGVjdGVkIGhlcmUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdFByaXZhdGVCdWlsZGVyU3RvcmUoYnVpbGRlcjogQnVpbGRlcik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWV4aXN0c1N5bmMoXCIvLmRvY2tlcmVudlwiKSB8fCAhL15bYS1mMC05XXsyNH0kLy50ZXN0KHByb2Nlc3MuZW52LldPUktCRU5DSF9QUklWQVRFX0JVSUxERVIgPz8gXCJcIikpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQnVpbGRlciBzdG9yZSBHQyByZXF1aXJlcyBhbiBvd25lZCBwcml2YXRlIERvY2tlciBidWlsZGVyXCIpO1xuICBjb25zdCBvdXRwdXQgPSBwcm9jZXNzLmVudi5XT1JLQkVOQ0hfTUFOQUdFRF9PVVRQVVQgPz8gXCIvb3V0cHV0XCI7XG4gIGNvbnN0IHN0b3JlID0gYnVpbGRlciA9PT0gXCJndWl4XCIgPyBcIi9nbnUvc3RvcmVcIiA6IFwiL25peC9zdG9yZVwiO1xuICBjb25zdCBwcm9maWxlczogdW5rbm93biA9IEpTT04ucGFyc2UoXG4gICAgcmVhZEZpbGVTeW5jKGpvaW4ob3V0cHV0LCBidWlsZGVyID09PSBcImd1aXhcIiA/IFwiZ3VpeC1wcm9maWxlcy5qc29uXCIgOiBcInByb2ZpbGVzLmpzb25cIiksIFwidXRmOFwiKSxcbiAgKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHByb2ZpbGVzKSkgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBidWlsZGVyIHByb2ZpbGUgcm9vdHNcIik7XG4gIGNvbnN0IHRhcmdldHM6IHN0cmluZ1tdID0gcHJvZmlsZXMuZmxhdE1hcCgocHJvZmlsZTogdW5rbm93bikgPT4ge1xuICAgIGlmIChidWlsZGVyID09PSBcIm5peFwiICYmIHR5cGVvZiBwcm9maWxlID09PSBcInN0cmluZ1wiKSByZXR1cm4gW3Byb2ZpbGVdO1xuICAgIGlmIChcbiAgICAgIGJ1aWxkZXIgPT09IFwiZ3VpeFwiICYmXG4gICAgICBwcm9maWxlICYmXG4gICAgICB0eXBlb2YgcHJvZmlsZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgXCJwcm9maWxlXCIgaW4gcHJvZmlsZSAmJlxuICAgICAgXCJydW50aW1lXCIgaW4gcHJvZmlsZSAmJlxuICAgICAgXCJtYW5hZ2VyXCIgaW4gcHJvZmlsZSAmJlxuICAgICAgdHlwZW9mIHByb2ZpbGUucHJvZmlsZSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgdHlwZW9mIHByb2ZpbGUucnVudGltZSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgdHlwZW9mIHByb2ZpbGUubWFuYWdlciA9PT0gXCJzdHJpbmdcIlxuICAgIClcbiAgICAgIHJldHVybiBbcHJvZmlsZS5wcm9maWxlLCBwcm9maWxlLnJ1bnRpbWUsIHByb2ZpbGUubWFuYWdlcl07XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBidWlsZGVyIHByb2ZpbGUgcm9vdHNcIik7XG4gIH0pO1xuICB0YXJnZXRzLnB1c2gocmVhZEZpbGVTeW5jKGpvaW4ob3V0cHV0LCBcImltYWdlLXBhdGhcIiksIFwidXRmOFwiKS50cmltKCkpO1xuICB0YXJnZXRzLnB1c2goLi4uKGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gW1wiL29wdC93b3JrYmVuY2gtZ3VpeFwiXSA6IFtcIi9vcHQvd29ya2JlbmNoLWJvb3RzdHJhcFwiLCBcIi9vcHQvbml4LXJ1bnRpbWVcIl0pKTtcbiAgY29uc3QgcmV0YWluZWQ6IHVua25vd24gPVxuICAgIHByb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMREVSX1JFVEFJTl9JTlBVVFMgPT09IHVuZGVmaW5lZFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogSlNPTi5wYXJzZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERFUl9SRVRBSU5fSU5QVVRTKTtcbiAgaWYgKFxuICAgIHJldGFpbmVkICE9PSB1bmRlZmluZWQgJiZcbiAgICAoIUFycmF5LmlzQXJyYXkocmV0YWluZWQpIHx8IHJldGFpbmVkLnNvbWUoKHZhbHVlOiB1bmtub3duKSA9PiB0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpKVxuICApXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCByZXRhaW5lZCBidWlsZGVyIHByb2ZpbGUgaWRlbnRpdGllc1wiKTtcbiAgcmV0YWluU3RvcmVSb290cyh7XG4gICAgc3RvcmUsXG4gICAgZGlyZWN0b3J5OiBidWlsZGVyID09PSBcImd1aXhcIiA/IFwiL3Zhci9ndWl4L2djcm9vdHMvd29ya2JlbmNoXCIgOiBcIi9uaXgvdmFyL25peC9nY3Jvb3RzL3dvcmtiZW5jaFwiLFxuICAgIGlucHV0czogcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0lNQUdFX0lOUFVUUyA/PyBcIlwiLFxuICAgIHJldGFpbmVkOiByZXRhaW5lZCBhcyBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgICB0YXJnZXRzLFxuICB9KTtcbiAgaWYgKHByb2Nlc3MuZW52LldPUktCRU5DSF9CVUlMREVSX0dDID09PSBcInRydWVcIikge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB3aXRoTWFuYWdlZFByb2Nlc3Nlcyhhc3luYyAoc2NvcGUpID0+IHtcbiAgICAgICAgYXdhaXQgc2NvcGUucnVuKFxuICAgICAgICAgIGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gXCIvb3B0L3dvcmtiZW5jaC1ndWl4L2Jpbi9ndWl4XCIgOiBcIm5peC1zdG9yZVwiLFxuICAgICAgICAgIGJ1aWxkZXIgPT09IFwiZ3VpeFwiID8gW1wiZ2NcIl0gOiBbXCItLWdjXCJdLFxuICAgICAgICApO1xuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGRpYWdub3N0aWMoXG4gICAgICAgIExvZ0xldmVsLldhcm4sXG4gICAgICAgIERpYWdub3N0aWNPcGVyYXRpb24uQ29tbWFuZCxcbiAgICAgICAgRGlhZ25vc3RpY091dGNvbWUuRmFpbGVkLFxuICAgICAgICB7IGNvbW1hbmQ6IFwicHJpdmF0ZSBidWlsZGVyIHN0b3JlIGNsZWFudXBcIiB9LFxuICAgICAgICBlcnJvcixcbiAgICAgICAgXCJwcmVwYXJlZCBvdXRwdXQgYW5kIGR1cmFibGUgcHJvZmlsZSByb290cyBhcmUgcHJlc2VydmVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG5pZiAoaXNNYWluU2NyaXB0KGltcG9ydC5tZXRhLnVybCkpIHtcbiAgY29uc3QgYnVpbGRlciA9IHByb2Nlc3MuYXJndlsyXTtcbiAgaWYgKGJ1aWxkZXIgIT09IFwiZ3VpeFwiICYmIGJ1aWxkZXIgIT09IFwibml4XCIpIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIG5peCBvciBndWl4IGJ1aWxkZXJcIik7XG4gIGF3YWl0IGNvbGxlY3RQcml2YXRlQnVpbGRlclN0b3JlKGJ1aWxkZXIpO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxvQkFBb0I7QUFDN0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsWUFBWSxNQUFNLFVBQVUsV0FBVztBQUNoRCxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLFlBQVksVUFBVSxxQkFBcUIseUJBQXlCO0FBRTdFLE1BQU0sZ0JBQWdCO0FBSWYsU0FBUyxpQkFBaUIsU0FNeEI7QUFDUCxNQUFJLENBQUMsY0FBYyxLQUFLLFFBQVEsTUFBTSxLQUFLLFFBQVEsVUFBVSxLQUFLLENBQUMsVUFBVSxDQUFDLGNBQWMsS0FBSyxLQUFLLENBQUM7QUFDckcsVUFBTSxJQUFJLE1BQU0sMENBQTBDO0FBQzVELFFBQU0sVUFBVTtBQUFBLElBQ2QsR0FBRyxJQUFJO0FBQUEsTUFDTCxRQUFRLFFBQVEsSUFBSSxDQUFDLFdBQVc7QUFDOUIsY0FBTSxPQUFPLGFBQWEsTUFBTTtBQUNoQyxjQUFNLFFBQVEsU0FB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

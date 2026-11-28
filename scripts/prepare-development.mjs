// Generated from prepare-development.mts; edit the TypeScript source.
import { string } from "../app/src/core/runtime/values.mjs";
import { installImageTools, openImagePreparation } from "./prepare-image-tools.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
const [builder, ...options] = process.argv.slice(2);
if (builder !== "native" && builder !== "nix" && builder !== "guix")
  throw new Error(
    "Use prepare-development.mjs native|nix|guix [--verify|--verify-tools|--tools-only|--dependencies-only|--acquire-only] [--path ROOT]... [--toolchain NAME] [--skip-ci-toolchains]"
  );
const selectedPaths = [];
let toolchain;
let skipCIToolchains = false;
const modes = ["verify", "verify-tools", "tools-only", "dependencies-only", "acquire-only"];
let mode = "prepare";
for (let index = 0; index < options.length; index++) {
  const option = options[index];
  const selected = modes.find((candidate) => option === `--${candidate}`);
  if (selected && mode === "prepare") mode = selected;
  else if (option === "--path" && options[index + 1] && !options[index + 1]?.startsWith("--"))
    selectedPaths.push(string(options[++index], "Missing preparation path"));
  else if (option === "--toolchain" && !toolchain && /^[a-z][a-z0-9_-]*$/.test(options[index + 1] ?? ""))
    toolchain = options[++index];
  else if (option === "--skip-ci-toolchains" && !skipCIToolchains) skipCIToolchains = true;
  else throw new Error(`Invalid preparation option: ${String(option)}`);
}
if (toolchain && builder !== "native") throw new Error("--toolchain selects a native preparation toolchain");
const toolchainArgs = toolchain ? ["--toolchain", toolchain] : [];
const verify = mode === "verify" || mode === "verify-tools";
if (!verify && builder !== "native")
  throw new Error(
    "Managed images are assembled by scripts/prepare-managed-development.mjs from their declared closures"
  );
const preparation = openImagePreparation(!verify);
const { cli, root, run, cancellation } = preparation;
try {
  await run(["project", "add", root]);
  const paths = await preparation.paths(selectedPaths);
  if (!verify && mode !== "dependencies-only" && mode !== "acquire-only" && builder === "native")
    await installImageTools(preparation, paths, toolchain, skipCIToolchains);
  if (mode === "verify-tools") {
    for (const path of paths)
      await run(["shell", "--path", path, "--environment", builder, ...toolchainArgs, "--", "node", "--version"]);
  } else if (mode !== "tools-only") {
    for (const path of paths) {
      console.log(`::group::${verify ? "Offline verification" : "Prepare"}: ${builder} ${path}`);
      const selection = ["--path", path, "--environment", builder, ...toolchainArgs];
      if (!verify) await run(["prepare", ...selection]);
      if (mode !== "acquire-only" && mode !== "dependencies-only")
        await run(["check", ...selection, "--no-cache", "--role", "build", ...verify ? ["--role", "smoke"] : []]);
      console.log("::endgroup::");
    }
    if (builder === "native" && !verify && paths.some((path) => existsSync(join(root, path, "pnpm-lock.yaml")))) {
      const { retainPnpmMetadata } = await import("./pnpm-metadata.mjs");
      await retainPnpmMetadata(root, cli, paths, cancellation.signal);
    }
  }
} finally {
  cancellation.close();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInByZXBhcmUtZGV2ZWxvcG1lbnQubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHN0cmluZyB9IGZyb20gXCIuLi9hcHAvc3JjL2NvcmUvcnVudGltZS92YWx1ZXMubWpzXCI7XG5pbXBvcnQgeyBpbnN0YWxsSW1hZ2VUb29scywgb3BlbkltYWdlUHJlcGFyYXRpb24gfSBmcm9tIFwiLi9wcmVwYXJlLWltYWdlLXRvb2xzLm1qc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyBTaGFyZWQgcmVjaXBlOiBhY3F1aXJlIGRlY2xhcmVkIGlucHV0cywgdGhlbiBwcm92ZSBmcmVzaCBvZmZsaW5lIGJ1aWxkcyBhbmQgc21va2UgZXhlY3V0aW9uLlxuY29uc3QgW2J1aWxkZXIsIC4uLm9wdGlvbnNdID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpO1xuaWYgKGJ1aWxkZXIgIT09IFwibmF0aXZlXCIgJiYgYnVpbGRlciAhPT0gXCJuaXhcIiAmJiBidWlsZGVyICE9PSBcImd1aXhcIilcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFwiVXNlIHByZXBhcmUtZGV2ZWxvcG1lbnQubWpzIG5hdGl2ZXxuaXh8Z3VpeCBbLS12ZXJpZnl8LS12ZXJpZnktdG9vbHN8LS10b29scy1vbmx5fC0tZGVwZW5kZW5jaWVzLW9ubHl8LS1hY3F1aXJlLW9ubHldIFstLXBhdGggUk9PVF0uLi4gWy0tdG9vbGNoYWluIE5BTUVdIFstLXNraXAtY2ktdG9vbGNoYWluc11cIixcbiAgKTtcbmNvbnN0IHNlbGVjdGVkUGF0aHM6IHN0cmluZ1tdID0gW107XG5sZXQgdG9vbGNoYWluOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5sZXQgc2tpcENJVG9vbGNoYWlucyA9IGZhbHNlO1xuY29uc3QgbW9kZXMgPSBbXCJ2ZXJpZnlcIiwgXCJ2ZXJpZnktdG9vbHNcIiwgXCJ0b29scy1vbmx5XCIsIFwiZGVwZW5kZW5jaWVzLW9ubHlcIiwgXCJhY3F1aXJlLW9ubHlcIl0gYXMgY29uc3Q7XG5sZXQgbW9kZTogXCJwcmVwYXJlXCIgfCAodHlwZW9mIG1vZGVzKVtudW1iZXJdID0gXCJwcmVwYXJlXCI7XG5mb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgb3B0aW9ucy5sZW5ndGg7IGluZGV4KyspIHtcbiAgY29uc3Qgb3B0aW9uID0gb3B0aW9uc1tpbmRleF07XG4gIGNvbnN0IHNlbGVjdGVkID0gbW9kZXMuZmluZCgoY2FuZGlkYXRlKSA9PiBvcHRpb24gPT09IGAtLSR7Y2FuZGlkYXRlfWApO1xuICBpZiAoc2VsZWN0ZWQgJiYgbW9kZSA9PT0gXCJwcmVwYXJlXCIpIG1vZGUgPSBzZWxlY3RlZDtcbiAgZWxzZSBpZiAob3B0aW9uID09PSBcIi0tcGF0aFwiICYmIG9wdGlvbnNbaW5kZXggKyAxXSAmJiAhb3B0aW9uc1tpbmRleCArIDFdPy5zdGFydHNXaXRoKFwiLS1cIikpXG4gICAgc2VsZWN0ZWRQYXRocy5wdXNoKHN0cmluZyhvcHRpb25zWysraW5kZXhdLCBcIk1pc3NpbmcgcHJlcGFyYXRpb24gcGF0aFwiKSk7XG4gIGVsc2UgaWYgKG9wdGlvbiA9PT0gXCItLXRvb2xjaGFpblwiICYmICF0b29sY2hhaW4gJiYgL15bYS16XVthLXowLTlfLV0qJC8udGVzdChvcHRpb25zW2luZGV4ICsgMV0gPz8gXCJcIikpXG4gICAgdG9vbGNoYWluID0gb3B0aW9uc1srK2luZGV4XTtcbiAgZWxzZSBpZiAob3B0aW9uID09PSBcIi0tc2tpcC1jaS10b29sY2hhaW5zXCIgJiYgIXNraXBDSVRvb2xjaGFpbnMpIHNraXBDSVRvb2xjaGFpbnMgPSB0cnVlO1xuICBlbHNlIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBwcmVwYXJhdGlvbiBvcHRpb246ICR7U3RyaW5nKG9wdGlvbil9YCk7XG59XG5pZiAodG9vbGNoYWluICYmIGJ1aWxkZXIgIT09IFwibmF0aXZlXCIpIHRocm93IG5ldyBFcnJvcihcIi0tdG9vbGNoYWluIHNlbGVjdHMgYSBuYXRpdmUgcHJlcGFyYXRpb24gdG9vbGNoYWluXCIpO1xuY29uc3QgdG9vbGNoYWluQXJncyA9IHRvb2xjaGFpbiA/IFtcIi0tdG9vbGNoYWluXCIsIHRvb2xjaGFpbl0gOiBbXTtcbmNvbnN0IHZlcmlmeSA9IG1vZGUgPT09IFwidmVyaWZ5XCIgfHwgbW9kZSA9PT0gXCJ2ZXJpZnktdG9vbHNcIjtcbmlmICghdmVyaWZ5ICYmIGJ1aWxkZXIgIT09IFwibmF0aXZlXCIpXG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBcIk1hbmFnZWQgaW1hZ2VzIGFyZSBhc3NlbWJsZWQgYnkgc2NyaXB0cy9wcmVwYXJlLW1hbmFnZWQtZGV2ZWxvcG1lbnQubWpzIGZyb20gdGhlaXIgZGVjbGFyZWQgY2xvc3VyZXNcIixcbiAgKTtcbmNvbnN0IHByZXBhcmF0aW9uID0gb3BlbkltYWdlUHJlcGFyYXRpb24oIXZlcmlmeSk7XG5jb25zdCB7IGNsaSwgcm9vdCwgcnVuLCBjYW5jZWxsYXRpb24gfSA9IHByZXBhcmF0aW9uO1xudHJ5IHtcbiAgYXdhaXQgcnVuKFtcInByb2plY3RcIiwgXCJhZGRcIiwgcm9vdF0pO1xuICBjb25zdCBwYXRocyA9IGF3YWl0IHByZXBhcmF0aW9uLnBhdGhzKHNlbGVjdGVkUGF0aHMpO1xuICBpZiAoIXZlcmlmeSAmJiBtb2RlICE9PSBcImRlcGVuZGVuY2llcy1vbmx5XCIgJiYgbW9kZSAhPT0gXCJhY3F1aXJlLW9ubHlcIiAmJiBidWlsZGVyID09PSBcIm5hdGl2ZVwiKVxuICAgIGF3YWl0IGluc3RhbGxJbWFnZVRvb2xzKHByZXBhcmF0aW9uLCBwYXRocywgdG9vbGNoYWluLCBza2lwQ0lUb29sY2hhaW5zKTtcbiAgaWYgKG1vZGUgPT09IFwidmVyaWZ5LXRvb2xzXCIpIHtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpXG4gICAgICBhd2FpdCBydW4oW1wic2hlbGxcIiwgXCItLXBhdGhcIiwgcGF0aCwgXCItLWVudmlyb25tZW50XCIsIGJ1aWxkZXIsIC4uLnRvb2xjaGFpbkFyZ3MsIFwiLS1cIiwgXCJub2RlXCIsIFwiLS12ZXJzaW9uXCJdKTtcbiAgfSBlbHNlIGlmIChtb2RlICE9PSBcInRvb2xzLW9ubHlcIikge1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBwYXRocykge1xuICAgICAgY29uc29sZS5sb2coYDo6Z3JvdXA6OiR7dmVyaWZ5ID8gXCJPZmZsaW5lIHZlcmlmaWNhdGlvblwiIDogXCJQcmVwYXJlXCJ9OiAke2J1aWxkZXJ9ICR7cGF0aH1gKTtcbiAgICAgIGNvbnN0IHNlbGVjdGlvbiA9IFtcIi0tcGF0aFwiLCBwYXRoLCBcIi0tZW52aXJvbm1lbnRcIiwgYnVpbGRlciwgLi4udG9vbGNoYWluQXJnc107XG4gICAgICBpZiAoIXZlcmlmeSkgYXdhaXQgcnVuKFtcInByZXBhcmVcIiwgLi4uc2VsZWN0aW9uXSk7XG4gICAgICAvLyBPbmUgc2V0dXAgYW5kIGJ1aWxkIHNlc3Npb24gcmV0YWlucyB0aGUgZnJlc2ggb3V0cHV0cyBmb3Igc21va2UgZXhlY3V0aW9uLlxuICAgICAgaWYgKG1vZGUgIT09IFwiYWNxdWlyZS1vbmx5XCIgJiYgbW9kZSAhPT0gXCJkZXBlbmRlbmNpZXMtb25seVwiKVxuICAgICAgICBhd2FpdCBydW4oW1wiY2hlY2tcIiwgLi4uc2VsZWN0aW9uLCBcIi0tbm8tY2FjaGVcIiwgXCItLXJvbGVcIiwgXCJidWlsZFwiLCAuLi4odmVyaWZ5ID8gW1wiLS1yb2xlXCIsIFwic21va2VcIl0gOiBbXSldKTtcbiAgICAgIGNvbnNvbGUubG9nKFwiOjplbmRncm91cDo6XCIpO1xuICAgIH1cblxuICAgIGlmIChidWlsZGVyID09PSBcIm5hdGl2ZVwiICYmICF2ZXJpZnkgJiYgcGF0aHMuc29tZSgocGF0aCkgPT4gZXhpc3RzU3luYyhqb2luKHJvb3QsIHBhdGgsIFwicG5wbS1sb2NrLnlhbWxcIikpKSkge1xuICAgICAgY29uc3QgeyByZXRhaW5QbnBtTWV0YWRhdGEgfSA9IGF3YWl0IGltcG9ydChcIi4vcG5wbS1tZXRhZGF0YS5tanNcIik7XG4gICAgICBhd2FpdCByZXRhaW5QbnBtTWV0YWRhdGEocm9vdCwgY2xpLCBwYXRocywgY2FuY2VsbGF0aW9uLnNpZ25hbCk7XG4gICAgfVxuICB9XG59IGZpbmFsbHkge1xuICBjYW5jZWxsYXRpb24uY2xvc2UoKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsY0FBYztBQUN2QixTQUFTLG1CQUFtQiw0QkFBNEI7QUFDeEQsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBR3JCLE1BQU0sQ0FBQyxTQUFTLEdBQUcsT0FBTyxJQUFJLFFBQVEsS0FBSyxNQUFNLENBQUM7QUFDbEQsSUFBSSxZQUFZLFlBQVksWUFBWSxTQUFTLFlBQVk7QUFDM0QsUUFBTSxJQUFJO0FBQUEsSUFDUjtBQUFBLEVBQ0Y7QUFDRixNQUFNLGdCQUEwQixDQUFDO0FBQ2pDLElBQUk7QUFDSixJQUFJLG1CQUFtQjtBQUN2QixNQUFNLFFBQVEsQ0FBQyxVQUFVLGdCQUFnQixjQUFjLHFCQUFxQixjQUFjO0FBQzFGLElBQUksT0FBMkM7QUFDL0MsU0FBUyxRQUFRLEdBQUcsUUFBUSxRQUFRLFFBQVEsU0FBUztBQUNuRCxRQUFNLFNBQVMsUUFBUSxLQUFLO0FBQzVCLFFBQU0sV0FBVyxNQUFNLEtBQUssQ0FBQyxjQUFjLFdBQVcsS0FBSyxTQUFTLEVBQUU7QUFDdEUsTUFBSSxZQUFZLFNBQVMsVUFBVyxRQUFPO0FBQUEsV0FDbEMsV0FBVyxZQUFZLFFBQVEsUUFBUSxDQUFDLEtBQUssQ0FBQyxRQUFRLFFBQVEsQ0FBQyxHQUFHLFdBQVcsSUFBSTtBQUN4RixrQkFBYyxLQUFLLE9BQU8sUUFBUSxFQUFFLEtBQUssR0FBRywwQkFBMEIsQ0FBQztBQUFBLFdBQ2hFLFdBQVcsaUJBQWlCLENBQUMsYUFBYSxxQkFBcUIsS0FBSyxRQUFRLFFBQVEsQ0FBQyxLQUFLLEVBQUU7QUFDbkcsZ0JBQVksUUFBUSxFQUFFLEtBQUs7QUFBQSxXQUNwQixXQUFXLDBCQUEwQixDQUFDLGlCQUFrQixvQkFBbUI7QUFBQSxNQUMvRSxPQUFNLElBQUksTUFBTSwrQkFBK0IsT0FBTyxNQUFNLENBQUMsRUFBRTtBQUN0RTtBQUNBLElBQUksYUFBYSxZQUFZLFNBQVUsT0FBTSxJQUFJLE1BQU0sb0RBQW9EO0FBQzNHLE1BQU0sZ0JBQWdCLFlBQVksQ0FBQyxlQUFlLFNBQVMsSUFBSSxDQUFDO0FBQ2hFLE1BQU0sU0FBUyxTQUFTLFlBQVksU0FBUztBQUM3QyxJQUFJLENBQUMsVUFBVSxZQUFZO0FBQ3pCLFFBQU0sSUFBSTtBQUFBLElBQ1I7QUFBQSxFQUNGO0FBQ0YsTUFBTSxjQUFjLHFCQUFxQixDQUFDLE1BQU07QUFDaEQsTUFBTSxFQUFFLEtBQUssTUFBTSxLQUFLLGFBQWEsSUFBSTtBQUN6QyxJQUFJO0FBQ0YsUUFBTSxJQUFJLENBQUMsV0FBVyxPQUFPLElBQUksQ0FBQztBQUNsQyxRQUFNLFFBQVEsTUFBTSxZQUFZLE1BQU0sYUFBYTtBQUNuRCxNQUFJLENBQUMsVUFBVSxTQUFTLHVCQUF1QixTQUFTLGtCQUFrQixZQUFZO0FBQ3BGLFVBQU0sa0JBQWtCLGFBQWEsT0FBTyxXQUFXLGdCQUFnQjtBQUN6RSxNQUFJLFNBQVMsZ0JBQWdCO0FBQzNCLGVBQVcsUUFBUTtBQUNqQixZQUFNLElBQUksQ0FBQyxTQUFTLFVBQVUsTUFBTSxpQkFBaUIsU0FBUyxHQUFHLGVBQWUsTUFBTSxRQUFRLFdBQVcsQ0FBQztBQUFBLEVBQzlHLFdBQVcsU0FBUyxjQUFjO0FBQ2hDLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLGNBQVEsSUFBSSxZQUFZLFNBQVMseUJBQXlCLFNBQVMsS0FBSyxPQUFPLElBQUksSUFBSSxFQUFFO0FBQ3pGLFlBQU0sWUFBWSxDQUFDLFVBQVUsTUFBTSxpQkFBaUIsU0FBUyxHQUFHLGFBQWE7QUFDN0UsVUFBSSxDQUFDLE9BQVEsT0FBTSxJQUFJLENBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztBQUVoRCxVQUFJLFNBQVMsa0JBQWtCLFNBQVM7QUFDdEMsY0FBTSxJQUFJLENBQUMsU0FBUyxHQUFHLFdBQVcsY0FBYyxVQUFVLFNBQVMsR0FBSSxTQUFTLENBQUMsVUFBVSxPQUFPLElBQUksQ0FBQyxDQUFFLENBQUM7QUFDNUcsY0FBUSxJQUFJLGNBQWM7QUFBQSxJQUM1QjtBQUVBLFFBQUksWUFBWSxZQUFZLENBQUMsVUFBVSxNQUFNLEtBQUssQ0FBQyxTQUFTLFdBQVcsS0FBSyxNQUFNLE1BQU0sZ0JBQWdCLENBQUMsQ0FBQyxHQUFHO0FBQzNHLFlBQU0sRUFBRSxtQkFBbUIsSUFBSSxNQUFNLE9BQU8scUJBQXFCO0FBQ2pFLFlBQU0sbUJBQW1CLE1BQU0sS0FBSyxPQUFPLGFBQWEsTUFBTTtBQUFBLElBQ2hFO0FBQUEsRUFDRjtBQUNGLFVBQUU7QUFDQSxlQUFhLE1BQU07QUFDckI7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9wcmVwYXJlLWRldmVsb3BtZW50Lm1qcyJ9

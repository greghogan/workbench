// Generated from python-checks.mts; edit the TypeScript source.
import { required } from "../app/src/core/runtime/values.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const role = process.argv[2];
const managed = !!process.env.WORKBENCH_CHECK_INPUTS;
function run(args, capture = false) {
  const child = spawnSync("uv", args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (child.error || child.status !== 0)
    throw new Error(`Python ${String(role)} failed: ${String(child.error ?? child.status)}`);
  return child.stdout;
}
if (role === "setup") {
  if (!managed) run(["sync", "--locked"]);
  else {
    const environment = resolve(process.env.UV_PROJECT_ENVIRONMENT ?? ".venv");
    if (!existsSync(join(environment, "pyvenv.cfg")))
      run(["venv", "--python", process.env.UV_PYTHON ?? "python3", environment]);
    const python = join(environment, "bin/python");
    const builds = resolve(process.env.WORKBENCH_BUILD_DIR ?? "build");
    mkdirSync(builds, { recursive: true });
    const requirements = join(builds, "managed-requirements.txt");
    writeFileSync(
      requirements,
      run(["export", "--locked", "--all-groups", "--no-emit-project", "--format", "requirements-txt"], true)
    );
    run([
      "pip",
      "sync",
      "--python",
      python,
      "--require-hashes",
      "--no-index",
      "--find-links",
      required(process.env.UV_FIND_LINKS, "Missing managed wheel directory"),
      requirements
    ]);
    run([
      "pip",
      "install",
      "--python",
      python,
      "--no-deps",
      "--no-index",
      "--find-links",
      required(process.env.UV_FIND_LINKS, "Missing managed wheel directory"),
      "--editable",
      "."
    ]);
  }
} else {
  const commands = {
    format: ["ruff", "format", "--check", "."],
    "format-write": ["ruff", "format", "."],
    lint: ["ruff", "check", "."],
    type: ["mypy", "src", "tests"],
    test: ["pytest", "--durations=10", "--durations-min=2"],
    coverage: ["pytest", "--cov", "--cov-report=term-missing", "--cov-report=json:coverage/report.json"]
  };
  const command = commands[role ?? ""];
  if (!command) throw new Error(`Unknown Python check role: ${String(role)}`);
  run(["run", "--locked", ...command]);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInB5dGhvbi1jaGVja3MubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkIH0gZnJvbSBcIi4uL2FwcC9zcmMvY29yZS9ydW50aW1lL3ZhbHVlcy5tanNcIjtcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5jb25zdCByb2xlID0gcHJvY2Vzcy5hcmd2WzJdO1xuY29uc3QgbWFuYWdlZCA9ICEhcHJvY2Vzcy5lbnYuV09SS0JFTkNIX0NIRUNLX0lOUFVUUztcbmZ1bmN0aW9uIHJ1bihhcmdzOiBzdHJpbmdbXSwgY2FwdHVyZSA9IGZhbHNlKSB7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd25TeW5jKFwidXZcIiwgYXJncywgeyBzdGRpbzogY2FwdHVyZSA/IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpbmhlcml0XCJdIDogXCJpbmhlcml0XCIsIGVuY29kaW5nOiBcInV0ZjhcIiB9KTtcbiAgaWYgKGNoaWxkLmVycm9yIHx8IGNoaWxkLnN0YXR1cyAhPT0gMClcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFB5dGhvbiAke1N0cmluZyhyb2xlKX0gZmFpbGVkOiAke1N0cmluZyhjaGlsZC5lcnJvciA/PyBjaGlsZC5zdGF0dXMpfWApO1xuICByZXR1cm4gY2hpbGQuc3Rkb3V0O1xufVxuaWYgKHJvbGUgPT09IFwic2V0dXBcIikge1xuICBpZiAoIW1hbmFnZWQpIHJ1bihbXCJzeW5jXCIsIFwiLS1sb2NrZWRcIl0pO1xuICBlbHNlIHtcbiAgICAvLyB1diBleHBvcnRzIHRoZSBjb21taXR0ZWQgZ3JhcGggYW5kIG93bnMgd2hlZWwgc2VsZWN0aW9uLCBoYXNoIGNoZWNrcywgZXh0cmFjdGlvbiwgYW5kIGVkaXRhYmxlIGJ1aWxkcy5cbiAgICAvLyBBIGxvY2tlZCBzeW5jIHVzZXMgcmVnaXN0cnkgVVJMcyBldmVuIHdpdGggLS1maW5kLWxpbmtzOyB0aGUgcGlwIGludGVyZmFjZSBjb25zdW1lcyB0aGUgc2FtZSBoYXNoZXMgbG9jYWxseS5cbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IHJlc29sdmUocHJvY2Vzcy5lbnYuVVZfUFJPSkVDVF9FTlZJUk9OTUVOVCA/PyBcIi52ZW52XCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhqb2luKGVudmlyb25tZW50LCBcInB5dmVudi5jZmdcIikpKVxuICAgICAgcnVuKFtcInZlbnZcIiwgXCItLXB5dGhvblwiLCBwcm9jZXNzLmVudi5VVl9QWVRIT04gPz8gXCJweXRob24zXCIsIGVudmlyb25tZW50XSk7XG4gICAgY29uc3QgcHl0aG9uID0gam9pbihlbnZpcm9ubWVudCwgXCJiaW4vcHl0aG9uXCIpO1xuICAgIGNvbnN0IGJ1aWxkcyA9IHJlc29sdmUocHJvY2Vzcy5lbnYuV09SS0JFTkNIX0JVSUxEX0RJUiA/PyBcImJ1aWxkXCIpO1xuICAgIG1rZGlyU3luYyhidWlsZHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGNvbnN0IHJlcXVpcmVtZW50cyA9IGpvaW4oYnVpbGRzLCBcIm1hbmFnZWQtcmVxdWlyZW1lbnRzLnR4dFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcnVuKFtcImV4cG9ydFwiLCBcIi0tbG9ja2VkXCIsIFwiLS1hbGwtZ3JvdXBzXCIsIFwiLS1uby1lbWl0LXByb2plY3RcIiwgXCItLWZvcm1hdFwiLCBcInJlcXVpcmVtZW50cy10eHRcIl0sIHRydWUpLFxuICAgICk7XG4gICAgcnVuKFtcbiAgICAgIFwicGlwXCIsXG4gICAgICBcInN5bmNcIixcbiAgICAgIFwiLS1weXRob25cIixcbiAgICAgIHB5dGhvbixcbiAgICAgIFwiLS1yZXF1aXJlLWhhc2hlc1wiLFxuICAgICAgXCItLW5vLWluZGV4XCIsXG4gICAgICBcIi0tZmluZC1saW5rc1wiLFxuICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuVVZfRklORF9MSU5LUywgXCJNaXNzaW5nIG1hbmFnZWQgd2hlZWwgZGlyZWN0b3J5XCIpLFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgIF0pO1xuICAgIHJ1bihbXG4gICAgICBcInBpcFwiLFxuICAgICAgXCJpbnN0YWxsXCIsXG4gICAgICBcIi0tcHl0aG9uXCIsXG4gICAgICBweXRob24sXG4gICAgICBcIi0tbm8tZGVwc1wiLFxuICAgICAgXCItLW5vLWluZGV4XCIsXG4gICAgICBcIi0tZmluZC1saW5rc1wiLFxuICAgICAgcmVxdWlyZWQocHJvY2Vzcy5lbnYuVVZfRklORF9MSU5LUywgXCJNaXNzaW5nIG1hbmFnZWQgd2hlZWwgZGlyZWN0b3J5XCIpLFxuICAgICAgXCItLWVkaXRhYmxlXCIsXG4gICAgICBcIi5cIixcbiAgICBdKTtcbiAgfVxufSBlbHNlIHtcbiAgY29uc3QgY29tbWFuZHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHtcbiAgICBmb3JtYXQ6IFtcInJ1ZmZcIiwgXCJmb3JtYXRcIiwgXCItLWNoZWNrXCIsIFwiLlwiXSxcbiAgICBcImZvcm1hdC13cml0ZVwiOiBbXCJydWZmXCIsIFwiZm9ybWF0XCIsIFwiLlwiXSxcbiAgICBsaW50OiBbXCJydWZmXCIsIFwiY2hlY2tcIiwgXCIuXCJdLFxuICAgIHR5cGU6IFtcIm15cHlcIiwgXCJzcmNcIiwgXCJ0ZXN0c1wiXSxcbiAgICB0ZXN0OiBbXCJweXRlc3RcIiwgXCItLWR1cmF0aW9ucz0xMFwiLCBcIi0tZHVyYXRpb25zLW1pbj0yXCJdLFxuICAgIGNvdmVyYWdlOiBbXCJweXRlc3RcIiwgXCItLWNvdlwiLCBcIi0tY292LXJlcG9ydD10ZXJtLW1pc3NpbmdcIiwgXCItLWNvdi1yZXBvcnQ9anNvbjpjb3ZlcmFnZS9yZXBvcnQuanNvblwiXSxcbiAgfTtcbiAgY29uc3QgY29tbWFuZCA9IGNvbW1hbmRzW3JvbGUgPz8gXCJcIl07XG4gIGlmICghY29tbWFuZCkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIFB5dGhvbiBjaGVjayByb2xlOiAke1N0cmluZyhyb2xlKX1gKTtcbiAgcnVuKFtcInJ1blwiLCBcIi0tbG9ja2VkXCIsIC4uLmNvbW1hbmRdKTtcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsWUFBWSxXQUFXLHFCQUFxQjtBQUNyRCxTQUFTLE1BQU0sZUFBZTtBQUU5QixNQUFNLE9BQU8sUUFBUSxLQUFLLENBQUM7QUFDM0IsTUFBTSxVQUFVLENBQUMsQ0FBQyxRQUFRLElBQUk7QUFDOUIsU0FBUyxJQUFJLE1BQWdCLFVBQVUsT0FBTztBQUM1QyxRQUFNLFFBQVEsVUFBVSxNQUFNLE1BQU0sRUFBRSxPQUFPLFVBQVUsQ0FBQyxVQUFVLFFBQVEsU0FBUyxJQUFJLFdBQVcsVUFBVSxPQUFPLENBQUM7QUFDcEgsTUFBSSxNQUFNLFNBQVMsTUFBTSxXQUFXO0FBQ2xDLFVBQU0sSUFBSSxNQUFNLFVBQVUsT0FBTyxJQUFJLENBQUMsWUFBWSxPQUFPLE1BQU0sU0FBUyxNQUFNLE1BQU0sQ0FBQyxFQUFFO0FBQ3pGLFNBQU8sTUFBTTtBQUNmO0FBQ0EsSUFBSSxTQUFTLFNBQVM7QUFDcEIsTUFBSSxDQUFDLFFBQVMsS0FBSSxDQUFDLFFBQVEsVUFBVSxDQUFDO0FBQUEsT0FDakM7QUFHSCxVQUFNLGNBQWMsUUFBUSxRQUFRLElBQUksMEJBQTBCLE9BQU87QUFDekUsUUFBSSxDQUFDLFdBQVcsS0FBSyxhQUFhLFlBQVksQ0FBQztBQUM3QyxVQUFJLENBQUMsUUFBUSxZQUFZLFFBQVEsSUFBSSxhQUFhLFdBQVcsV0FBVyxDQUFDO0FBQzNFLFVBQU0sU0FBUyxLQUFLLGFBQWEsWUFBWTtBQUM3QyxVQUFNLFNBQVMsUUFBUSxRQUFRLElBQUksdUJBQXVCLE9BQU87QUFDakUsY0FBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsVUFBTSxlQUFlLEtBQUssUUFBUSwwQkFBMEI7QUFDNUQ7QUFBQSxNQUNFO0FBQUEsTUFDQSxJQUFJLENBQUMsVUFBVSxZQUFZLGdCQUFnQixxQkFBcUIsWUFBWSxrQkFBa0IsR0FBRyxJQUFJO0FBQUEsSUFDdkc7QUFDQSxRQUFJO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsU0FBUyxRQUFRLElBQUksZUFBZSxpQ0FBaUM7QUFBQSxNQUNyRTtBQUFBLElBQ0YsQ0FBQztBQUNELFFBQUk7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxTQUFTLFFBQVEsSUFBSSxlQUFlLGlDQUFpQztBQUFBLE1BQ3JFO0FBQUEsTUFDQTtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDRixPQUFPO0FBQ0wsUUFBTSxXQUFxQztBQUFBLElBQ3pDLFFBQVEsQ0FBQyxRQUFRLFVBQVUsV0FBVyxHQUFHO0FBQUEsSUFDekMsZ0JBQWdCLENBQUMsUUFBUSxVQUFVLEdBQUc7QUFBQSxJQUN0QyxNQUFNLENBQUMsUUFBUSxTQUFTLEdBQUc7QUFBQSxJQUMzQixNQUFNLENBQUMsUUFBUSxPQUFPLE9BQU87QUFBQSxJQUM3QixNQUFNLENBQUMsVUFBVSxrQkFBa0IsbUJBQW1CO0FBQUEsSUFDdEQsVUFBVSxDQUFDLFVBQVUsU0FBUyw2QkFBNkIsd0NBQXdDO0FBQUEsRUFDckc7QUFDQSxRQUFNLFVBQVUsU0FBUyxRQUFRLEVBQUU7QUFDbkMsTUFBSSxDQUFDLFFBQVMsT0FBTSxJQUFJLE1BQU0sOEJBQThCLE9BQU8sSUFBSSxDQUFDLEVBQUU7QUFDMUUsTUFBSSxDQUFDLE9BQU8sWUFBWSxHQUFHLE9BQU8sQ0FBQztBQUNyQzsiLCJuYW1lcyI6W10sImZpbGUiOiJzY3JpcHRzL3B5dGhvbi1jaGVja3MubWpzIn0=

// Generated from python-checks.mts; edit the TypeScript source.
import { required } from "./values.mjs";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInB5dGhvbi1jaGVja3MubXRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlcXVpcmVkIH0gZnJvbSBcIi4vdmFsdWVzLm1qc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IHJvbGUgPSBwcm9jZXNzLmFyZ3ZbMl07XG5jb25zdCBtYW5hZ2VkID0gISFwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQ0hFQ0tfSU5QVVRTO1xuZnVuY3Rpb24gcnVuKGFyZ3M6IHN0cmluZ1tdLCBjYXB0dXJlID0gZmFsc2UpIHtcbiAgY29uc3QgY2hpbGQgPSBzcGF3blN5bmMoXCJ1dlwiLCBhcmdzLCB7IHN0ZGlvOiBjYXB0dXJlID8gW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImluaGVyaXRcIl0gOiBcImluaGVyaXRcIiwgZW5jb2Rpbmc6IFwidXRmOFwiIH0pO1xuICBpZiAoY2hpbGQuZXJyb3IgfHwgY2hpbGQuc3RhdHVzICE9PSAwKVxuICAgIHRocm93IG5ldyBFcnJvcihgUHl0aG9uICR7U3RyaW5nKHJvbGUpfSBmYWlsZWQ6ICR7U3RyaW5nKGNoaWxkLmVycm9yID8/IGNoaWxkLnN0YXR1cyl9YCk7XG4gIHJldHVybiBjaGlsZC5zdGRvdXQ7XG59XG5pZiAocm9sZSA9PT0gXCJzZXR1cFwiKSB7XG4gIGlmICghbWFuYWdlZCkgcnVuKFtcInN5bmNcIiwgXCItLWxvY2tlZFwiXSk7XG4gIGVsc2Uge1xuICAgIC8vIHV2IGV4cG9ydHMgdGhlIGNvbW1pdHRlZCBncmFwaCBhbmQgb3ducyB3aGVlbCBzZWxlY3Rpb24sIGhhc2ggY2hlY2tzLCBleHRyYWN0aW9uLCBhbmQgZWRpdGFibGUgYnVpbGRzLlxuICAgIC8vIEEgbG9ja2VkIHN5bmMgdXNlcyByZWdpc3RyeSBVUkxzIGV2ZW4gd2l0aCAtLWZpbmQtbGlua3M7IHRoZSBwaXAgaW50ZXJmYWNlIGNvbnN1bWVzIHRoZSBzYW1lIGhhc2hlcyBsb2NhbGx5LlxuICAgIGNvbnN0IGVudmlyb25tZW50ID0gcmVzb2x2ZShwcm9jZXNzLmVudi5VVl9QUk9KRUNUX0VOVklST05NRU5UID8/IFwiLnZlbnZcIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKGpvaW4oZW52aXJvbm1lbnQsIFwicHl2ZW52LmNmZ1wiKSkpXG4gICAgICBydW4oW1widmVudlwiLCBcIi0tcHl0aG9uXCIsIHByb2Nlc3MuZW52LlVWX1BZVEhPTiA/PyBcInB5dGhvbjNcIiwgZW52aXJvbm1lbnRdKTtcbiAgICBjb25zdCBweXRob24gPSBqb2luKGVudmlyb25tZW50LCBcImJpbi9weXRob25cIik7XG4gICAgY29uc3QgYnVpbGRzID0gcmVzb2x2ZShwcm9jZXNzLmVudi5XT1JLQkVOQ0hfQlVJTERfRElSID8/IFwiYnVpbGRcIik7XG4gICAgbWtkaXJTeW5jKGJ1aWxkcywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgcmVxdWlyZW1lbnRzID0gam9pbihidWlsZHMsIFwibWFuYWdlZC1yZXF1aXJlbWVudHMudHh0XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICByZXF1aXJlbWVudHMsXG4gICAgICBydW4oW1wiZXhwb3J0XCIsIFwiLS1sb2NrZWRcIiwgXCItLWFsbC1ncm91cHNcIiwgXCItLW5vLWVtaXQtcHJvamVjdFwiLCBcIi0tZm9ybWF0XCIsIFwicmVxdWlyZW1lbnRzLXR4dFwiXSwgdHJ1ZSksXG4gICAgKTtcbiAgICBydW4oW1xuICAgICAgXCJwaXBcIixcbiAgICAgIFwic3luY1wiLFxuICAgICAgXCItLXB5dGhvblwiLFxuICAgICAgcHl0aG9uLFxuICAgICAgXCItLXJlcXVpcmUtaGFzaGVzXCIsXG4gICAgICBcIi0tbm8taW5kZXhcIixcbiAgICAgIFwiLS1maW5kLWxpbmtzXCIsXG4gICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5VVl9GSU5EX0xJTktTLCBcIk1pc3NpbmcgbWFuYWdlZCB3aGVlbCBkaXJlY3RvcnlcIiksXG4gICAgICByZXF1aXJlbWVudHMsXG4gICAgXSk7XG4gICAgcnVuKFtcbiAgICAgIFwicGlwXCIsXG4gICAgICBcImluc3RhbGxcIixcbiAgICAgIFwiLS1weXRob25cIixcbiAgICAgIHB5dGhvbixcbiAgICAgIFwiLS1uby1kZXBzXCIsXG4gICAgICBcIi0tbm8taW5kZXhcIixcbiAgICAgIFwiLS1maW5kLWxpbmtzXCIsXG4gICAgICByZXF1aXJlZChwcm9jZXNzLmVudi5VVl9GSU5EX0xJTktTLCBcIk1pc3NpbmcgbWFuYWdlZCB3aGVlbCBkaXJlY3RvcnlcIiksXG4gICAgICBcIi0tZWRpdGFibGVcIixcbiAgICAgIFwiLlwiLFxuICAgIF0pO1xuICB9XG59IGVsc2Uge1xuICBjb25zdCBjb21tYW5kczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge1xuICAgIGZvcm1hdDogW1wicnVmZlwiLCBcImZvcm1hdFwiLCBcIi0tY2hlY2tcIiwgXCIuXCJdLFxuICAgIFwiZm9ybWF0LXdyaXRlXCI6IFtcInJ1ZmZcIiwgXCJmb3JtYXRcIiwgXCIuXCJdLFxuICAgIGxpbnQ6IFtcInJ1ZmZcIiwgXCJjaGVja1wiLCBcIi5cIl0sXG4gICAgdHlwZTogW1wibXlweVwiLCBcInNyY1wiLCBcInRlc3RzXCJdLFxuICAgIHRlc3Q6IFtcInB5dGVzdFwiLCBcIi0tZHVyYXRpb25zPTEwXCIsIFwiLS1kdXJhdGlvbnMtbWluPTJcIl0sXG4gICAgY292ZXJhZ2U6IFtcInB5dGVzdFwiLCBcIi0tY292XCIsIFwiLS1jb3YtcmVwb3J0PXRlcm0tbWlzc2luZ1wiLCBcIi0tY292LXJlcG9ydD1qc29uOmNvdmVyYWdlL3JlcG9ydC5qc29uXCJdLFxuICB9O1xuICBjb25zdCBjb21tYW5kID0gY29tbWFuZHNbcm9sZSA/PyBcIlwiXTtcbiAgaWYgKCFjb21tYW5kKSB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gUHl0aG9uIGNoZWNrIHJvbGU6ICR7U3RyaW5nKHJvbGUpfWApO1xuICBydW4oW1wicnVuXCIsIFwiLS1sb2NrZWRcIiwgLi4uY29tbWFuZF0pO1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxZQUFZLFdBQVcscUJBQXFCO0FBQ3JELFNBQVMsTUFBTSxlQUFlO0FBRTlCLE1BQU0sT0FBTyxRQUFRLEtBQUssQ0FBQztBQUMzQixNQUFNLFVBQVUsQ0FBQyxDQUFDLFFBQVEsSUFBSTtBQUM5QixTQUFTLElBQUksTUFBZ0IsVUFBVSxPQUFPO0FBQzVDLFFBQU0sUUFBUSxVQUFVLE1BQU0sTUFBTSxFQUFFLE9BQU8sVUFBVSxDQUFDLFVBQVUsUUFBUSxTQUFTLElBQUksV0FBVyxVQUFVLE9BQU8sQ0FBQztBQUNwSCxNQUFJLE1BQU0sU0FBUyxNQUFNLFdBQVc7QUFDbEMsVUFBTSxJQUFJLE1BQU0sVUFBVSxPQUFPLElBQUksQ0FBQyxZQUFZLE9BQU8sTUFBTSxTQUFTLE1BQU0sTUFBTSxDQUFDLEVBQUU7QUFDekYsU0FBTyxNQUFNO0FBQ2Y7QUFDQSxJQUFJLFNBQVMsU0FBUztBQUNwQixNQUFJLENBQUMsUUFBUyxLQUFJLENBQUMsUUFBUSxVQUFVLENBQUM7QUFBQSxPQUNqQztBQUdILFVBQU0sY0FBYyxRQUFRLFFBQVEsSUFBSSwwQkFBMEIsT0FBTztBQUN6RSxRQUFJLENBQUMsV0FBVyxLQUFLLGFBQWEsWUFBWSxDQUFDO0FBQzdDLFVBQUksQ0FBQyxRQUFRLFlBQVksUUFBUSxJQUFJLGFBQWEsV0FBVyxXQUFXLENBQUM7QUFDM0UsVUFBTSxTQUFTLEtBQUssYUFBYSxZQUFZO0FBQzdDLFVBQU0sU0FBUyxRQUFRLFFBQVEsSUFBSSx1QkFBdUIsT0FBTztBQUNqRSxjQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQyxVQUFNLGVBQWUsS0FBSyxRQUFRLDBCQUEwQjtBQUM1RDtBQUFBLE1BQ0U7QUFBQSxNQUNBLElBQUksQ0FBQyxVQUFVLFlBQVksZ0JBQWdCLHFCQUFxQixZQUFZLGtCQUFrQixHQUFHLElBQUk7QUFBQSxJQUN2RztBQUNBLFFBQUk7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxTQUFTLFFBQVEsSUFBSSxlQUFlLGlDQUFpQztBQUFBLE1BQ3JFO0FBQUEsSUFDRixDQUFDO0FBQ0QsUUFBSTtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFNBQVMsUUFBUSxJQUFJLGVBQWUsaUNBQWlDO0FBQUEsTUFDckU7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNGLE9BQU87QUFDTCxRQUFNLFdBQXFDO0FBQUEsSUFDekMsUUFBUSxDQUFDLFFBQVEsVUFBVSxXQUFXLEdBQUc7QUFBQSxJQUN6QyxnQkFBZ0IsQ0FBQyxRQUFRLFVBQVUsR0FBRztBQUFBLElBQ3RDLE1BQU0sQ0FBQyxRQUFRLFNBQVMsR0FBRztBQUFBLElBQzNCLE1BQU0sQ0FBQyxRQUFRLE9BQU8sT0FBTztBQUFBLElBQzdCLE1BQU0sQ0FBQyxVQUFVLGtCQUFrQixtQkFBbUI7QUFBQSxJQUN0RCxVQUFVLENBQUMsVUFBVSxTQUFTLDZCQUE2Qix3Q0FBd0M7QUFBQSxFQUNyRztBQUNBLFFBQU0sVUFBVSxTQUFTLFFBQVEsRUFBRTtBQUNuQyxNQUFJLENBQUMsUUFBUyxPQUFNLElBQUksTUFBTSw4QkFBOEIsT0FBTyxJQUFJLENBQUMsRUFBRTtBQUMxRSxNQUFJLENBQUMsT0FBTyxZQUFZLEdBQUcsT0FBTyxDQUFDO0FBQ3JDOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvcHl0aG9uLWNoZWNrcy5tanMifQ==

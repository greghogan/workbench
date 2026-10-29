import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = resolve(process.argv[3] ?? process.cwd());
const artifacts = resolve(process.argv[2] ?? process.env.WORKBENCH_DIST_DIR ?? join(root, "dist"), "count");
const temporary = mkdtempSync(join(tmpdir(), "workbench release check-"));
function execute(command: string, args: readonly string[], cwd = temporary) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsVerbatimArguments: command === "cmd.exe",
  });
  if (result.error) throw new Error(`Release artifact cannot run: ${String(result.error)}`);
  assert.notEqual(result.status, null, `Release artifact terminated by ${String(result.signal)}`);
  return result;
}
function run(command: string, args: readonly string[], cwd = temporary) {
  const result = execute(command, args, cwd);
  if (result.status !== 0) throw new Error(`Release artifact check failed: ${result.stderr || String(result.status)}`);
  return result.stdout;
}
function artifact(extension: string) {
  const matches = readdirSync(artifacts).filter((name) => name.endsWith(extension));
  assert.equal(matches.length, 1, `expected one ${extension} artifact`);
  const [match] = matches;
  assert.ok(match, `missing ${extension} artifact`);
  return join(artifacts, match);
}
try {
  cpSync(artifacts, temporary, { recursive: true });
  const jar = join(temporary, "count.jar");
  artifact(".jar");
  const distribution = process.argv[4] ?? process.env.WORKBENCH_DISTRIBUTION_ROOT;
  if (!distribution) throw new Error("Release verification needs the selected Workbench distribution");
  const { decodeJavaRuntime, javaRuntimeArguments } = createRequire(import.meta.url)(
    join(distribution, "bundle/package.cjs"),
  ) as typeof import("../../../../src/java-release.js");
  const runtime = decodeJavaRuntime(JSON.parse(readFileSync(join(temporary, "runtime.json"), "utf8")), true);
  const flags = javaRuntimeArguments(runtime);
  if (runtime.kind === "library") {
    const consumer = join(temporary, "Consumer.java");
    writeFileSync(
      consumer,
      "import org.example.workbench.Count; class Consumer { public static void main(String[] args) { System.out.println(new Count().countByte(new byte[]{97, 0, 97}, 97)); } }\n",
    );
    run("javac", ["-cp", jar, "-d", temporary, consumer]);
    assert.equal(run("java", [...flags, "-cp", `${temporary}${delimiter}${jar}`, "Consumer"]).trim(), "2");
  } else {
    assert.equal(run("java", [...flags, "-jar", jar, "97", "banana"]).trim(), "3");
    const launcher = (byte: string, text: string) =>
      process.platform === "win32"
        ? execute("cmd.exe", ["/d", "/s", "/c", `""${join(temporary, "run.cmd")}" ${byte} "${text}""`])
        : execute(join(temporary, "run"), [byte, text]);
    for (const [text, expected] of [
      ["banana", "3"],
      ["ba na na", "3"],
      ["", "0"],
    ] as const) {
      const result = launcher("97", text);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
    }
    assert.equal(run("java", [...flags, "-jar", jar, "97", ""]).trim(), "0");
    const invalid = execute("java", [...flags, "-jar", jar, "256", "banana"]);
    assert.notEqual(invalid.status, 0);
    assert.equal(launcher("256", "banana").status, invalid.status, "Launcher must preserve Java's exit status");
  }

  console.log(`Verified release artifacts from ${root} outside the source checkout.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

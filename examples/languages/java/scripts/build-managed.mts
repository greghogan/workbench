import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

// The POM owns the language target and executable entry point for every builder.
const pom = readFileSync("pom.xml", "utf8");
const target = /<maven\.compiler\.release>(\d+)<\/maven\.compiler\.release>/.exec(pom)?.[1];
const main = /<mainClass>([\w.]+)<\/mainClass>/.exec(pom)?.[1];
if (!target || !main) throw new Error("The POM must declare a release target and main class");
const directory = "src/main/java";
const sources = readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".java"));
mkdirSync("build/classes", { recursive: true });
function run(command: string, args: readonly string[]) {
  const child = spawnSync(command, args, { stdio: "inherit" });
  if (child.error || child.status !== 0) throw new Error(`${command} failed: ${String(child.error ?? child.status)}`);
}
run("javac", [
  "--release",
  target,
  "-Xlint:all",
  "-Werror",
  "-d",
  "build/classes",
  ...sources.map((name) => join(directory, name)),
]);
mkdirSync("build/classes/META-INF", { recursive: true });
copyFileSync("LICENSE", "build/classes/META-INF/LICENSE");
run("jar", ["--create", "--file", "build/count.jar", "--main-class", main, "-C", "build/classes", "."]);

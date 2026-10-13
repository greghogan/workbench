import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[3]) throw new Error("Supply the pinned Workbench directory through the configured command");
const distribution = resolve(process.argv[3]);
const { cpuBudget } = await import(pathToFileURL(join(distribution, "scripts/cpu-budget.mjs")).href);
const { writeJavaCoverage } = await import(pathToFileURL(join(distribution, "scripts/java-coverage.mjs")).href);

const role = process.argv[2];
const goals = {
  setup: ["validate"],
  "dependency-lock": [
    "spotless:check",
    "-Pcoverage",
    "test",
    "jacoco:report",
    "jacoco:check",
    "spotbugs:check",
    "package",
  ],
  format: ["spotless:check"],
  "format-write": ["spotless:apply"],
  type: ["compile"],
  lint: ["compile", "spotbugs:check"],
  test: ["test"],
  coverage: ["-Pcoverage", "test", "jacoco:report", "jacoco:check"],
  build: ["package", "-DskipTests"],
  release: ["package", "-DskipTests"],
};
if (!Object.hasOwn(goals, role)) throw new Error(`Unknown Java check: ${role}`);
const source = process.cwd();
const stage = resolve(process.env.WORKBENCH_BUILD_DIR ?? "build", "java");
const repository = process.env.WORKBENCH_MAVEN_REPOSITORY;
if (!repository) throw new Error("Java checks require WORKBENCH_MAVEN_REPOSITORY; use a configured Workbench command");
const checksumFile = ".mvn/checksums/checksums.sha256";
if (role !== "dependency-lock" && !existsSync(checksumFile))
  throw new Error("Generate and review Maven trusted checksums before frozen checks");
if (existsSync(stage) && lstatSync(stage).isSymbolicLink()) throw new Error("Java staging must be a real directory");
mkdirSync(stage, { recursive: true });
for (const name of ["pom.xml", ".mvn", "src"]) {
  rmSync(join(stage, name), { recursive: true, force: true });
  cpSync(join(source, name), join(stage, name), { recursive: true, preserveTimestamps: true });
}
const build = join(stage, "target");
// Deleted sources and a different selected JDK must never leave stale classes or test evidence.
for (const name of ["classes", "test-classes", "surefire-reports", "jacoco.exec", "site/jacoco"])
  rmSync(join(build, name), { recursive: true, force: true });
if (role === "dependency-lock") rmSync(join(stage, ".mvn/checksums"), { recursive: true, force: true });
const cpus = cpuBudget();
const args = [
  "--batch-mode",
  "--strict-checksums",
  "--no-transfer-progress",
  "-T",
  String(cpus),
  `-Dmaven.repo.local=${repository}`,
  `-Dworkbench.build=${build}`,
  `-Dworkbench.cpus=${cpus}`,
  `-Daether.trustedChecksumsSource.summaryFile.basedir=${join(stage, ".mvn/checksums")}`,
  ...(role === "dependency-lock" ? ["-Daether.artifactResolver.postProcessor.trustedChecksums.record=true"] : []),
  ...goals[role],
];
const result = spawnSync("sh", ["-c", 'exec mvn "$@"', "workbench-maven", ...args], {
  cwd: stage,
  stdio: "inherit",
  env: { ...process.env, MAVEN_OPTS: `${process.env.MAVEN_OPTS ?? ""} -XX:ActiveProcessorCount=${cpus}` },
});
if (["test", "coverage"].includes(role)) {
  const reports = join(build, "surefire-reports");
  if (existsSync(reports)) {
    mkdirSync("coverage", { recursive: true });
    cpSync(reports, "coverage/surefire", { recursive: true });
  }
}
const report = join(build, "site/jacoco/jacoco.xml");
if (role === "coverage" && existsSync(report)) writeJavaCoverage(readFileSync(report, "utf8"), source);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Maven ${role} failed (exit ${result.status ?? "unknown"})`);
if (role === "dependency-lock") {
  mkdirSync(join(source, ".mvn/checksums"), { recursive: true });
  cpSync(join(stage, checksumFile), join(source, checksumFile));
  chmodSync(join(source, checksumFile), 0o644);
}
if (role === "format-write") cpSync(join(stage, "src"), join(source, "src"), { recursive: true });
if (role === "release") {
  const output = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? "dist");
  mkdirSync(output, { recursive: true });
  cpSync(join(build, "count.jar"), join(output, "count.jar"));
}

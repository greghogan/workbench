import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { zip } from "./fixtures/zip.mts";
import {
  javaManifest,
  javaRuntimeClosure,
  javaRuntime,
  javaRuntimeArguments,
  decodeJavaRuntime,
  packageJavaRelease,
} from "../src/java-release.ts";
import { mavenDigest } from "../src/maven-artifacts.ts";

test("runtime configuration and distribution metadata share strict Java names and argument construction", () => {
  expect(decodeJavaRuntime({ kind: "library" })).toEqual({ kind: "library", modules: [], nativeAccess: [] });
  const runtime = { kind: "application", nativeAccess: ["ALL-UNNAMED", "java.sql"], modules: ["java.sql"] };
  expect(javaRuntimeArguments(decodeJavaRuntime(runtime))).toEqual([
    "--enable-native-access=ALL-UNNAMED,java.sql",
    "--add-modules=java.sql",
  ]);
  expect(decodeJavaRuntime({ ...runtime, artifacts: [] }, true)).toEqual(runtime);
  for (const value of [
    null,
    [],
    {},
    { kind: "other" },
    { ...runtime, artifacts: [] },
    { ...runtime, modules: ["ALL-UNNAMED"] },
    { ...runtime, modules: ["java.sql", "java.sql"] },
    { ...runtime, modules: ["java..sql"] },
    { ...runtime, nativeAccess: null },
    { ...runtime, nativeAccess: "java.sql" },
    { ...runtime, nativeAccess: ["ALL-UNNAMED; injected"] },
  ])
    expect(() => decodeJavaRuntime(value)).toThrow(/Java runtime/);
});

test("Java releases copy the complete Maven runtime closure and licenses into independent regular files", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-release-"));
  try {
    const repository = join(root, "repository"),
      output = join(root, "dist/app");
    mkdirSync(join(root, ".mvn/checksums"), { recursive: true });
    const dependencies = [
      "org/example/first/1/first-1.jar",
      "org/vendor/transitive/2/transitive-2-linux.jar",
      "org/vendor/transitive/2/transitive-2-windows.jar",
    ];
    const index = new Map<string, string>();
    for (const [position, path] of dependencies.entries()) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      const bytes = zip([{ name: "META-INF/LICENSE", content: `Upstream license ${String(position)}` }]);
      const original = join(root, `original-${String(position)}.jar`);
      writeFileSync(original, bytes);
      if (process.platform !== "win32") symlinkSync(original, join(repository, path));
      else writeFileSync(join(repository, path), bytes);
      const pom = path.replace(/\/[^/]+\.jar$/, `/${position === 0 ? "first-1" : "transitive-2"}.pom`);
      const declaration = "<project><licenses><license><name>Upstream license</name></license></licenses></project>";
      writeFileSync(join(repository, pom), declaration);
      index.set(path, mavenDigest(bytes));
      index.set(pom, mavenDigest(Buffer.from(declaration)));
    }
    writeFileSync(
      join(root, ".mvn/checksums/checksums.sha256"),
      [...index].map(([path, hash]) => `${hash}  ${path}\n`).join(""),
    );
    writeFileSync(
      join(root, ".mvn/runtime.json"),
      JSON.stringify({ kind: "application", nativeAccess: ["ALL-UNNAMED"], modules: ["java.sql"] }),
    );
    const jar = join(root, "app.jar");
    const manifest = `Manifest-Version: 1.0\r\nMain-Class: example.Main\r\nClass-Path: lib/${dependencies[0] ?? ""}\r\n lib/${dependencies[1] ?? ""} lib/${dependencies[2] ?? ""}\r\n\r\n`;
    // The folded space remains part of the logical class path.
    writeFileSync(jar, zip([{ name: "META-INF/MANIFEST.MF", content: manifest.replace("\r\n lib/", " \r\n lib/") }]));
    await packageJavaRelease(root, jar, repository, output);
    expect(javaRuntimeClosure(await javaManifest(join(output, "app.jar")))).toEqual(dependencies);
    for (const path of dependencies) {
      expect(lstatSync(join(output, "lib", path)).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(output, "lib", path))).toEqual(readFileSync(join(repository, path)));
    }
    expect(readFileSync(join(output, "run"), "utf8")).toContain(
      "--enable-native-access=ALL-UNNAMED --add-modules=java.sql",
    );
    expect(readFileSync(join(output, "run.cmd"), "utf8")).toContain("%~dp0");
    expect(javaRuntimeArguments(javaRuntime(root))).toEqual([
      "--enable-native-access=ALL-UNNAMED",
      "--add-modules=java.sql",
    ]);
    const metadata = JSON.parse(readFileSync(join(output, "runtime.json"), "utf8")) as {
      artifacts: { path: string; sha256: string; pom: string }[];
    };
    expect(metadata.artifacts).toEqual(
      dependencies.map((path, position) => ({
        path: `lib/${path}`,
        sha256: index.get(path),
        pom: `lib/${position === 0 ? "org/example/first/1/first-1.pom" : "org/vendor/transitive/2/transitive-2.pom"}`,
      })),
    );
    for (const entry of metadata.artifacts)
      expect(readFileSync(join(output, entry.pom), "utf8")).toContain("<licenses>");
    const before = readFileSync(join(output, "runtime.json"));
    writeFileSync(join(repository, dependencies[0] ?? ""), "corrupt cached artifact");
    await expect(packageJavaRelease(root, jar, repository, output)).rejects.toThrow(/checksum mismatch/);
    expect(readFileSync(join(output, "runtime.json"))).toEqual(before);
    writeFileSync(
      jar,
      zip([{ name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\nMain-Class: example.Main\n\n" }]),
    );
    await packageJavaRelease(root, jar, repository, output);
    expect(existsSync(join(output, "lib"))).toBe(false);
    expect(existsSync(join(root, "original-1.jar"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Java manifests reject unsafe runtime paths, duplicates, and oversized metadata", async () => {
  for (const path of [
    "../escape.jar",
    "https://example.com/a.jar",
    "lib/../../escape.jar",
    "lib/org/example/a/1/a-1.pom",
  ])
    expect(() => javaRuntimeClosure(new Map([["class-path", path]]))).toThrow();
  const root = mkdtempSync(join(tmpdir(), "workbench-java-manifest-"));
  try {
    const jar = join(root, "app.jar");
    for (const entries of [
      [],
      [{ name: "META-INF/MANIFEST.MF", content: "x".repeat(65537) }],
      [{ name: "META-INF/MANIFEST.MF" }, { name: "META-INF/MANIFEST.MF" }],
    ]) {
      writeFileSync(jar, zip(entries));
      await expect(javaManifest(jar)).rejects.toThrow(/manifest/i);
    }
    mkdirSync(join(root, ".mvn"));
    writeFileSync(join(root, ".mvn/runtime.json"), '{"kind":"application","nativeAccess":["ALL-UNNAMED; injected"]}');
    expect(() => javaRuntime(root)).toThrow(/Java runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thin library releases omit launchers and reject an application classpath", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-library-"));
  try {
    mkdirSync(join(root, ".mvn/checksums"), { recursive: true });
    writeFileSync(join(root, ".mvn/checksums/checksums.sha256"), "");
    writeFileSync(join(root, ".mvn/runtime.json"), '{"kind":"library"}');
    const jar = join(root, "library.jar"),
      output = join(root, "dist/library");
    writeFileSync(jar, zip([{ name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\n\n" }]));
    await packageJavaRelease(root, jar, join(root, "repository"), output);
    expect(existsSync(join(output, "library.jar"))).toBe(true);
    expect(existsSync(join(output, "run"))).toBe(false);
    expect(existsSync(join(output, "run.cmd"))).toBe(false);
    writeFileSync(
      jar,
      zip([
        { name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\nClass-Path: lib/org/example/a/1/a-1.jar\n\n" },
      ]),
    );
    await expect(packageJavaRelease(root, jar, join(root, "repository"), output)).rejects.toThrow(
      /Thin Java libraries/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Java release launchers preserve arguments and exit status after relocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench java launcher-"));
  try {
    const project = join(root, "source");
    mkdirSync(join(project, ".mvn/checksums"), { recursive: true });
    writeFileSync(join(project, ".mvn/checksums/checksums.sha256"), "");
    writeFileSync(
      join(project, ".mvn/runtime.json"),
      JSON.stringify({ kind: "application", nativeAccess: ["ALL-UNNAMED"], modules: ["java.sql"] }),
    );
    const jar = join(project, "app.jar"),
      output = join(root, "relocated application");
    writeFileSync(
      jar,
      zip([{ name: "META-INF/MANIFEST.MF", content: "Manifest-Version: 1.0\nMain-Class: example.Main\n\n" }]),
    );
    await packageJavaRelease(project, jar, join(root, "repository"), output);
    const bin = join(root, "test java");
    mkdirSync(bin);
    const capture = join(bin, "capture.cjs");
    writeFileSync(
      capture,
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = process.argv.at(-2) === "256" ? 23 : 0;\n',
    );
    if (process.platform === "win32")
      writeFileSync(join(bin, "java.cmd"), `@echo off\r\n"${process.execPath}" "${capture}" %*\r\n`);
    else writeFileSync(join(bin, "java"), `#!/bin/sh\nexec "${process.execPath}" "${capture}" "$@"\n`, { mode: 0o755 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") Reflect.deleteProperty(env, key);
    const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    env.PATH = [bin, ...(process.platform === "win32" ? [system] : ["/usr/bin", "/bin"])].join(delimiter);
    for (const [byte, text, status] of [
      ["97", "ba na na", 0],
      ["97", "", 0],
      ["256", "banana", 23],
    ] as const) {
      const result =
        process.platform === "win32"
          ? spawnSync(join(system, "cmd.exe"), ["/d", "/s", "/c", `""${join(output, "run.cmd")}" ${byte} "${text}""`], {
              cwd: root,
              env,
              encoding: "utf8",
              windowsVerbatimArguments: true,
            })
          : spawnSync(join(output, "run"), [byte, text], { cwd: root, env, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(status);
      const argv = JSON.parse(result.stdout) as string[];
      expect(argv.slice(0, 3)).toEqual(["--enable-native-access=ALL-UNNAMED", "--add-modules=java.sql", "-jar"]);
      const selectedJar = argv[3];
      if (!selectedJar) throw new Error("Launcher omitted the relocated JAR path");
      expect(realpathSync(selectedJar)).toBe(realpathSync(join(output, "app.jar")));
      expect(argv.slice(4)).toEqual([byte, text]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

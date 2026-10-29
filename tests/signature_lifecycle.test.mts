import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, expect, test, vi } from "vitest";
import tar from "tar-stream";
import * as owned from "../scripts/owned-child.mjs";
import * as native from "../src/native-tools.ts";
import * as execution from "../src/tool-execution.ts";
import { describeError } from "../scripts/diagnostic-errors.mjs";
import { signatureVerifier } from "../src/artifact-signatures.ts";
import { download, type ToolAsset } from "../src/tool-downloads.ts";
import { extractFilteredArtifact } from "../src/filtered-artifacts.ts";
import { prepareMavenDependencies } from "../src/maven-acquisition.ts";
import { required } from "../src/invariants.ts";

vi.mock("../scripts/owned-child.mjs", async (original) => ({
  ...(await original<typeof import("../scripts/owned-child.mjs")>()),
  captureOwnedChild: vi.fn(),
  runOwnedChild: vi.fn(),
}));

const roots: string[] = [],
  homes: string[] = [];
const actualFetch = globalThis.fetch;
const signer = "A".repeat(40);
const signature = { url: "https://tools.example/artifact.sig", keys: "fixture public keys", signers: [signer] };
const valid = `[GNUPG:] GOODSIG ${signer.slice(-16)} Fixture\n[GNUPG:] VALIDSIG ${signer} 2026-01-01 1767225600 0 4 0 1 10 00 ${signer}\n`;
const success = { pid: 123, status: 0, signal: null } as const;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(owned.captureOwnedChild).mockReset();
  vi.mocked(owned.runOwnedChild).mockReset();
  for (const path of [...homes.splice(0), ...roots.splice(0)]) rmSync(path, { recursive: true, force: true });
});

async function fixture(mode: "success" | "known-failure" | "unproven-setup" | "unproven-verify" | "unproven-maven") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-signature-lifecycle-")));
  roots.push(root);
  const pack = tar.pack();
  pack.entry({ name: "sdk/bin/compiler", mode: 0o755 }, "compiler");
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const asset: ToolAsset = {
    url: "https://tools.example/sdk.tar",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    format: "tar",
    strip: 1,
    bin: "bin",
    signature,
  };
  vi.stubEnv("WORKBENCH_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("WORKBENCH_STATE_HOME", join(root, "state"));
  vi.stubEnv("WORKBENCH_DISTRIBUTION_ROOT", resolve(import.meta.dirname, ".."));
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://127.0.0.1:")) return actualFetch(input, options);
    return Promise.resolve(new Response(url.endsWith(".sig") || url.endsWith(".asc") ? "detached signature" : bytes));
  });
  vi.spyOn(native, "nativeEnvironment").mockReturnValue({ ...process.env });
  vi.spyOn(execution, "commandInvocation").mockImplementation((command, args) => [command, ...args]);
  vi.mocked(owned.captureOwnedChild).mockImplementation((_command, _args, options) => {
    homes.push(options.cwd);
    return Promise.resolve({
      ...success,
      stdout: "",
      stderr: "",
      ...(mode === "unproven-setup"
        ? { status: 1, descendantsActive: true, error: new Error("unconfirmed child group") }
        : mode === "known-failure"
          ? { status: 1, error: new Error("invalid public key") }
          : {}),
    });
  });
  vi.mocked(owned.runOwnedChild).mockImplementation(async (command, args, options) => {
    if (command === "mvn") {
      if (mode === "unproven-maven")
        return { ...success, descendantsActive: true, error: new Error("unconfirmed Maven group") };
      const settings = readFileSync(required(args[args.indexOf("--settings") + 1], "Maven settings"), "utf8");
      const base = required(/<url>([^<]+)<\/url>/.exec(settings)?.[1], "Verified Maven mirror");
      const response = await fetch(base + "org/example/library/1/library-1.jar");
      await response.text();
      return success;
    }
    if (options.input instanceof Readable) options.input.resume();
    const out = Readable.from([]),
      err = Readable.from([Buffer.from(valid)]);
    options.output?.(out, err);
    await finished(err);
    return {
      ...success,
      ...(mode === "unproven-verify"
        ? { status: 1, descendantsActive: true, error: new Error("unconfirmed child group") }
        : {}),
    };
  });
  const maven = () => {
    mkdirSync(join(root, ".mvn"));
    writeFileSync(join(root, "pom.xml"), "<project><artifactId>fixture</artifactId></project>");
    writeFileSync(join(root, "keys.asc"), signature.keys);
    writeFileSync(
      join(root, ".mvn/acquisition.json"),
      JSON.stringify({
        resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline",
        trust: [{ prefix: "org/example/", identity: "Fixture publisher", keys: "keys.asc", signers: [signer] }],
      }),
    );
    return prepareMavenDependencies(root, join(root, "proposal"));
  };
  return { root, asset, maven };
}

test.each(["download", "filtered", "maven"] as const)(
  "%s cleanup preserves a verifier home when process drainage is unproven",
  async (acquisition) => {
    for (const mode of ["unproven-setup", "unproven-verify"] as const) {
      const f = await fixture(mode);
      const destination = join(f.root, "filtered");
      mkdirSync(destination);
      const work =
        acquisition === "download"
          ? download(f.asset)
          : acquisition === "filtered"
            ? extractFilteredArtifact(
                { ...f.asset, filter: { revision: 1, include: ["^bin/"], required: ["bin/compiler"] } },
                destination,
              )
            : f.maven();
      let failure: unknown;
      try {
        await work;
      } catch (error) {
        failure = error;
      }
      const home = required(homes.at(-1), "Verifier-owned home");
      expect(describeError(failure)).toContain(home);
      expect(home.startsWith(f.root + sep)).toBe(false);
      expect(readFileSync(join(home, "keys.asc"), "utf8")).toBe(signature.keys);
      expect(readFileSync(join(home, "artifact.sig"), "utf8")).toBe("detached signature");
      expect(readdirSync(destination)).toEqual([]);
      expect(readdirSync(f.root).some((name) => name.startsWith(".maven-preparation-"))).toBe(false);
      rmSync(f.root, { recursive: true });
      expect(existsSync(home)).toBe(true);
    }
  },
);

test("known setup failure and successful verification remove their private homes", async () => {
  await fixture("known-failure");
  await expect(signatureVerifier(signature, new AbortController().signal)).rejects.toThrow(/GnuPG key preparation/);
  expect(existsSync(required(homes.at(-1), "Failed verifier home"))).toBe(false);
  const f = await fixture("success");
  await download(f.asset);
  expect(existsSync(required(homes.at(-1), "Successful verifier home"))).toBe(false);
});

test("an unproven Maven process preserves and identifies its own preparation directory", async () => {
  const f = await fixture("unproven-maven");
  let failure: unknown;
  try {
    await f.maven();
  } catch (error) {
    failure = error;
  }
  const scratch = required(
    readdirSync(f.root).find((name) => name.startsWith(".maven-preparation-")),
    "Preserved Maven scratch",
  );
  expect(describeError(failure)).toContain(join(f.root, scratch));
  expect(existsSync(join(f.root, scratch, "project/pom.xml"))).toBe(true);
  expect(existsSync(join(f.root, scratch, "repository"))).toBe(true);
  expect(existsSync(join(f.root, "proposal"))).toBe(false);
});

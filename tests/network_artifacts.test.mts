import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download } from "../src/tool-downloads.ts";
import { reportCIFailure } from "../scripts/ci-errors.mts";

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-network-artifact-"));
  temporary.push(root);
  vi.stubEnv("WORKBENCH_CACHE_HOME", root);
  vi.stubEnv("WORKBENCH_CHECK_INPUTS", "");
  return root;
}

test("a broken body restarts into private staging and publishes only complete verified bytes", async () => {
  const root = fixture(),
    bytes = Buffer.from("complete verified artifact\n");
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 8));
      else controller.error(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
    },
  });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  const path = await download({
    url: "https://tools.example/fixture",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(readFileSync(path)).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(readdirSync(join(root, "downloads"))).toHaveLength(1);
});

test("a checksum rejection never selects another endpoint or leaves partial bytes", async () => {
  const root = fixture(),
    fetcher = vi.fn().mockResolvedValue(new Response("corrupt"));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    download({
      url: "https://tools.example/fixture",
      backupUrls: ["https://backup.example/fixture"],
      sha256: createHash("sha256").update("verified").digest("hex"),
    }),
  ).rejects.toThrow("checksum mismatch");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(readdirSync(join(root, "downloads"))).toEqual([]);
});

test("CI failures produce safe readable annotations and summaries without losing the operation or cause", () => {
  const root = fixture(),
    summary = join(root, "summary.md");
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
  vi.stubEnv("GITHUB_TOKEN", "fixture-private-token");
  const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
  reportCIFailure(
    "Acquire fixture",
    new Error(
      "HTTP 503 <upstream>\n::error::injected fixture-private-token https://service.example/input?token=secret",
    ),
  );
  const annotation = String(output.mock.calls[0]?.[0]);
  expect(annotation).toContain("Acquire fixture");
  expect(annotation).toContain("HTTP 503");
  expect(annotation).not.toContain("\n");
  expect(annotation).not.toContain("fixture-private-token");
  const document = readFileSync(summary, "utf8");
  expect(document).toContain("&lt;upstream&gt;");
  expect(document).toContain("job’s logs");
  expect(document).not.toContain("fixture-private-token");
  expect(document).not.toContain("?token=");
});

test("an authentication rejection with a broken response cannot retry or select a mirror", async () => {
  fixture();
  const response = new Response("denied", { status: 403 });
  if (!response.body) throw new Error("Missing fixture body");
  vi.spyOn(response.body, "cancel").mockRejectedValue(
    Object.assign(new Error("connection closed during cleanup"), { code: "ECONNRESET" }),
  );
  const fetcher = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  await expect(
    download({
      url: "https://tools.example/fixture",
      backupUrls: ["https://backup.example/fixture"],
      sha256: createHash("sha256").update("verified").digest("hex"),
    }),
  ).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledOnce();
});

test("registry acquisition owns real CLI attempts, recovers privately, distinguishes missing images, and cancels active work", async () => {
  const { linkSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { delimiter } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { acquireRegistryImage } = await import("../scripts/image-acquisition.mts");
  const { registryImageStatus } = await import("../src/registry-images.ts");
  const { withCIProcessOwner } = await import("../scripts/ci-lifecycle.mjs");
  const { acquireProcessLock } = await import("../src/process-lock.ts");
  const root = fixture(),
    executable = join(root, process.platform === "win32" ? "docker.exe" : "docker");
  try {
    linkSync(process.execPath, executable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(process.execPath, executable);
  }
  const script = join(root, "docker-preload.mjs"),
    stateFile = join(root, "state.json"),
    lock = join(root, "owner.lock");
  writeFileSync(stateFile, JSON.stringify({ mode: "recover", calls: [] }));
  writeFileSync(
    script,
    `
import {readFileSync,writeFileSync} from 'node:fs';
import {basename} from 'node:path';
const file=process.env.REGISTRY_FIXTURE_STATE, state=JSON.parse(readFileSync(file,'utf8'));
const args=[basename(process.argv[1]),...process.argv.slice(2)], owner=JSON.parse(readFileSync(process.env.REGISTRY_FIXTURE_OWNER,'utf8'));
// The child can run before its parent publishes the PID; the persisted launch intent protects that gap.
state.calls.push({args,pid:process.pid,owned:owner.launching||owner.children.some(child=>child.pid===process.pid)});
writeFileSync(file,JSON.stringify(state));
if(state.mode==='cancel') {setInterval(()=>{},1000);await new Promise(()=>{});}
else if(state.mode==='missing') {console.error('manifest unknown');process.exit(1);}
else if(args[0]==='pull'&&state.calls.filter(call=>call.args[0]==='pull').length===1){console.error('HTTP 503 Service Unavailable');process.exit(1);}
else {console.log(args[0]==='manifest'?JSON.stringify({schemaVersion:2}):'fixture-image-progress');process.exit(0);}
`,
  );
  vi.stubEnv("PATH", root + delimiter + (process.env.PATH ?? ""));
  vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(script).href}`);
  vi.stubEnv("REGISTRY_FIXTURE_STATE", stateFile);
  vi.stubEnv("REGISTRY_FIXTURE_OWNER", join(lock, "owner.json"));
  const owner = acquireProcessLock(lock, true);
  if (!owner) throw new Error("Fixture process ownership unavailable");
  const output = vi.spyOn(process.stdout, "write");
  const read = () =>
    JSON.parse(readFileSync(stateFile, "utf8")) as {
      mode: string;
      calls: { args: string[]; pid: number; owned: boolean }[];
    };
  const reference = "registry.example/fixture:verified-inputs";
  try {
    await withCIProcessOwner(owner, () => acquireRegistryImage(reference));
    owner.assertIdle();
    expect(read().calls.filter((call) => call.args[0] === "pull")).toHaveLength(2);
    expect(await withCIProcessOwner(owner, () => registryImageStatus(reference))).toEqual({ state: "available" });
    writeFileSync(stateFile, JSON.stringify({ ...read(), mode: "missing" }));
    expect(await withCIProcessOwner(owner, () => registryImageStatus(reference))).toEqual({ state: "missing" });
    expect(read().calls.every((call) => call.owned)).toBe(true);
    expect(output.mock.calls.some(([text]) => String(text).includes("fixture-image-progress"))).toBe(false);
    writeFileSync(stateFile, JSON.stringify({ ...read(), mode: "cancel" }));
    const count = read().calls.length,
      cancellation = new AbortController();
    const pending = withCIProcessOwner(owner, () => acquireRegistryImage(reference, { signal: cancellation.signal }));
    const outcome = pending.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => {
        expect(read().calls.length).toBe(count + 1);
      });
      const running = read().calls.at(-1);
      const ownership = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as {
        launching: boolean;
        children: { pid: number }[];
      };
      expect(ownership.launching).toBe(false);
      expect(ownership.children.some((child) => child.pid === running?.pid)).toBe(true);
      expect(() => {
        owner.assertIdle();
      }).toThrow("Owned processes may still be active");
    } finally {
      cancellation.abort();
      await outcome;
    }
    expect(await outcome).toMatchObject({ name: "AbortError" });
    owner.assertIdle();
    expect(read().calls).toHaveLength(count + 1);
  } finally {
    owner.release();
  }
});

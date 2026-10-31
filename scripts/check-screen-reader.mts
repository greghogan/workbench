import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import type { IScreenReader } from "@guidepup/guidepup";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { settleCleanup } from "../src/diagnostics.ts";
import { required } from "./values.mjs";
import { standaloneTools } from "../src/toolchains.ts";

async function main() {
  const { values } = parseArgs({
    options: { browser: { type: "string" }, output: { type: "string" }, "browser-only": { type: "boolean" } },
  });
  if (!values.browser || !values.output)
    throw new Error(
      "Use --browser EXECUTABLE --output NEW_DIRECTORY; --browser-only rehearses browser actions without screen-reader evidence",
    );
  if (!values["browser-only"] && (process.platform !== "win32" || process.arch !== "x64"))
    throw new Error("NVDA evidence requires a Windows x64 desktop");
  const output = resolve(values.output),
    distribution = resolve(import.meta.dirname, "..");
  mkdirSync(output);
  const temporary = join(output, "temporary");
  mkdirSync(temporary);
  const cancellation = processCancellation(),
    service = new AbortController();
  const env = { ...process.env };
  for (const name of ["TMP", "TEMP", "TMPDIR"]) env[name] = temporary;
  for (const key of [
    "WORKBENCH_PROJECT_ROOT",
    "WORKBENCH_LOCAL_CONFIG_ROOT",
    "WORKBENCH_CONTAINER_CHECKOUT",
    "WORKBENCH_BUILD_DIR",
    "WORKBENCH_DEPENDENCIES_DIR",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    Reflect.deleteProperty(env, key);
  for (const kind of ["CONFIG", "DATA", "CACHE", "STATE"])
    env[`WORKBENCH_${kind}_HOME`] = join(output, kind.toLowerCase());
  const log: string[] = [];
  let logBytes = 0;
  let ready: (url: string) => void = () => undefined;
  const startup = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const closed = runOwnedChild(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "serve", "--demo", "--port", "0"],
    {
      cwd: distribution,
      env,
      signal: AbortSignal.any([cancellation.signal, service.signal, AbortSignal.timeout(6 * 60 * 1000)]),
      output: (stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            logBytes += chunk.length;
            if (logBytes > 1024 * 1024) {
              service.abort();
              return;
            }
            log.push(text);
            const match = /Workbench web UI: (http:\/\/127\.0\.0\.1:\d+\/?)/.exec(log.join(""));
            if (match?.[1]) ready(match[1].replace(/\/$/, ""));
          });
      },
    },
  );
  let browser: Browser | undefined, page: Page | undefined, reader: IScreenReader | undefined, failure: unknown;
  const evidence: { state: string; phrases: string[] }[] = [];
  let passed = false;
  try {
    const url = await Promise.race([
      startup,
      closed.then((outcome) => {
        throw new Error(`Demonstration service exited: ${JSON.stringify(outcome)}\n${log.join("")}`);
      }),
    ]);
    browser = await chromium.launch({ executablePath: resolve(values.browser), headless: !!values["browser-only"] });
    assert.equal(
      browser.version(),
      standaloneTools(distribution).get("chromium-headless-shell"),
      "Browser version must match the declared pin",
    );
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    let reportFocus: unknown;
    if (!values["browser-only"]) {
      const { nvda } = await import("@guidepup/guidepup");
      reader = nvda;
      reportFocus = nvda.keyboardCommands.reportCurrentFocus;
      await reader.start();
    }
    const capture = async (state: string, expected: RegExp, action?: () => Promise<void>) => {
      if (!reader) {
        await action?.();
        evidence.push({ state, phrases: [] });
        return;
      }
      await reader.clearSpokenPhraseLog();
      if (action) await action();
      else await reader.perform(reportFocus);
      const phrases = await reader.spokenPhraseLog();
      evidence.push({ state, phrases });
      assert.match(phrases.join(" "), expected, `${state}: NVDA did not communicate the expected interface content`);
    };
    const heading = async (state: string, expected: RegExp) => {
      if (!reader) {
        assert.match(await required(page, "Browser page").getByRole("heading", { level: 1 }).innerText(), expected);
        await capture(state, expected);
        return;
      }
      const activeReader = reader;
      await activeReader.press("Control+Home");
      await capture(state, expected, () => activeReader.nextHeading());
    };
    await page.goto(url);
    await page.bringToFront();
    await heading("overview-heading", /Overview/i);
    await page.getByLabel("Search all records").focus();
    await capture("search-field", /Search all records/i);
    await page.getByLabel("Search all records").fill("Connected records");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    assert(await page.getByRole("heading", { name: /Connected records/ }).count());
    await heading("search-results", /Search results/i);
    await page.goto(url + "/record?id=demo:CHARTER&view=edit");
    const editor = page.getByRole("textbox", { name: "Charter text", exact: true });
    await editor.focus();
    await capture("charter-editor", /Charter text/i);
    await editor.press("Control+End");
    await editor.press("Enter");
    await editor.pressSequentially("Screen reader fixture edit.");
    await editor.press("Tab");
    await capture("save-draft-button", /Save draft/i);
    await page.keyboard.press("Enter");
    await page.getByText(/Saved to the working file/).waitFor();
    assert(await page.getByText("Screen reader fixture edit.", { exact: true }).count());
    const reviewed = url + "/review?path=workbench%2Fdecisions%2FADR-00.md&review_source=working";
    await page.goto(reviewed);
    await heading("review-heading", /ADR-0/i);
    const checkbox = page.getByRole("checkbox", { name: /I have reviewed this exact working file/ });
    await checkbox.focus();
    await capture("review-checkbox", /I have reviewed this exact working file/i);
    await page.keyboard.press("Space");
    assert(await checkbox.isChecked());
    const confirm = page.getByRole("button", { name: "Confirm review", exact: true });
    await confirm.focus();
    await capture("confirm-review-button", /Confirm review/i);
    await Promise.all([page.waitForURL((current) => current.href !== reviewed), page.keyboard.press("Enter")]);
    assert.match(new URL(page.url()).pathname, /\/review$/);
    passed = true;
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => undefined);
  } finally {
    await settleCleanup(
      [
        () => {
          writeFileSync(join(output, "service.log"), log.join(""));
          writeFileSync(
            join(output, "result.json"),
            JSON.stringify(
              {
                schema: 1,
                passed,
                screenReaderVerified: passed && !!reader,
                screenReader: reader ? "NVDA" : "none (browser rehearsal)",
                platform: process.platform,
                node: process.versions.node,
                browser: browser?.version(),
                guidepup: (
                  JSON.parse(readFileSync(join(distribution, "package.json"), "utf8")) as {
                    devDependencies: Record<string, string>;
                  }
                ).devDependencies["@guidepup/guidepup"],
                releaseSha256: createHash("sha256")
                  .update(readFileSync(join(distribution, "bundle/main.cjs.br")))
                  .digest("hex"),
                conformance: "not-assessed",
                evidence,
                error: failure instanceof Error ? failure.message : failure,
              },
              null,
              2,
            ),
          );
        },
        async () => {
          if (reader) await reader.stop();
        },
        async () => {
          await browser?.close();
        },
        async () => {
          service.abort();
          await closed;
        },
        () => {
          rmSync(temporary, { recursive: true, force: true });
        },
        () => {
          cancellation.close();
        },
      ],
      failure,
    );
  }
  console.log(`Screen-reader workflow evidence: ${output}`);
}
await main();

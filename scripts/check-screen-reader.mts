import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page, type Locator } from "playwright-core";
import { setTimeout as delay } from "node:timers/promises";
import type { IScreenReader } from "@guidepup/guidepup";
import { createOwnedScratch } from "./owned-scratch.mjs";
import { tmpdir } from "node:os";
import { runOwnedChild, processCancellation } from "./owned-child.mjs";
import { settleCleanup } from "../src/diagnostics.ts";
import { required } from "./values.mjs";
import { standaloneTools } from "../src/toolchains.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      output: { type: "string" },
      "browser-only": { type: "boolean" },
      "keep-fixtures": { type: "boolean" },
    },
  });
  if (!values.browser || !values.output)
    throw new Error(
      "Use --browser EXECUTABLE --output NEW_DIRECTORY; --browser-only rehearses browser actions without screen-reader evidence",
    );
  const macOS = process.platform === "darwin" && process.arch === "arm64";
  if (!values["browser-only"] && !macOS && (process.platform !== "win32" || process.arch !== "x64"))
    throw new Error("Screen-reader evidence requires a Windows x64 or macOS ARM64 desktop");
  const output = resolve(values.output),
    distribution = resolve(import.meta.dirname, "..");
  mkdirSync(output);
  const scratch = createOwnedScratch(tmpdir(), "workbench-screen-reader");
  const temporary = scratch.directory;
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
    env[`WORKBENCH_${kind}_HOME`] = join(temporary, kind.toLowerCase());
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
      owner: scratch.owner,
      stopDescendantsOnExit: true,
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
            const match = /Workbench web UI: (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)(?=\r?\n)/.exec(log.join(""));
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
    let voiceOverFocusCommand: unknown;
    let firstItem: (() => Promise<void>) | undefined;
    let tab = () => required(page, "Browser page").keyboard.press("Tab");
    if (!values["browser-only"]) {
      const { nvda, voiceOver, macOSActivateId } = await import("@guidepup/guidepup");
      const selectedReader = macOS ? voiceOver : nvda;
      await selectedReader.start();
      reader = selectedReader;
      // Reader commands activate VoiceOver itself; ordinary keys must return to the browser.
      tab = macOS
        ? () => voiceOver.press("Tab", { application: "Google Chrome for Testing" })
        : () => nvda.press("Tab");
      voiceOverFocusCommand = macOS ? voiceOver.keyboardCommands.moveCursorToKeyboardFocus : undefined;
      reportFocus = macOS
        ? voiceOver.keyboardCommands.describeItemWithKeyboardFocus
        : nvda.keyboardCommands.reportCurrentFocus;
      firstItem = macOS
        ? async () => {
            await macOSActivateId("com.google.chrome.for.testing");
            await focus(required(page, "Browser page").getByRole("link", { name: "Skip to content", exact: true }));
            await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus);
          }
        : () => nvda.press("Control+Home");
    }
    const capture = async (state: string, expected: RegExp, action?: () => Promise<void>) => {
      if (!reader) {
        await action?.();
        evidence.push({ state, phrases: [] });
        return;
      }
      await reader.clearSpokenPhraseLog();
      if (action) await action();
      let phrases: string[];
      const deadline = performance.now() + 10000;
      do {
        if (!action) {
          if (macOS) await reader.perform(voiceOverFocusCommand);
          await reader.perform(reportFocus);
        }
        phrases = await reader.spokenPhraseLog();
        if (expected.test(phrases.join(" "))) break;
        await delay(100, undefined, { signal: cancellation.signal });
      } while (performance.now() < deadline);
      evidence.push({ state, phrases });
      assert.match(
        phrases.join(" "),
        expected,
        `${state}: screen reader did not communicate the expected interface content`,
      );
    };
    const focus = async (control: Locator) => {
      await required(page, "Browser page").bringToFront();
      await control.focus();
      if (reader && !macOS) {
        // Native keyboard events synchronize desktop and browser accessibility focus after scripted navigation.
        await reader.press("Shift+Tab");
        await reader.press("Tab");
      }
      await control.evaluate((element) => {
        if (element !== document.activeElement) throw new Error("Control needs keyboard focus");
      });
    };
    const heading = async (state: string, expected: RegExp) => {
      if (!reader) {
        assert.match(await required(page, "Browser page").getByRole("heading", { level: 1 }).innerText(), expected);
        await capture(state, expected);
        return;
      }
      const activeReader = reader;
      await required(firstItem, "Screen reader navigation")();
      if (macOS) await capture(`${state}-navigation-start`, /Skip to content/i);
      await capture(state, expected, () => activeReader.nextHeading());
    };
    await page.goto(url);
    await page.bringToFront();
    await heading("overview-heading", /Overview/i);
    await focus(page.getByLabel("Search project records"));
    await capture("search-field", /Search project records/i);
    await page.getByLabel("Search project records").fill("Notes stay in ordinary files");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("heading", { name: /Notes stay in ordinary files/ }).waitFor();
    await heading("search-results", /Search results/i);
    await page.goto(url + "/records/demo:CHARTER?view=edit");
    const editor = page.getByRole("textbox", { name: "Charter text", exact: true });
    await focus(editor);
    await capture("charter-editor", /Charter text/i);
    await editor.press(macOS ? "Meta+ArrowDown" : "Control+End");
    await editor.press("Enter");
    await editor.pressSequentially("Screen reader fixture edit.");
    await tab();
    const save = page.getByRole("button", { name: "Save draft", exact: true });
    // Native key dispatch can finish before the browser applies the focus transition.
    await page.waitForFunction(() => document.activeElement?.textContent === "Save draft");
    await focus(save);
    await capture("save-draft-button", /Save draft/i);
    await page.keyboard.press("Enter");
    await page.getByText(/Saved to the working file/).waitFor();
    assert(await page.getByText("Screen reader fixture edit.", { exact: true }).count());
    const reviewTitle = "ADR-0: Notes stay in ordinary files";
    await page.goto(url + "/review");
    await heading("formatting-heading", /Review formatting/i);
    await focus(page.getByRole("button", { name: "Apply formatting", exact: true }));
    await capture("apply-formatting-button", /Apply formatting/i);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Review queue", exact: true }).waitFor();
    await heading("review-queue-heading", /Review queue/i);
    await page.getByRole("link", { name: reviewTitle, exact: true }).click();
    await heading("review-heading", /ADR-0/i);
    const confirm = page.getByRole("button", { name: "Confirm changes", exact: true });
    await focus(confirm);
    await capture("confirm-review-button", /Confirm changes/i);
    const presentedURL = page.url();
    await Promise.all([page.waitForURL((current) => current.href !== presentedURL), page.keyboard.press("Enter")]);
    assert.match(new URL(page.url()).pathname, /\/review$/);
    await page.goto(url + "/review");
    assert.equal(await page.getByRole("link", { name: reviewTitle, exact: true }).count(), 0);
    passed = true;
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => undefined);
  } finally {
    await settleCleanup(
      [
        async () => {
          if (reader) await reader.stop();
        },
        async () => {
          try {
            await browser?.close();
          } catch (error) {
            scratch.owner.markUncertain();
            throw error;
          }
        },
        async () => {
          service.abort();
          const outcome = await closed;
          if (outcome.error || outcome.descendantsActive)
            throw outcome.error ?? new Error("Screen-reader service descendants remain active");
        },
        () => {
          if (values["keep-fixtures"]) {
            scratch.owner.release();
            console.log(`Retained browser fixtures: ${temporary}`);
          } else scratch.release();
        },
        () => {
          cancellation.close();
        },
      ],
      failure,
      (errors) => {
        writeFileSync(join(output, "service.log"), log.join(""));
        writeFileSync(
          join(output, "result.json"),
          JSON.stringify(
            {
              schema: 1,
              passed: passed && errors.length === 0,
              screenReaderVerified: passed && errors.length === 0 && !!reader,
              screenReader: values["browser-only"] ? "none (browser rehearsal)" : macOS ? "VoiceOver" : "NVDA",
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
              error: errors.length
                ? errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")
                : undefined,
            },
            null,
            2,
          ),
        );
      },
    );
  }
  console.log(`Screen-reader workflow evidence: ${output}`);
}
await main();

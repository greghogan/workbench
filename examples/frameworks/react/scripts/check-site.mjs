// Generated from check-site.mts; edit the TypeScript source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { setTimeout } from "node:timers";
const site = resolve(
  process.argv[2] ??
    (process.env.WORKBENCH_STORAGE_EXTERNAL === "true" && process.env.WORKBENCH_BUILD_DIR
      ? join(process.env.WORKBENCH_BUILD_DIR, "react/build")
      : "build"),
);
const dom = new JSDOM(readFileSync(join(site, "index.html"), "utf8"), { runScripts: "outside-only" });
async function count(expected) {
  const deadline = Date.now() + 5e3;
  while (dom.window.document.querySelector("output")?.textContent !== expected) {
    assert.ok(Date.now() < deadline, `Built application did not display count ${expected}`);
    await new Promise((done) => {
      setTimeout(done, 10);
    });
  }
}
try {
  dom.window.eval(readFileSync(join(site, "app.js"), "utf8"));
  await count("0");
  const buttons = [...dom.window.document.querySelectorAll("button")];
  const click = (name) => {
    const button = buttons.find((element) => element.textContent === name);
    assert.ok(button, `Missing ${name} button`);
    button.click();
  };
  click("Increase");
  await count("1");
  click("Decrease");
  await count("0");
  click("Decrease");
  await count("-1");
  click("Reset");
  await count("0");
  console.log("Verified the production static site.");
} finally {
  dom.window.close();
}

import assert from "node:assert/strict";
import { distribution, fixture } from "../fixtures/cli-browsing.mjs";
import { required } from "../../src/core/runtime/invariants.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { queryFeedback } from "../../src/core/feedback/feedback.ts";

interface Feedback {
  id: string;
  title: string;
  path: string;
}
const feedbackList = (text: string) => JSON.parse(text) as Feedback[];
const feedbackRecord = (text: string) => JSON.parse(text) as Feedback;

test("feedback uses platform data locations and inspection does not initialize storage", () => {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-xdg-"));
  try {
    for (const [name, xdg] of [
      ["unset", undefined],
      ["empty", ""],
      ["relative", "relative-data"],
      ["explicit", join(temporary, "custom")],
      ["override", undefined],
    ] as const) {
      const home = join(temporary, required(name, "Fixture value name"));
      const local = join(home, "windows-data");
      const override = name === "override" ? join(home, "selected") : undefined;
      const base =
        process.platform === "win32"
          ? join(local, "data")
          : process.platform === "darwin"
            ? join(home, "Library/Application Support")
            : name === "explicit"
              ? xdg
              : join(home, ".local/share");
      const folder = override
        ? join(override, "feedback")
        : process.platform === "win32"
          ? join(local, "workbench/data/feedback")
          : join(required(base, "Fixture value base"), "workbench/feedback");
      const invoke = (...args: string[]) => {
        const result = spawnSync(process.execPath, [join(distribution, "bundle/main.cjs"), "feedback", ...args], {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            LOCALAPPDATA: local,
            WORKBENCH_DATA_HOME: override,
            XDG_DATA_HOME: xdg,
            WORKBENCH_PROJECT_ROOT: distribution,
            WORKBENCH_DISTRIBUTION_ROOT: distribution,
          },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout;
      };
      assert.deepEqual(JSON.parse(invoke("--json")), []);
      assert.equal(existsSync(folder), false);
      invoke("add", `Feedback ${name}`);
      const entry = required(feedbackList(invoke("--json"))[0], "Feedback fixture");
      assert.equal(entry.path, join(folder, `${entry.id}.md`));
      assert.equal(entry.title, `Feedback ${name}`);
      assert.equal(existsSync(entry.path), true);
      if (process.platform !== "win32") assert.equal(statSync(folder).mode & 0o777, 0o700);
      assert.equal(existsSync(join(temporary, "relative-data")), false);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("feedback is browsable locally and resolution controls default visibility", () =>
  fixture(({ temporary, run, fail }) => {
    assert.deepEqual(JSON.parse(run("feedback", "--json")), []);
    assert.equal(existsSync(join(temporary, "data")), false);
    run("feedback", "add", "Search add parser");
    const entry = required(feedbackList(run("feedback", "--json"))[0], "Feedback fixture");
    assert.match(run("feedback", "parser"), new RegExp(entry.id));
    assert.match(run("feedback", "--", "add"), new RegExp(entry.id));
    assert.match(run("feedback", "show", entry.id), /Disposition: New/);
    const shown = feedbackRecord(run("feedback", "show", entry.id, "--json"));
    assert.equal(shown.id, entry.id);
    const file = shown.path;
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    assert.equal(required(queryFeedback({})[0], "Feedback entry").id, entry.id);
    run("feedback", "resolve", entry.id, "accepted", "Promote this improvement");
    assert.deepEqual(JSON.parse(run("feedback", "--json")), []);
    assert.deepEqual(
      feedbackList(run("feedback", "--all", "--json", "--", "parser")).map((record: { id: string }) => record.id),
      [entry.id],
    );
    assert.match(fail("feedback", "show", "../other"), /decimal digits/);
  }));

import { expect, test } from "vitest";
import { nativeCheckBackend } from "../../../../src/core/execution/checks/check-isolation.ts";
import { git } from "../../../fixtures/adoption.mjs";
import { scopedLauncherFixture } from "../../../fixtures/scoped-launcher.mjs";

const fixture = scopedLauncherFixture();

test.skipIf(process.platform === "win32")(
  "the Git hook uses the staged scope and source when the working tree differs",
  async () => {
    const scopedExecution = !!nativeCheckBackend();
    const { root, write, declareLauncherInputs, run, runHook } = await fixture();
    expect(run("initial")).toMatchObject({ outcome: "fresh" });
    git(root, "add", "-f", "local-input");

    write("local-input", "ignored file edited");
    declareLauncherInputs([]);
    write("LICENSE", "rejected");
    expect(run("incomplete", false)).toMatchObject({
      outcome: "fresh",
      inputScope: { mode: "whole-project", reason: "No input groups for Launcher" },
    });
    const hook = runHook();
    expect(hook.status, hook.stdout + hook.stderr).toBe(0);
    if (scopedExecution) expect(hook.stderr).toContain("Reusing 1 successful checks; 0 run fresh");

    write("launcher/[fixtures]/added.txt", "valid");
    git(root, "--literal-pathspecs", "add", "launcher/[fixtures]/added.txt");
    write("launcher/[fixtures]/added.txt", "unstaged");
    const fresh = runHook();
    expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0);
    expect(fresh.stderr).not.toContain("Reusing 1 successful checks; 0 run fresh");
  },
);

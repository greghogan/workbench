import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sourceFingerprint } from "../../../../src/core/execution/checks/check-inputs.ts";
import { nativeCheckBackend } from "../../../../src/core/execution/checks/check-isolation.ts";
import { scopedLauncherFixture } from "../../../fixtures/scoped-launcher.mjs";

const fixture = scopedLauncherFixture();

test.skipIf(process.platform === "win32")(
  "CLI cache tracks declared inputs and restores matching results",
  async () => {
    const scopedExecution = !!nativeCheckBackend();
    const { root, inspect, run, write } = await fixture();
    expect(inspect()).toMatchObject({
      inputScope: {
        mode: "scoped",
        groups: ["launcher", "shared"],
        paths: expect.arrayContaining(["LICENSE", "launcher/[fixtures]", "local-input"]) as unknown,
      },
    });
    expect(run("initial")).toMatchObject({
      outcome: "fresh",
      inputScope: { mode: scopedExecution ? "scoped" : "whole-project" },
    });
    write("other/service.txt", "unrelated edit");
    write("launcher/not-declared.txt", "sibling edit");
    expect(run("unrelated")).toMatchObject({ outcome: scopedExecution ? "reused" : "fresh" });
    write("launcher/[fixtures]/added.txt", "valid");
    expect(run("added")).toMatchObject({ outcome: "fresh" });
    const scopedSource = () => sourceFingerprint(root, root, false, ["launcher/[fixtures]"]);
    const beforeRename = await scopedSource();
    write("launcher/[fixtures]/renamed.txt", "valid");
    rmSync(join(root, "launcher/[fixtures]/added.txt"));
    expect(await scopedSource()).not.toBe(beforeRename);
    rmSync(join(root, "launcher/[fixtures]/renamed.txt"));
    expect(run("restored")).toMatchObject({ outcome: "reused" });
    write("LICENSE", "rejected");
    expect(run("shared-change", false)).toMatchObject({ outcome: "fresh" });
    expect(run("shared-change-again", false)).toMatchObject({ outcome: "fresh" });
    write("local-input", "ignored file edited");
    write("LICENSE", "allowed");
    expect(run("additive")).toMatchObject({ outcome: "fresh" });
  },
);

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, type TestContext, vi } from "vitest";
import { distribution, git } from "../../fixtures/adoption.mjs";
import { isolateFixtureGit } from "../../fixtures/git-environment.mjs";
import { commitVersion } from "../../../src/core/review/review-units.ts";
import { AgentReviewKind, proposedAgentReview, reviewIdentity } from "../../../src/core/review/agent-review.ts";
import { checkPushSignatures } from "../../../src/core/git/push-signatures.ts";
import { resumePreparedSigning, signHistory } from "../../../src/core/git/sign-history.ts";
import { gitRevision } from "../../../src/core/git/refs.ts";
import { verifiedSignatureKey } from "../../../src/core/git/signatures.ts";
import { subscribeDiagnostics } from "../../../src/core/diagnostics/diagnostics.mjs";
import { removeRecoveryReference } from "../../../src/core/git/recovery-refs.ts";
import {
  applyInterruptedMoves,
  initRefFormat,
  linkedCheckout,
  preparedMoves,
  recoveryCases,
  refActivationInterrupted,
  stopBeforeRefActivation,
  type RefFormat,
} from "../../fixtures/ref-recovery.mts";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function signingProject(storage?: { format: RefFormat; context: TestContext }) {
  const root = mkdtempSync(join(tmpdir(), "workbench-sign-history-"));
  temporary.push(root);
  if (storage) initRefFormat(root, storage.format, storage.context);
  else git(root, "init", "-qb", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "workbench"));
  writeFileSync(
    join(root, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n[review]\nsigned_commits=true\n",
  );
  writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="demo"\npath="."\n');
  git(root, "add", "workbench");
  git(root, "commit", "-qm", "Published base");
  const base = git(root, "rev-parse", "HEAD");
  const receiver = join(root, ".git", "receiver.git");
  git(root, "init", "--bare", "--quiet", receiver);
  git(root, "remote", "add", "origin", receiver);
  git(root, "push", "-q", "origin", "main");
  return { root, base, receiver };
}

function signingFixture(context: TestContext, format?: RefFormat) {
  const { skip } = context;
  const project = signingProject(format ? { format, context } : undefined);
  const { root } = project;
  const key = (name: string) => {
    const path = join(root, ".git", name);
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], { encoding: "utf8" });
    if ((generated.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") skip("OpenSSH is unavailable");
    expect(generated.status, generated.stderr).toBe(0);
    return path;
  };
  const signingKey = key("signing-key"),
    other = key("other-signing-key");
  const allowed = join(root, ".git", "allowed-signers");
  writeFileSync(allowed, [signingKey, other].map((path) => `fixture ${readFileSync(path + ".pub", "utf8")}`).join(""));
  git(root, "config", "user.signingKey", signingKey);
  git(root, "config", "gpg.format", "ssh");
  git(root, "config", "gpg.ssh.program", "ssh-keygen");
  git(root, "config", "gpg.ssh.allowedSignersFile", allowed);
  return { ...project, signingKey, other, allowed };
}

test("signing a merge preserves authors, reviewed tree contexts and local edits and qualifies a tag push", (context) => {
  const { root, base, receiver, allowed, signingKey, other } = signingFixture(context);
  git(root, "switch", "-qc", "side");
  git(root, "config", "user.signingKey", other);
  git(
    root,
    "commit",
    "--allow-empty",
    "--gpg-sign",
    "--author=Other Author <other@example.invalid>",
    "-qm",
    "Side work",
  );
  const side = commitVersion(root, "HEAD");
  git(root, "config", "user.signingKey", signingKey);
  git(root, "switch", "-q", "main");
  git(root, "commit", "--allow-empty", "-qm", "Main work");
  git(root, "merge", "-q", "--no-ff", "-m", "Merge side work", "side");
  const merge = commitVersion(root, "HEAD"),
    review = reviewIdentity(proposedAgentReview(root, AgentReviewKind.Changes, { commit: merge.revision }));
  git(root, "tag", "-am", "Reviewed delivery", "delivery");
  const before = git(root, "rev-parse", "refs/tags/delivery");
  writeFileSync(join(root, "staged"), "Staged edits.\n");
  git(root, "add", "staged");
  writeFileSync(join(root, "staged"), "Pending edits.\n");
  const status = git(root, "status", "--porcelain"),
    index = git(root, "write-tree");
  expect(() => {
    checkPushSignatures(root, before, "0".repeat(base.length), receiver);
  }).toThrow(new RegExp(`Unsigned:[^\\n]*${merge.revision.slice(0, 12)}`));

  const result = signHistory(root, "refs/tags/delivery");
  expect(result).toMatchObject({ signed: 2, otherAuthors: 0, updated: ["refs/heads/main", "refs/tags/delivery"] });
  if (!result.recovery) throw new Error("Signing did not retain the original refs");
  const retained = commitVersion(root, "HEAD"),
    rewrittenSide = commitVersion(root, "side");
  expect(retained).toMatchObject({ tree: merge.tree, message: merge.message });
  expect(retained.parents[1]).toBe(rewrittenSide.revision);
  expect(rewrittenSide).toEqual(side);
  expect(reviewIdentity(proposedAgentReview(root, AgentReviewKind.Changes, { commit: retained.revision }))).toBe(
    review,
  );
  expect(git(root, "status", "--porcelain")).toBe(status);
  expect(git(root, "write-tree")).toBe(index);
  expect(gitRevision(receiver, "refs/heads/main")).toBe(base);
  expect(git(root, "rev-parse", `${result.recovery}/before-refs/refs/tags/delivery`)).toBe(before);
  const delivery = git(root, "rev-parse", "refs/tags/delivery");
  expect(() => {
    checkPushSignatures(root, delivery, "0".repeat(base.length), receiver);
  }).not.toThrow();
  const signers = readFileSync(allowed);
  writeFileSync(allowed, "");
  expect(() => {
    checkPushSignatures(root, delivery, "0".repeat(base.length), receiver);
  }).toThrow(/Invalid or untrusted:/);
  writeFileSync(allowed, signers);
  git(root, "push", "-q", "origin", "delivery");
  expect(gitRevision(receiver, "refs/tags/delivery")).toBe(delivery);
  expect(signHistory(root)).toEqual({ signed: 0, otherAuthors: 0, updated: [] });

  const outside = git(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Another delivery");
  git(root, "tag", "outside", outside);
  expect(signHistory(root, "outside")).toMatchObject({ signed: 1, updated: ["refs/tags/outside"] });
  expect(commitVersion(root, "outside")).toMatchObject({ parents: [base], signed: true });
  expect(gitRevision(root, "HEAD")).toBe(retained.revision);
});

test("signing your own work keeps a reparented commit from another author unsigned", (context) => {
  const { root, base, receiver } = signingFixture(context);
  const dated = spawnSync("git", ["-C", root, "commit", "--no-gpg-sign", "--allow-empty", "-qm", "Mine"], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "1577836800 +0530", GIT_COMMITTER_DATE: "1577923200 -0400" },
  });
  expect(dated.status, dated.stderr).toBe(0);
  const original = commitVersion(root, "HEAD");
  git(root, "commit", "--allow-empty", "--author=Other Author <other@example.invalid>", "-qm", "Someone else's work");
  const other = commitVersion(root, "HEAD");
  expect(signHistory(root)).toMatchObject({ signed: 1, otherAuthors: 1 });
  const head = commitVersion(root, "HEAD"),
    [parent] = head.parents;
  if (!parent) throw new Error("Missing parent after signing");
  expect(parent).not.toBe(original.revision);
  expect(commitVersion(root, parent)).toMatchObject({
    parents: [base],
    author: original.author,
    committerDate: original.committerDate,
    signed: true,
  });
  expect(head).toMatchObject({
    author: other.author,
    committerDate: other.committerDate,
    tree: other.tree,
    message: other.message,
    signed: false,
  });
  expect(() => {
    checkPushSignatures(root, head.revision, base, receiver);
  }).toThrow(new RegExp(`Unsigned:[^\\n]*${head.revision.slice(0, 12)}`));
});

test("signing refuses to replace another contributor's signature and keeps all live refs", (context) => {
  const { root, other, signingKey } = signingFixture(context);
  git(root, "commit", "--allow-empty", "-qm", "Unsigned parent");
  const parent = git(root, "rev-parse", "HEAD");
  git(root, "config", "user.signingKey", other);
  git(root, "commit", "--allow-empty", "--gpg-sign", "-qm", "A signed successor");
  const head = git(root, "rev-parse", "HEAD"),
    signer = verifiedSignatureKey(root, "commit", head);
  git(root, "tag", "topic", parent);
  git(root, "config", "user.signingKey", signingKey);
  expect(() => signHistory(root)).toThrow(/another signing key/);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "rev-parse", "topic")).toBe(parent);
  expect(verifiedSignatureKey(root, "commit", head)).toBe(signer);
});

test.for(["SSH", "OpenPGP"] as const)(
  "%s signs rebased, amended, and cherry-picked commits without changing their dates or trees",
  (format, context) => {
    const { root, base, receiver } = format === "SSH" ? signingFixture(context) : signingProject();
    const home = join(root, ".git", "gpg");
    try {
      if (format === "OpenPGP") {
        mkdirSync(home, { mode: 0o700 });
        vi.stubEnv("GNUPGHOME", home);
        const agent = spawnSync("gpgconf", ["--launch", "gpg-agent"], { encoding: "utf8", timeout: 5000 });
        if ((agent.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
          context.skip("GnuPG agent tools are unavailable");
        expect(agent.status, agent.stderr).toBe(0);
        const key = spawnSync(
          "gpg",
          [
            "--batch",
            "--pinentry-mode",
            "loopback",
            "--passphrase",
            "",
            "--quick-generate-key",
            "Fixture <fixture@example.invalid>",
            "ed25519",
            "sign",
            "0",
          ],
          { encoding: "utf8", timeout: 15000 },
        );
        if ((key.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") context.skip("GnuPG is unavailable");
        expect(key.status, key.stderr).toBe(0);
        git(root, "config", "gpg.format", "openpgp");
        git(root, "config", "gpg.openpgp.program", "gpg");
        git(root, "config", "user.signingKey", "fixture@example.invalid");
      }

      git(root, "switch", "-qc", "topic");
      writeFileSync(join(root, "topic.txt"), "Topic changes\n");
      git(root, "add", "topic.txt");
      git(root, "commit", "--gpg-sign", "-qm", "Topic change");
      const signer = verifiedSignatureKey(root, "commit", git(root, "rev-parse", "HEAD"));
      git(root, "switch", "-q", "main");
      git(root, "commit", "--allow-empty", "-qm", "New base");
      git(root, "push", "-q", "origin", "main");
      const published = git(root, "rev-parse", "main");
      git(root, "switch", "-q", "topic");
      git(root, "rebase", "main");

      const sign = () => {
        const before = commitVersion(root, "HEAD");
        expect(before.signed).toBe(false);
        expect(() => {
          checkPushSignatures(root, before.revision, base, receiver);
        }).toThrow(/Unsigned:/);
        expect(signHistory(root).signed).toBe(1);
        const after = commitVersion(root, "HEAD");
        expect(after).toEqual({ ...before, revision: after.revision, signed: true });
        expect(after.revision).not.toBe(before.revision);
        expect(verifiedSignatureKey(root, "commit", after.revision)).toBe(signer);
        checkPushSignatures(root, after.revision, base, receiver);
      };
      sign();

      git(root, "commit", "--amend", "-qm", "Amended change");
      sign();

      git(root, "switch", "-qc", "source", "main");
      writeFileSync(join(root, "pick.txt"), "Picked changes\n");
      git(root, "add", "pick.txt");
      git(root, "commit", "--gpg-sign", "-qm", "Work to pick");
      git(root, "switch", "-q", "topic");
      git(root, "cherry-pick", "source");
      sign();
      expect(gitRevision(receiver, "refs/heads/main")).toBe(published);
    } finally {
      if (format === "OpenPGP") spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { timeout: 5000 });
    }
  },
);

function signingCLIEnvironment(root: string) {
  const env = {
    ...process.env,
    LC_ALL: "C",
    NO_COLOR: "1",
    SHELL: "/bin/sh",
    SSH_ASKPASS_REQUIRE: "never",
    SSH_AUTH_SOCK: "",
    WORKBENCH_TEST_NODE: process.execPath,
    WORKBENCH_TEST_CLI: join(distribution, "bin/workbench.mjs"),
    WORKBENCH_DISTRIBUTION_ROOT: distribution,
    WORKBENCH_PROJECT_ROOT: root,
    WORKBENCH_LOCAL_CONFIG_ROOT: root,
    WORKBENCH_CONFIG_HOME: join(root, ".git", "configuration"),
    WORKBENCH_STATE_HOME: join(root, ".git", "state"),
    WORKBENCH_DATA_HOME: join(root, ".git", "data"),
    WORKBENCH_EPHEMERAL_CHECKOUT: "1",
  };
  isolateFixtureGit(env);
  return env;
}

function signInTerminal(root: string, reply?: () => string) {
  return new Promise<{ code: number | null; output: string; prompted: boolean }>((resolve, reject) => {
    const child = spawn(
      "script",
      [
        "--quiet",
        "--return",
        "--flush",
        "--echo",
        "never",
        "--command",
        'exec "$WORKBENCH_TEST_NODE" "$WORKBENCH_TEST_CLI" sign',
        "/dev/null",
      ],
      { cwd: root, env: signingCLIEnvironment(root), signal: AbortSignal.timeout(15_000) },
    );
    let output = "";
    let prompted = false;
    let failure: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
      if (prompted || !/enter passphrase/i.test(output)) return;
      prompted = true;
      try {
        if (reply) child.stdin.write(reply());
      } catch (error) {
        failure = new Error("Could not answer the signing prompt", { cause: error });
        child.kill();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    child.stdin.once("error", (error) => {
      failure ??= error;
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (code === null) reject(new Error("The signing terminal did not finish", { cause: output }));
      else resolve({ code, output, prompted });
    });
  });
}

test.skipIf(process.platform !== "linux")(
  "the signing command prompts in a terminal and preserves refs on cancellation, signer failure, or concurrent work",
  async (context) => {
    const terminal = spawnSync("script", ["--version"], { encoding: "utf8" });
    if ((terminal.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      context.skip("The util-linux terminal runner is unavailable");
    expect(terminal.status, terminal.stderr).toBe(0);
    expect(terminal.stdout).toContain("util-linux");
    const { root, signingKey } = signingFixture(context);
    const env = signingCLIEnvironment(root);
    const registration = spawnSync(process.execPath, [env.WORKBENCH_TEST_CLI, "project", "add", root], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(registration.status, registration.stderr).toBe(0);
    const passphrase = "disposable-workbench-fixture";
    const encrypted = spawnSync("ssh-keygen", ["-q", "-p", "-P", "", "-N", passphrase, "-f", signingKey], {
      encoding: "utf8",
    });
    expect(encrypted.status, encrypted.stderr).toBe(0);
    git(root, "commit", "--allow-empty", "-qm", "Unsigned work");
    const before = commitVersion(root, "HEAD");
    const recoveryRefs = () => git(root, "for-each-ref", "--format=%(refname)", "refs/workbench/recovery");
    const originalRecovery = recoveryRefs();

    const canceled = await signInTerminal(root, () => "\x03");
    expect(canceled.prompted, canceled.output).toBe(true);
    expect(canceled.code, canceled.output).not.toBe(0);
    expect(gitRevision(root, "HEAD")).toBe(before.revision);
    expect(recoveryRefs()).toBe(originalRecovery);

    git(root, "config", "gpg.ssh.program", join(root, ".git", "missing-signer"));
    const failed = await signInTerminal(root);
    expect(failed.prompted, failed.output).toBe(false);
    expect(failed.code, failed.output).not.toBe(0);
    expect(gitRevision(root, "HEAD")).toBe(before.revision);
    expect(recoveryRefs()).toBe(originalRecovery);

    git(root, "config", "gpg.ssh.program", "ssh-keygen");
    const concurrent = await signInTerminal(root, () => {
      git(root, "branch", "other-work", before.revision);
      return passphrase + "\n";
    });
    expect(concurrent.prompted, concurrent.output).toBe(true);
    expect(concurrent.code, concurrent.output).not.toBe(0);
    expect(concurrent.output).toMatch(/references changed during signing/i);
    expect(gitRevision(root, "HEAD")).toBe(before.revision);
    expect(gitRevision(root, "other-work")).toBe(before.revision);
    expect(recoveryRefs()).toBe(originalRecovery);

    git(root, "branch", "-D", "other-work");
    const signed = await signInTerminal(root, () => passphrase + "\n");
    expect(signed.prompted, signed.output).toBe(true);
    expect(signed.code, signed.output).toBe(0);
    expect(signed.output).not.toContain(passphrase);
    const after = commitVersion(root, "HEAD");
    expect(after.revision).not.toBe(before.revision);
    expect(after).toEqual({ ...before, revision: after.revision, signed: true });
    expect(git(root, "log", "-1", "--format=%G?")).toBe("G");
  },
  45_000,
);

test.for(recoveryCases)(
  "signing resumes from the linked checkout with %s refs interrupted %s",
  ([format, stage], context) => {
    const { root, receiver, base, signingKey } = signingFixture(context, format);
    git(root, "commit", "--allow-empty", "-qm", "Prepare a signed delivery");
    const linked = linkedCheckout(root, "shared");
    git(root, "tag", "-am", "Original annotation", "recovery-test");
    writeFileSync(join(linked, "notes.txt"), "Uncommitted notes.\n");
    git(linked, "add", "notes.txt");
    writeFileSync(join(linked, "notes.txt"), "Also unstaged notes.\n");
    const staged = git(linked, "write-tree"),
      status = git(linked, "status", "--porcelain");
    const stop = stopBeforeRefActivation(root);
    expect(() => signHistory(root)).toThrow(refActivationInterrupted);
    const moves = preparedMoves(root, "signing");
    expect(moves.map(({ name }) => name)).toEqual(["refs/heads/main", "refs/heads/shared", "refs/tags/recovery-test"]);
    for (const { name, before } of moves) expect(git(root, "rev-parse", name)).toBe(before);
    const backup = git(root, "for-each-ref", "--format=%(refname)", "refs/workbench/recovery").split("\n")[0];
    if (!backup) throw new Error("Missing recovery reference");
    expect(() => {
      removeRecoveryReference(root, backup, git(root, "rev-parse", backup));
    }).toThrow(/pending repository recovery/);
    stop();
    applyInterruptedMoves(root, moves, stage);
    git(root, "reflog", "expire", "--expire=now", "--all");
    git(root, "gc", "--prune=now");
    git(root, "config", "user.signingKey", join(root, "no-such-private-key"));

    const messages: string[] = [],
      unsubscribe = subscribeDiagnostics(({ message }) => {
        if (message) messages.push(message);
      });
    try {
      expect(signHistory(linked)).toMatchObject({ signed: 1 });
      expect(resumePreparedSigning(linked)).toBeUndefined();
    } finally {
      unsubscribe();
    }
    expect(messages.filter((message) => message.includes("reftable"))).toHaveLength(stage === "partial" ? 1 : 0);
    for (const { name, after } of moves) expect(git(root, "rev-parse", name)).toBe(after);
    expect(git(linked, "write-tree")).toBe(staged);
    expect(git(linked, "status", "--porcelain")).toBe(status);
    expect(gitRevision(receiver, "refs/heads/main")).toBe(base);
    expect(git(root, "for-each-ref", "--format=%(contents:subject)", "refs/tags/recovery-test")).toBe(
      "Original annotation",
    );
    expect(verifiedSignatureKey(root, "commit", "HEAD")).toBe(git(root, "show", "-s", "--format=%GF", "HEAD"));
    git(root, "config", "user.signingKey", signingKey);
    expect(signHistory(linked)).toMatchObject({ signed: 0 });
  },
);

test.for(["files", "reftable"] as const)(
  "signing recovery on %s preserves a missing, unexpected, or symbolic ref and both histories",
  (format, context) => {
    const { root, base } = signingFixture(context, format);
    git(root, "commit", "--allow-empty", "-qm", "Keep this work safe");
    git(root, "branch", "shared");
    git(root, "tag", "recovery-test");
    const stop = stopBeforeRefActivation(root);
    expect(() => signHistory(root)).toThrow(refActivationInterrupted);
    stop();
    const moves = preparedMoves(root, "signing"),
      main = moves.find(({ name }) => name === "refs/heads/main");
    if (!main) throw new Error("Missing prepared main branch");
    const shared = "refs/heads/shared";

    git(root, "update-ref", "-d", shared);
    expect(() => signHistory(root)).toThrow(/refs\/heads\/shared was deleted/);
    expect(gitRevision(root, shared)).toBeUndefined();
    git(root, "update-ref", shared, base);
    expect(() => signHistory(root)).toThrow(/refs\/heads\/shared changed/);
    expect(gitRevision(root, shared)).toBe(base);
    git(root, "symbolic-ref", shared, main.name);
    expect(() => signHistory(root)).toThrow(/refs\/heads\/shared changed/);
    expect(git(root, "symbolic-ref", shared)).toBe(main.name);
    expect(gitRevision(root, main.name)).toBe(main.before);
    expect(git(root, "cat-file", "-t", main.after)).toBe("commit");
    git(root, "update-ref", "--no-deref", shared, main.before);
    expect(git(root, "for-each-ref", "--format=%(symref)", shared)).toBe("");
    git(root, "push", "-q", "origin", "main:originated");
    expect(() => signHistory(root)).toThrow(/Preserve published history/);
    expect(gitRevision(root, main.name)).toBe(main.before);
  },
);

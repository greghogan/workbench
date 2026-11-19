import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "../distribution/update-git.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { gitBytes } from "./git-snapshot.js";

export function commitSignatureResults(root: string, revisions: string[], input?: string) {
  return gitBytes(root, ["log", "--no-show-signature", "--format=%H %G?", ...revisions], input)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [revision, status] = row.split(" ");
      if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || !status || !/^[GBUXYREN]$/.test(status))
        throw new InvalidInput("Git returned an invalid commit signature result");
      return { revision, status };
    });
}

export function trustedCommitSignature(root: string, revision: string): boolean {
  return commitSignatureResults(root, ["--no-walk", revision])[0]?.status === "G";
}

/** Supply the message separately so Git's signer keeps the developer's terminal. */
export function runGitSigner(
  args: (messageFile: string) => string[],
  message: string | Buffer,
  env: NodeJS.ProcessEnv,
) {
  const options = { env, encoding: "utf8" as const, maxBuffer: 1024 * 1024 };
  if (!process.stdin.isTTY) return spawnSync("git", args("-"), { ...options, input: message });
  const directory = mkdtempSync(join(tmpdir(), "workbench-signer-message-"));
  try {
    const path = join(directory, "message");
    writeFileSync(path, message, { mode: 0o600 });
    return spawnSync("git", args(path), { ...options, stdio: ["inherit", "pipe", "inherit"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Inspect the key Git can verify under the repository's trust settings. */
export function signatureKey(root: string, kind: "tag" | "commit", revision: string): string | undefined {
  const verification = spawnSync("git", ["-C", root, `verify-${kind}`, "--raw", revision], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (!verification.error && verification.status === 0) {
    const fingerprints = [
      ...verification.stderr.matchAll(/^\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]{40,64})\b/gm),
      ...verification.stderr.matchAll(
        /^Good "git" signature(?: for .+)? with \S+ key (SHA256:[A-Za-z0-9+/]+={0,2})\r?$/gm,
      ),
    ];
    if (fingerprints.length === 1) return fingerprints[0]?.[1];
  }
  return undefined;
}

export function verifiedSignatureKey(root: string, kind: "tag" | "commit", revision: string): string {
  const key = signatureKey(root, kind, revision);
  if (key) return key;
  throw new StateConflict(
    `Cannot verify the signing key for ${kind} ${revision.slice(0, 12)} using Git's trust settings`,
  );
}

export function unsignedTagPayload(contents: Buffer): Buffer {
  const signature = /^(?:-----BEGIN (?:PGP SIGNATURE|PGP MESSAGE|SSH SIGNATURE|SIGNED MESSAGE)-----)\r?$/m.exec(
    contents.toString("latin1"),
  );
  return signature ? contents.subarray(0, signature.index) : contents;
}

/** Copy effective signing settings so conditional and worktree-specific Git config stays in effect in the sandbox. */
function signingSettings(root: string): string[] {
  const selected = spawnSync("git", ["-C", root, "config", "--null", "--get-regexp", "^(gpg\\.|user\\.signingkey$)"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (selected.error || (selected.status !== 0 && selected.status !== 1))
    throw new StateConflict("Cannot inspect Git tag signing settings");
  return selected.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("\n");
      if (separator < 1) throw new StateConflict("Invalid Git tag signing setting");
      return ["-c", `${entry.slice(0, separator)}=${entry.slice(separator + 1)}`];
    });
}

/** Git signs a tag in private ref storage while writing the replacement object into the original object database. */
export function signReplacementTag(
  root: string,
  target: string,
  payload: Buffer,
  signer: string,
  required: boolean,
): string | undefined {
  const separator = payload.indexOf("\n\n"),
    header = payload.subarray(0, separator).toString(),
    name = /^tag (.+)$/m.exec(header)?.[1],
    tagger = /^tagger (.*) <([^<>]*)> (\d+ [+-]\d{4})$/m.exec(header);
  if (separator < 0 || !name || !tagger) throw new StateConflict("Cannot preserve the signed tag annotation");
  const directory = mkdtempSync(join(tmpdir(), "workbench-sign-tag-"));
  try {
    const format = gitBytes(root, ["rev-parse", "--show-object-format"]).toString().trim(),
      objects = gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).toString().trim(),
      environment = gitEnvironment();
    gitBytes(
      root,
      ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, directory],
      undefined,
      environment,
    );
    const args = [
        `--git-dir=${directory}`,
        "--bare",
        ...signingSettings(root),
        "-c",
        `core.hooksPath=${join(directory, "hooks")}`,
      ],
      env = {
        ...environment,
        GIT_OBJECT_DIRECTORY: objects,
        GIT_COMMITTER_NAME: tagger[1],
        GIT_COMMITTER_EMAIL: tagger[2],
        GIT_COMMITTER_DATE: tagger[3],
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
      };
    const signed = runGitSigner(
      (message) => ["-C", root, ...args, "tag", "--sign", "--cleanup=verbatim", "-F", message, "--", name, target],
      payload.subarray(separator + 2),
      env,
    );
    if (signed.error || signed.status !== 0) {
      if (!required && !signed.error && signed.status !== null && signed.status !== 130) return undefined;
      throw new StateConflict(`Git could not sign the replacement for ${name}`);
    }
    const replacement = gitBytes(root, [...args, "rev-parse", "--verify", `refs/tags/${name}`], undefined, env)
      .toString()
      .trim();
    const result = gitBytes(root, ["cat-file", "tag", replacement]);
    if (!unsignedTagPayload(result).equals(payload))
      throw new StateConflict(`Signing changed the annotation for ${name}`);
    if (signatureKey(root, "tag", replacement) !== signer) {
      if (!required) return undefined;
      throw new StateConflict(`The replacement for ${name} was signed by a different key`);
    }
    return replacement;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "../distribution/update-git.js";
import { StateConflict } from "../runtime/input-errors.js";
import { gitBytes } from "./git-snapshot.js";

/** Require Git to verify the object under the repository's trust settings before using its signer. */
export function verifiedSignatureKey(root: string, kind: "tag" | "commit", revision: string): string {
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
    const key = fingerprints.length === 1 ? fingerprints[0]?.[1] : undefined;
    if (key) return key;
  }
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
export function signReplacementTag(root: string, target: string, payload: Buffer, signer: string): string {
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
    const signed = spawnSync(
      "git",
      ["-C", root, ...args, "tag", "--sign", "--cleanup=verbatim", "-F", "-", "--", name, target],
      {
        env,
        input: payload.subarray(separator + 2),
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
    if (signed.error || signed.status !== 0) throw new StateConflict(`Git could not sign the replacement for ${name}`);
    const replacement = gitBytes(root, [...args, "rev-parse", "--verify", `refs/tags/${name}`], undefined, env)
      .toString()
      .trim();
    const result = gitBytes(root, ["cat-file", "tag", replacement]);
    if (!unsignedTagPayload(result).equals(payload))
      throw new StateConflict(`Signing changed the annotation for ${name}`);
    if (verifiedSignatureKey(root, "tag", replacement) !== signer)
      throw new StateConflict(`The replacement for ${name} was signed by a different key`);
    return replacement;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

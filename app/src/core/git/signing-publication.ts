import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnvironment } from "../distribution/update-git.js";
import { StateConflict } from "../runtime/input-errors.js";
import { gitBytes } from "./git-snapshot.js";
import { gitRevision } from "./refs.js";

const observationRefs = "refs/workbench/signing-remotes";

function advertisedLocalRefs(root: string, url: string): string | undefined {
  let directory: string;
  try {
    directory = url.startsWith("file://") ? fileURLToPath(url) : resolve(root, url);
  } catch {
    return undefined;
  }
  if (!existsSync(join(directory, ".git")) && !existsSync(join(directory, "HEAD"))) return undefined;
  const inspected = spawnSync(
    "git",
    ["-C", directory, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"],
    {
      encoding: "utf8",
      env: gitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return !inspected.error && inspected.status === 0 ? inspected.stdout : undefined;
}

/** Only local Git objects and ref observations are used when preparing a rewrite. */
export function signingPublication(root: string) {
  if (gitBytes(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true")
    throw new StateConflict("Signing history requires complete ancestry. Fetch with --unshallow before retrying.");
  const tracking = gitBytes(root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes",
    observationRefs,
  ])
    .toString()
    .trim();
  const tracked = tracking.split("\n").filter(Boolean);
  const config = gitBytes(root, ["remote"]).toString().trim().split("\n").filter(Boolean);
  const known = new Set(tracked.map((row) => row.split(" ")[1] ?? ""));
  const tags = new Set<string>(),
    uncertain = new Set<string>(),
    observations: string[] = [tracking];
  for (const remote of config) {
    const fetchUrls = gitBytes(root, ["remote", "get-url", "--all", "--", remote]).toString().trim().split("\n");
    const pushUrls = gitBytes(root, ["remote", "get-url", "--push", "--all", "--", remote])
      .toString()
      .trim()
      .split("\n");
    const urls = new Set([...fetchUrls, ...pushUrls]);
    for (const url of urls) {
      observations.push(createHash("sha256").update(url).digest("hex"));
      const local = advertisedLocalRefs(root, url);
      if (local === undefined) {
        const namespace = `${observationRefs}/${remote}`;
        if (urls.size !== 1 || !tracked.some((row) => row.startsWith(`${namespace}/HEAD `))) uncertain.add(remote);
        continue;
      }
      observations.push(local);
      for (const row of local.split("\n")) {
        const [name, object] = row.split(" ");
        if (!name || !object) continue;
        if (!known.has(object) && !gitRevision(root, `${object}^{object}`))
          throw new StateConflict(`Fetch ${remote} before signing so its published history can be excluded.`);
        known.add(object);
        if (name.startsWith("refs/tags/")) tags.add(name);
      }
    }
    const prefix = `${observationRefs}/${remote}/tags/`;
    for (const row of tracked)
      if (row.startsWith(prefix)) tags.add(`refs/tags/${row.slice(prefix.length, row.indexOf(" "))}`);
  }
  const query = [...known]
    .filter(Boolean)
    .map((oid) => `${oid}^{commit}\n`)
    .join("");
  const commits = query
    ? gitBytes(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], query)
        .toString()
        .split("\n")
        .flatMap((row) => {
          const [object, type] = row.split(" ");
          return object && type === "commit" ? [object] : [];
        })
    : [];
  return { commits: [...new Set(commits)], tags, uncertain, observations };
}

export function checkSigningTags(
  publication: ReturnType<typeof signingPublication>,
  references: readonly string[],
): void {
  const tags = references.filter((ref) => ref.startsWith("refs/tags/"));
  if (!tags.length) return;
  const published = tags.filter((tag) => publication.tags.has(tag));
  if (published.length) throw new StateConflict(`Preserve published tags: ${published.join(", ")}`);
  const [remote] = publication.uncertain;
  if (remote !== undefined) {
    const prefix = `${observationRefs}/${remote}`;
    throw new StateConflict(
      [
        `Cannot establish whether affected tags have been published on ${remote}.`,
        `Fetch its current tags into ${prefix}/tags and its HEAD into ${prefix}/HEAD, then retry.`,
        `git fetch --prune --no-tags ${remote} '+HEAD:${prefix}/HEAD' '+refs/tags/*:${prefix}/tags/*'`,
      ].join("\n"),
    );
  }
}

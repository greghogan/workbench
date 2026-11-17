import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitBytes } from "../git/git-snapshot.js";
import { gitAncestor, gitRevision } from "../git/refs.js";

/** Observe the configured destinations without moving tracking refs or asking for credentials. */
const execute = promisify(execFile);
export async function taskRemovalPublication(root: string, branch: string, base: string, commits: readonly string[]) {
  const value = (args: string[]) => gitBytes(root, args).toString().trim();
  const names = value(["remote"]).split("\n").filter(Boolean);
  const affected = new Map<string, string>();
  const unknown = new Set<string>();
  const observations = createHash("sha256");
  const selected = `refs/heads/${branch}`;
  const upstream = value(["for-each-ref", "--format=%(upstream:remoteref)", selected]);
  const pushTarget = value(["for-each-ref", "--format=%(push:remoteref)", selected]);
  const destinations = new Set([selected, upstream, pushTarget]);
  for (const remote of names) {
    const fetch = value(["remote", "get-url", "--all", "--", remote]).split("\n");
    const push = value(["remote", "get-url", "--all", "--push", "--", remote]).split("\n");
    const urls = new Set([...fetch, ...push]);
    for (const [index, url] of [...urls].entries()) {
      const endpoint = urls.size > 1 ? `${remote} (endpoint ${String(index + 1)})` : remote;
      observations.update(JSON.stringify([remote, url]));
      let advertised: string;
      try {
        const result = await execute("git", ["-C", root, "ls-remote", "--refs", "--heads", "--tags", "--", url], {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        });
        advertised = result.stdout;
      } catch {
        unknown.add(endpoint);
        continue;
      }
      observations.update(advertised);
      for (const row of advertised.trim().split("\n").filter(Boolean)) {
        const [revision, ref] = row.split("\t");
        if (!revision || !ref) {
          unknown.add(endpoint);
          continue;
        }
        const tip = gitRevision(root, `${revision}^{commit}`);
        if (!tip) {
          unknown.add(endpoint);
          continue;
        }
        if (
          (destinations.has(ref) && !gitAncestor(root, tip, base)) ||
          commits.some((commit) => gitAncestor(root, commit, tip))
        ) {
          const label = `${endpoint}/${ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "tags/")}`;
          affected.set(label, revision);
        }
      }
    }
  }
  return { affected: [...affected], unknown: [...unknown], digest: observations.digest("hex") };
}

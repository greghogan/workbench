import { authenticateCatalog, type ArtifactSignature } from "./artifact-signatures.js";
import { download, execute } from "./tool-downloads.js";

export interface AptRepository {
  url: string;
  signature: ArtifactSignature;
  index: string;
  indexSha256: string;
  package: string;
  version: string;
  architecture: string;
}

/** Authenticate Release -> package index -> exact package, without changing the host's APT configuration. */
export async function authenticateRepository(
  repository: AptRepository,
  artifact: { url: string; sha256: string },
  staging: string,
  signal: AbortSignal,
): Promise<void> {
  const release = (await authenticateCatalog(repository, staging, signal)).toString("utf8");
  const section = /^SHA256:\r?\n((?:[ \t].*\r?\n)+)/m.exec(release)?.[1];
  const rows = section
    ?.trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/));
  const entries = rows?.filter((row) => row[2] === repository.index);
  const size = Number(entries?.[0]?.[1]);
  if (
    entries?.length !== 1 ||
    entries[0]?.[0] !== repository.indexSha256 ||
    entries[0].length !== 3 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 8 * 1024 ** 2
  )
    throw new Error("signed repository does not bind the pinned package index");
  const index = await download(
    { url: new URL(repository.index, repository.url).href, sha256: repository.indexSha256 },
    { signal, compressed: 8 * 1024 ** 2 },
  );
  const packages = execute("xz", ["--decompress", "--stdout", "--memlimit-decompress=128MiB", index], {
    capture: true,
    maxBuffer: 32 * 1024 ** 2,
    timeout: 30_000,
  });
  const matches = packages
    .split(/\r?\n\r?\n/)
    .map((stanza) =>
      Object.fromEntries(
        stanza
          .split(/\r?\n/)
          .filter((line) => /^[A-Za-z][A-Za-z0-9-]*: /.test(line))
          .map((line) => {
            const separator = line.indexOf(": ");
            return [line.slice(0, separator), line.slice(separator + 2)];
          }),
      ),
    )
    .filter(
      (entry) =>
        entry.Package === repository.package &&
        entry.Version === repository.version &&
        entry.Architecture === repository.architecture,
    );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    !entry?.Filename ||
    entry.SHA256 !== artifact.sha256 ||
    new URL(entry.Filename, `${repository.url.split("/dists/")[0] ?? ""}/`).href !== artifact.url
  )
    throw new Error("authenticated package index does not bind the expected package and digest");
}

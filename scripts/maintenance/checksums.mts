/** Fresh environment indexes replace the previous union; conflicting evidence blocks publication. */
export function mergeMavenChecksums(indexes: string[]): string {
  const hashes = new Map<string, string>();
  if (!indexes.length) throw new Error("No fresh Maven checksum indexes");
  for (const index of indexes) {
    let count = 0;
    for (const line of index.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
      if (!match?.[1] || !match[2]) throw new Error("Invalid Maven checksum entry");
      const [hash, path] = [match[1].toLowerCase(), match[2]];
      if (hashes.has(path) && hashes.get(path) !== hash) throw new Error(`Conflicting Maven checksum: ${path}`);
      hashes.set(path, hash);
      count++;
    }
    if (!count) throw new Error("Empty Maven checksum index");
  }
  return [...hashes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hash]) => `${hash}  ${path}\n`)
    .join("");
}

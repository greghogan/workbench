/** Explicit OCI registry locations; Docker supplies transport and credential handling. */
export function imageRepository(value: string): boolean {
  if (/\s/.test(value)) return false;
  const slash = value.indexOf("/");
  if (slash < 1) return false;
  const host = value.slice(0, slash);
  const path = value.slice(slash + 1);
  const registry = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/;
  if (!registry.test(host) || (!host.includes(".") && !host.includes(":") && host !== "localhost")) return false;
  return path.split("/").every((part) => /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/.test(part));
}

export function imageReference(value: string): boolean {
  if (/\s/.test(value)) return false;
  const colon = value.lastIndexOf(":");
  return (
    colon > value.lastIndexOf("/") &&
    imageRepository(value.slice(0, colon)) &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value.slice(colon + 1))
  );
}

/** The immutable pull must stay in the configured repository, including private registries and ports. */
export function verifiedRegistryReference(reference: string, published: string): string {
  const separator = reference.lastIndexOf(":");
  const repository = reference.slice(0, separator);
  if (
    separator <= reference.lastIndexOf("/") ||
    !/^[a-z0-9][a-z0-9./:_-]*$/.test(repository) ||
    !published.startsWith(repository + "@") ||
    !/^sha256:[a-f0-9]{64}$/.test(published.slice(repository.length + 1))
  )
    throw new Error("Immutable CI image identity does not match the configured registry repository");
  return published;
}

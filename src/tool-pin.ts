export interface ToolPin {
  repository: string;
  revision: string;
}
export function toolPin(value: unknown): ToolPin {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "repository,revision"
  )
    throw new Error("tool pin requires repository and revision fields");
  const pin = value as ToolPin;
  if (
    typeof pin.repository !== "string" ||
    typeof pin.revision !== "string" ||
    /[\s\\?#\p{Cc}]/u.test(pin.repository) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(pin.revision)
  )
    throw new Error("tool pin requires an HTTPS or SSH Git repository URL and a full immutable Git commit");
  let repository: URL;
  try {
    repository = new URL(pin.repository.replace(/^git\+/, ""));
  } catch {
    throw new Error("tool repository must be an HTTPS or SSH Git URL");
  }
  if (
    !["https:", "ssh:"].includes(repository.protocol) ||
    !repository.hostname ||
    repository.password ||
    (repository.protocol === "https:" && repository.username)
  )
    throw new Error("tool repository must be an HTTPS or SSH Git URL without embedded credentials");
  return { repository: `git+${repository.href}`, revision: pin.revision };
}
export function toolSpecification(value: unknown): string {
  const pin = toolPin(value);
  return `${pin.repository}#${pin.revision}`;
}

export function specificationPin(value: unknown): ToolPin | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("#");
  if (parts.length !== 2) return undefined;
  try {
    return toolPin({ repository: parts[0], revision: parts[1] });
  } catch {
    return undefined;
  }
}

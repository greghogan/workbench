import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function authorizationCheck(expected: string): (actual: string | undefined) => boolean {
  const digest = (header: string) => createHash("sha256").update(header).digest();
  const accepted = digest(expected);
  return (actual) => actual !== undefined && timingSafeEqual(digest(actual), accepted);
}

/** A private server's credential is valid only for that process's browser listener. */
export function createPrivateBrowserAuthentication() {
  const username = "workbench";
  const password = randomBytes(32).toString("base64url");
  const accepts = authorizationCheck(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  return {
    username,
    password,
    accepts: (authorization: string | undefined) => accepts(authorization?.replace(/^Basic +/i, "Basic ")),
  };
}

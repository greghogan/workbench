import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";

export const systemSignOutPath = "/sign-out";

export function isBrowserUsername(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[:\p{Cc}]/u.test(value);
}

export function localBrowserUsername(): string {
  const { username } = userInfo();
  if (!isBrowserUsername(username)) throw new Error("The OS account name cannot be used for browser sign-in");
  return username;
}

export function authorizationCheck(expected: string): (actual: string | undefined) => boolean {
  const digest = (header: string) => createHash("sha256").update(header).digest();
  const accepted = digest(expected);
  return (actual) => actual !== undefined && timingSafeEqual(digest(actual), accepted);
}

/** A private server's credential is valid only for that process's browser listener. */
export function createPrivateBrowserAuthentication() {
  const username = localBrowserUsername();
  const password = randomBytes(32).toString("base64url");
  const accepts = authorizationCheck(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  return {
    username,
    password,
    accepts: (authorization: string | undefined) => accepts(authorization?.replace(/^Basic +/i, "Basic ")),
  };
}

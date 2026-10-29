import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { userDirectory } from "./storage.js";
import { pomDocument, assertStandalonePom } from "./maven-pom.js";
import { assertMavenFiles } from "./maven-files.js";
import { isolatedMavenEnvironment } from "./maven-environment.js";
import { settleCleanup } from "../scripts/diagnostic-errors.mjs";
import { processCancellation, runOwnedChild } from "../scripts/owned-child.mjs";
import { processFailure } from "../scripts/process-outcome.mjs";
import { DigestStream, artifactLimits, withArtifactResponse, artifactUnavailable } from "./artifact-streams.js";
import { signatureVerifier } from "./artifact-signatures.js";
import type { SignatureEvidence } from "./signature-status.js";
import {
  acquisitionInputs,
  decodeMavenEvidence,
  mavenTrustRule,
  retainedMavenEvidence,
  type MavenEvidence,
} from "./maven-policy.js";
import { mavenArtifactPath, mavenChecksums, mavenDigest } from "./maven-artifacts.js";
import { nativeEnvironment } from "./native-tools.js";
import { distributionRoot } from "./project-context.js";
import { commandInvocation } from "./tool-execution.js";
import { withToolCacheUseAsync } from "./tool-cache-lock.js";
import { required } from "./invariants.js";
import { mavenBootstrapPlugin, mavenBootstrapPom } from "./maven-bootstrap.js";
import {
  assertMavenWorkspaceExternalCoordinates,
  mavenReactorPom,
  mavenWorkspaceExternalChecksums,
} from "./maven-workspace.js";

/** Preparation executes only its declared resolver; lifecycle and project extension code are excluded. */
export function checkMavenAcquisitionPom(pom: string): void {
  assertStandalonePom(pomDocument(pom));
}

/** A private repository mirror authenticates each artifact before Maven can read or load it. */
export async function prepareMavenDependencies(
  root: string,
  output: string,
): Promise<{ directory: string; artifacts: number }> {
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error(`Maven proposal already exists: ${destination}`);
  const inputs = acquisitionInputs(root);
  const { config, keys, policy, workspace, pom, frozen: frozenBytes } = inputs;
  checkMavenAcquisitionPom(pom.toString("utf8"));
  const bootstrap = mavenBootstrapPlugin(pom, config.resolver);
  const known = workspace
    ? mavenWorkspaceExternalChecksums(workspace)
    : frozenBytes
      ? mavenChecksums(frozenBytes.toString("utf8"))
      : new Map<string, string>();
  if (workspace) assertMavenWorkspaceExternalCoordinates(workspace, known);
  const retained = retainedMavenEvidence(inputs, known);
  const previousChecksums = frozenBytes ? mavenDigest(frozenBytes) : null;
  mkdirSync(dirname(destination), { recursive: true });
  const scratch = mkdtempSync(join(dirname(destination), ".maven-preparation-"));
  const cleanup = { preserveScratch: false };
  let preparationFailure: unknown;
  try {
    const repository = join(scratch, "repository"),
      downloads = join(scratch, "verified"),
      project = join(scratch, "project");
    for (const directory of [repository, downloads, project]) mkdirSync(directory);
    const sourcePoms = new Map<string, string>();
    const sourcePrefixes = new Set<string>();
    if (workspace) {
      const modules = [workspace.consumer, ...workspace.sources];
      const names = modules.map((_, index) => `source-${String(index)}`);
      writeFileSync(join(project, "pom.xml"), mavenReactorPom(names));
      for (const [index, module] of modules.entries()) {
        checkMavenAcquisitionPom(module.pom.toString("utf8"));
        const directory = join(project, required(names[index], "Maven source metadata directory"));
        mkdirSync(directory);
        const file = join(directory, "pom.xml");
        writeFileSync(file, mavenBootstrapPom(module.pom, bootstrap));
        sourcePoms.set(module.pomPath, file);
        sourcePrefixes.add(module.pomPath.slice(0, module.pomPath.lastIndexOf("/") + 1));
      }
    } else writeFileSync(join(project, "pom.xml"), pom);
    const cancellation = processCancellation();
    const controller = new AbortController();
    const signal = AbortSignal.any([cancellation.signal, controller.signal]);
    const evidence = new Map<string, MavenEvidence>();
    const pending = new Map<string, Promise<string>>();
    let authenticationFailure: Error | undefined;
    const acquire = (path: string): Promise<string> => {
      const existing = pending.get(path);
      if (existing) return existing;
      let incomplete: string | undefined;
      const request = (async () => {
        const artifactSignal = AbortSignal.any([signal, AbortSignal.timeout(artifactLimits.milliseconds)]);
        mavenArtifactPath(path);
        const sourcePom = sourcePoms.get(path);
        if (sourcePom) return sourcePom;
        if ([...sourcePrefixes].some((prefix) => path.startsWith(prefix)))
          throw new Error(`Maven acquisition requested a source build output: ${path}`);
        const url = `https://maven-central.storage-download.googleapis.com/maven2/${path}`;
        const rule = mavenTrustRule(config, path);
        const expected = known.get(path);
        if (!expected && !rule)
          throw new Error(
            `No declared Maven authentication for ${path}; add its publisher identity and signature policy to .mvn/acquisition.json`,
          );
        const target = join(downloads, path);
        incomplete = target;
        mkdirSync(dirname(target), { recursive: true });
        const consume = async (bytes: Readable) => {
          rmSync(target, { force: true });
          let verifier: Awaited<ReturnType<typeof signatureVerifier>> | undefined, failure: unknown;
          try {
            if (!expected && rule?.keys) {
              try {
                verifier = await signatureVerifier(
                  {
                    url: `${url}.asc`,
                    keys: required(keys.get(rule.keys), "Maven public key"),
                    signers: required(rule.signers, "Maven signers"),
                  },
                  artifactSignal,
                );
              } catch (error) {
                if (artifactUnavailable(error))
                  throw new Error(
                    `Declared Maven signing evidence is unavailable for ${path}; no unsigned fallback is permitted`,
                    { cause: error },
                  );
                throw error;
              }
            }
            const digest = new DigestStream(artifactLimits.file, "Maven artifact");
            const outputStream = createWriteStream(target, { flags: "wx", mode: 0o600 });
            if (verifier) await pipeline(bytes, verifier.relay, digest, outputStream, { signal: artifactSignal });
            else await pipeline(bytes, digest, outputStream, { signal: artifactSignal });
            const sha256 = digest.hash.digest("hex");
            if (expected && expected !== sha256) throw new Error(`Maven checksum mismatch: ${path}`);
            let signatures: SignatureEvidence[] | undefined;
            if (verifier)
              try {
                signatures = await verifier.finish();
              } catch (error) {
                throw new Error(`Maven signature verification failed for ${path}`, { cause: error });
              }
            return { sha256, signatures };
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            await settleCleanup([() => verifier?.cancel()], failure);
          }
        };
        const cached = join(
          process.env.WORKBENCH_MAVEN_REPOSITORY ?? join(userDirectory("cache"), "downloads/maven"),
          path,
        );
        const proof =
          expected && existsSync(cached)
            ? await consume(createReadStream(cached))
            : await withArtifactResponse(url, consume, artifactSignal);
        const { sha256, signatures } = proof;
        evidence.set(
          path,
          retained.get(path) ??
            decodeMavenEvidence({
              path,
              sha256,
              authentication: expected ? "reviewed-pin" : signatures ? "signature" : "unavailable",
              identity: expected ? "Previously reviewed project checksum" : rule?.identity,
              ...(signatures ? { proof: `${url}.asc`, signatures } : {}),
              ...(!expected && rule?.unavailable && !signatures ? { reason: rule.unavailable } : {}),
            }),
        );
        return target;
      })().catch(async (error: unknown) => {
        if (!artifactUnavailable(error))
          authenticationFailure ??= error instanceof Error ? error : new Error(String(error));
        await settleCleanup(
          [
            () => {
              if (incomplete) rmSync(incomplete, { force: true });
            },
          ],
          error,
        );
        throw error;
      });
      pending.set(path, request);
      return request;
    };
    const token = randomUUID();
    const server = createServer((request, response) => {
      void (async () => {
        if (!["GET", "HEAD"].includes(request.method ?? "") || !request.url?.startsWith(`/${token}/`)) {
          response.writeHead(404).end();
          return;
        }
        const resource = request.url.slice(token.length + 2);
        const checksum = /\.(sha1|sha256|sha512|md5)$/.exec(resource);
        const path = checksum ? resource.slice(0, -checksum[0].length) : resource;
        if (!/\.(?:pom|jar)$/.test(path)) {
          response.writeHead(404).end();
          return;
        }
        try {
          const verified = await acquire(path);
          if (checksum?.[1]) {
            const hash = createHash(checksum[1]);
            for await (const chunk of createReadStream(verified, { signal })) hash.update(chunk as Buffer);
            response.end(hash.digest("hex"));
          } else if (request.method === "HEAD") response.end();
          else await pipeline(createReadStream(verified), response, { signal });
        } catch (error) {
          if (!response.destroyed && !artifactUnavailable(error))
            authenticationFailure ??= error instanceof Error ? error : new Error(String(error));
          if (!response.headersSent) response.writeHead(artifactUnavailable(error) ? 404 : 502);
          response.end("Maven input unavailable; inspect the preparation diagnostic.");
        }
      })().catch((error: unknown) => {
        authenticationFailure ??= error instanceof Error ? error : new Error(String(error));
        response.destroy();
      });
    });
    let operationFailure: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Maven preparation needs a local listener");
      const settings = join(scratch, "settings.xml");
      writeFileSync(
        settings,
        `<settings><mirrors><mirror><id>workbench-verified</id><mirrorOf>*</mirrorOf><url>http://127.0.0.1:${String(address.port)}/${token}/</url></mirror></mirrors></settings>`,
      );
      await withToolCacheUseAsync(async () => {
        const env = isolatedMavenEnvironment(nativeEnvironment(root, distributionRoot(root)), project);
        const command = commandInvocation(
          "mvn",
          [
            "--batch-mode",
            "--strict-checksums",
            "--no-transfer-progress",
            "--settings",
            settings,
            "--global-settings",
            settings,
            `-Dmaven.repo.local=${repository}`,
            ...(workspace ? ["-pl", "source-0", "-am", "-DexcludeReactor=true"] : []),
            config.resolver,
          ],
          env,
          project,
        );
        const result = await runOwnedChild(required(command[0], "Maven command"), command.slice(1), {
          cwd: project,
          env,
          signal,
          stopDescendantsOnExit: true,
        });
        const failure = processFailure("Maven dependency preparation", result);
        if (result.descendantsActive) {
          cleanup.preserveScratch = true;
          throw new Error(`Maven termination is unproven; preserving preparation state: ${scratch}`, {
            cause: failure ?? new Error("Maven descendants remain active"),
          });
        }
        if (!failure) await Promise.allSettled(pending.values());
        if (authenticationFailure) throw authenticationFailure;
        if (failure) throw failure;
      });
      signal.throwIfAborted();
      assertMavenFiles(inputs.files);
      if (!evidence.size) throw new Error("Maven resolver produced no authenticated artifacts");
      rmSync(repository, { recursive: true });
      rmSync(project, { recursive: true });
      rmSync(settings);
      renameSync(downloads, repository);
      const entries = [...evidence.values()].sort((a, b) => a.path.localeCompare(b.path));
      const checksumBytes = Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""));
      writeFileSync(join(scratch, "checksums.sha256"), checksumBytes);
      writeFileSync(
        join(scratch, "authentication.json"),
        JSON.stringify(
          {
            schema: 1,
            checksumSHA256: mavenDigest(checksumBytes),
            preparedAt: new Date().toISOString(),
            pom: mavenDigest(pom),
            policy,
            previousChecksums,
            resolver: config.resolver,
            artifacts: entries,
          },
          null,
          2,
        ) + "\n",
      );
      signal.throwIfAborted();
      renameSync(scratch, destination);
      return { directory: destination, artifacts: entries.length };
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      await settleCleanup(
        [
          () => {
            controller.abort();
          },
          () => {
            server.closeAllConnections();
          },
          () =>
            new Promise<void>((resolve, reject) => {
              server.close((error?: Error) => {
                if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
                else resolve();
              });
            }),
          async () => {
            await Promise.allSettled(pending.values());
          },
          cancellation.close,
        ],
        operationFailure,
      );
    }
  } catch (error) {
    preparationFailure = error;
    throw error;
  } finally {
    await settleCleanup(
      [
        () => {
          if (!cleanup.preserveScratch) rmSync(scratch, { recursive: true, force: true });
        },
      ],
      preparationFailure,
    );
  }
}

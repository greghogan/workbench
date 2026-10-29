import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { expect, test, vi } from "vitest";
import { runtimeBuildEnvironment } from "../src/runtime-builds.ts";
import { execute } from "../src/tool-execution.ts";

test("native runtime build children receive host tools and authentication without shell build overrides", () => {
  const caller = {
    ...process.env,
    PATH: "/caller/toolchain",
    LIBRARY_PATH: "/caller/libraries",
    CPATH: "/caller/headers",
    C_INCLUDE_PATH: "/caller/headers",
    LD_LIBRARY_PATH: "/caller/runtime",
    LD_PRELOAD: "/caller/preload.so",
    PKG_CONFIG_PATH: "/caller/pkgconfig",
    PKG_CONFIG_LIBDIR: "/caller/pkgconfig",
    PKG_CONFIG_SYSROOT_DIR: "/caller/sysroot",
    CC: "/caller/cc",
    CXX: "/caller/cxx",
    CFLAGS: "--caller-flags",
    CPPFLAGS: "--caller-flags",
    LDFLAGS: "--caller-flags",
    MAKEFLAGS: "--caller-flags",
    CONFIG_SITE: "/caller/config.site",
    RUBYOPT: "--caller-flags",
    SDKROOT: "/caller/sdk",
    HTTPS_PROXY: "https://proxy.invalid",
    SSL_CERT_FILE: "/host/certificates",
  };
  const env = runtimeBuildEnvironment(execute, caller, "linux");
  const child = spawnSync(process.execPath, ["-p", "JSON.stringify(process.env)"], { env, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  const observed = JSON.parse(child.stdout) as Record<string, string>;
  expect(observed.PATH?.split(delimiter)).toContain("/usr/bin");
  expect(Object.values(observed).some((value) => value.includes("/caller/") || value.includes("--caller-flags"))).toBe(
    false,
  );
  expect(observed.HOME).toBe(process.env.HOME);
  expect(observed.HTTPS_PROXY).toBe(caller.HTTPS_PROXY);
  expect(observed.SSL_CERT_FILE).toBe(caller.SSL_CERT_FILE);
  expect(caller.LIBRARY_PATH).toBe("/caller/libraries");
});

test("macOS package discovery reconstructs host library search paths without inheriting caller paths", () => {
  const run = vi.fn<typeof execute>((_command, args) => `/host/packages/${args[1] ?? "missing"}\n`);
  const env = runtimeBuildEnvironment(run, { PATH: "/caller/bin", PKG_CONFIG_PATH: "/caller/pkgconfig" }, "darwin");
  expect(env.PKG_CONFIG_PATH?.split(delimiter)).toContain(join("/host/packages/openssl@3", "lib/pkgconfig"));
  expect(env.PKG_CONFIG_PATH).not.toContain("/caller/");
  for (const [command, args, options] of run.mock.calls) {
    expect(command).toBe("brew");
    expect(args[0]).toBe("--prefix");
    expect(options?.env?.PATH).not.toContain("/caller/");
    expect(options?.capture).toBe(true);
  }
  expect(() => runtimeBuildEnvironment(() => "", {}, "darwin")).toThrow("Invalid host package prefix");
});

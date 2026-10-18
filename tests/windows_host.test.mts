import { expect, test } from "vitest";
import { normalizeWindowsPaths, windowsGitExecutable, windowsGitDirectories } from "../src/windows-host.ts";

test.each(["mingw64", "ucrt64", "clangarm64"])("%s Git uses its own native tools and MSYS utilities", (runtime) => {
  const bin = `C:\\Git\\${runtime}\\bin`;
  const utilities = "C:\\Git\\usr\\bin";
  const calls: unknown[] = [];
  const directories = windowsGitDirectories(`${bin}\\git.exe`, {
    exists: (path) => path === `${utilities}\\bash.exe`,
    canonical: (path) => {
      calls.push(path);
      return path;
    },
  });
  expect(directories).toEqual([bin, utilities]);
  expect(calls).toEqual([utilities]);
});
test("an unrelated Git installation does not claim MSYS utilities", () => {
  expect(
    windowsGitDirectories("C:\\custom\\git.exe", {
      exists: () => false,
      canonical: () => {
        throw new Error("must not canonicalize absent tools");
      },
    }),
  ).toEqual([]);
});

test("MSYS-native Git does not infer an MSYSTEM from its usr directory", () => {
  expect(
    windowsGitDirectories("C:\\msys64\\usr\\bin\\git.exe", {
      exists: (path) => path === "C:\\msys64\\usr\\bin\\bash.exe",
      canonical: () => {
        throw new Error("MSYS Git must retain its caller context");
      },
    }),
  ).toEqual([]);
});

test.each(["C:\\Git\\cmd\\git.exe", "C:\\Git\\mingw64\\bin\\git.exe"])(
  "Windows Git %s selects its native installation with a controlled probe",
  (executable) => {
    const source = { PATH: "caller", Git_Exec_Path: "caller override" };
    const calls: unknown[] = [];
    const selected = windowsGitExecutable(executable, source, {
      probe: (path, env) => {
        calls.push({ path, env });
        return { status: 0, stdout: "C:/Git/mingw64/libexec/git-core\n" };
      },
      exists: (path) => path === "C:\\Git\\mingw64\\bin\\git.exe",
      canonical: (path) => path,
    });
    expect(selected).toBe("C:\\Git\\mingw64\\bin\\git.exe");
    expect(calls).toEqual([{ path: executable, env: { PATH: "caller" } }]);
    expect(source.Git_Exec_Path).toBe("caller override");
  },
);
test.each([
  { status: 1, stdout: "" },
  { status: 0, stdout: "" },
  { status: 0, stdout: "C:/missing" },
])("unavailable Windows Git metadata retains the selected executable", (result) => {
  expect(
    windowsGitExecutable(
      "C:\\Git\\git.exe",
      {},
      {
        probe: () => result,
        exists: () => false,
        canonical: () => {
          throw new Error("must not canonicalize missing paths");
        },
      },
    ),
  ).toBe("C:\\Git\\git.exe");
});
test("Windows path normalization changes only existing absolute platform paths", () => {
  const env = { TMPDIR: "C:/TEMP~1", HOME: "C:/missing", TEMP: "relative", CUSTOM: "C:/TEMP~1" };
  normalizeWindowsPaths(
    env,
    () => "C:\\Temporary Files",
    (path) => path === "C:/TEMP~1",
  );
  expect(env).toEqual({ TMPDIR: "C:\\Temporary Files", HOME: "C:/missing", TEMP: "relative", CUSTOM: "C:/TEMP~1" });
});

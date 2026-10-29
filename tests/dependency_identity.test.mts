import { expect, test } from "vitest";
import { dependencyInputHash } from "../scripts/dependency-identity.mts";

const hash = (value: unknown) => dependencyInputHash("package.json", Buffer.from(JSON.stringify(value)));

test("dependency identity ignores manifest presentation and ordinary project commands", () => {
  const manifest = { name: "example", dependencies: { b: "2", a: "1" }, scripts: { format: "old formatter" } };
  const before = hash(manifest);
  expect(
    dependencyInputHash(
      "nested/package.json",
      Buffer.from(
        '{\n  "scripts": {"format": "new formatter"}, "dependencies": {"a":"1", "b":"2"}, "name":"example"\n}\n',
      ),
    ),
  ).toBe(before);
  expect(hash({ name: "example", dependencies: { a: "1", b: "2" } })).toBe(before);
});

test("dependency declarations, manager policy, platform constraints and array order remain significant", () => {
  for (const field of ["dependencies", "optionalDependencies", "packageManager", "engines", "os", "cpu", "custom"])
    expect(hash({ [field]: "changed" }), field).not.toBe(hash({ [field]: "original" }));
  expect(hash({ os: ["linux", "darwin"] })).not.toBe(hash({ os: ["darwin", "linux"] }));
});

test.each(["exports", "imports", "typesVersions", "overrides", "custom"])(
  "%s preserves potentially meaningful object-key order",
  (field) => {
    expect(hash({ [field]: { node: "node.js", default: "fallback.js" } })).not.toBe(
      hash({ [field]: { default: "fallback.js", node: "node.js" } }),
    );
  },
);

test.each(["preinstall", "install", "postinstall", "prepare", "prepublish", "pnpm:devPreinstall"])(
  "%s preserves its script and scripts it may invoke",
  (hook) => {
    const scripts = { [hook]: "npm run compile", compile: "old compiler", format: "old formatter" };
    const before = hash({ scripts });
    expect(hash({ scripts: { ...scripts, [hook]: "different hook" } })).not.toBe(before);
    expect(hash({ scripts: { ...scripts, compile: "new compiler" } })).not.toBe(before);
    expect(hash({ scripts: { ...scripts, format: "new formatter" } })).not.toBe(before);
    expect(hash({ scripts: { compile: "old compiler", format: "old formatter" } })).not.toBe(before);
  },
);

test("unsafe numbers never collapse into an indistinguishable JSON representation", () => {
  for (const [a, b] of [
    ['{"value":9007199254740992}', '{"value":9007199254740993}'],
    ['{"value":1e999}', '{"value":null}'],
    ['{"value":-0}', '{"value":0}'],
  ] as const) {
    expect(dependencyInputHash("package.json", Buffer.from(a))).not.toBe(
      dependencyInputHash("package.json", Buffer.from(b)),
    );
  }
});

test("unrecognized inputs retain exact bytes and malformed manifests fail closed", () => {
  const a = Buffer.from('{"a":1,"b":2}'),
    b = Buffer.from('{ "b": 2, "a": 1 }\n');
  expect(dependencyInputHash("signed.json", a)).not.toBe(dependencyInputHash("signed.json", b));
  expect(dependencyInputHash("pin", a)).not.toBe(dependencyInputHash("pin", b));
  for (const invalid of ["{broken", "null", "[]"])
    expect(() => dependencyInputHash("package.json", Buffer.from(invalid))).toThrow();
});

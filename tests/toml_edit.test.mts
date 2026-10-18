import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse, type TomlValue, type TomlTable } from "smol-toml";
import { parseTOML } from "toml-eslint-parser";
import { editToml } from "../src/toml-edit.ts";
import { required } from "../src/invariants.ts";

type Path = (string | number)[];
const astFor = (text: string) => parseTOML(text, { tomlVersion: "1.1.0" });
function table(value: TomlValue | undefined): value is TomlTable {
  return value !== undefined && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}
function at(document: TomlTable, path: Path): TomlValue | undefined {
  let value: TomlValue | undefined = document;
  for (const key of path)
    value =
      Array.isArray(value) && typeof key === "number"
        ? value[key]
        : table(value) && typeof key === "string"
          ? value[key]
          : undefined;
  return value;
}
function replace(document: TomlTable, path: Path, value: TomlValue | undefined): void {
  const key = required(path.at(-1), "Fixture path");
  const parent = at(document, path.slice(0, -1));
  if (Array.isArray(parent) && typeof key === "number") {
    if (value === undefined) parent.splice(key, 1);
    else parent[key] = value;
  } else if (table(parent) && typeof key === "string") {
    if (value === undefined) Reflect.deleteProperty(parent, key);
    else parent[key] = value;
  } else {
    const head = path[0];
    assert.equal(typeof head, "string");
    if (typeof head !== "string") throw new Error("Missing fixture parent");
    document[head] = {};
    replace(document, path, value);
  }
}
function set(text: string, path: Path, value: TomlValue): string {
  const desired = parse(text);
  replace(desired, path, value);
  return editToml(text, desired);
}
const patch = set;
function remove(text: string, path: Path): string {
  const desired = parse(text);
  replace(desired, path, undefined);
  return editToml(text, desired);
}
function appendArray(text: string, path: Path, value: TomlValue): string {
  const desired = parse(text);
  const array = at(desired, path);
  assert.ok(Array.isArray(array));
  array.push(value);
  return editToml(text, desired);
}
function appendTable(text: string, path: Path, value: TomlTable): string {
  return appendArray(text, path, value);
}
function collectionIndex(text: string, id: string): number {
  const sources = at(parse(text), ["collections", "sources"]);
  assert.ok(Array.isArray(sources));
  const index = sources.findIndex((row) => table(row) && row.id === id);
  assert.ok(index >= 0);
  return index;
}
function reorderTables(text: string, path: Path, ids: string[]): string {
  const desired = parse(text);
  const rows = at(desired, path);
  assert.ok(Array.isArray(rows));
  replace(
    desired,
    path,
    ids.map((id) =>
      required(
        rows.find((row) => table(row) && row.id === id),
        "Fixture table",
      ),
    ),
  );
  return editToml(text, desired);
}
const semantic = (actual: unknown, expected: unknown): void => {
  assert.deepEqual(structuredClone(actual), structuredClone(expected));
};
const comments = (source: string): string[] => astFor(source).comments.map((node) => source.slice(...node.range));
function preserved(before: string, after: string): void {
  assert.deepEqual(comments(after), comments(before));
}
test("quoted dotted key changes only value bytes", () => {
  const text = '# lead\n["a.b"] # head\n"x.y".z = 0x10 # inline\n# end\n';
  const after = set(text, ["a.b", "x.y", "z"], 17);
  assert.equal(after, text.replace("0x10", "17"));
});
test("multiline literal hash stays string, not comment", () => {
  const text = "# lead\n[a]\nx = '''a\n# inside string\nb''' # outside\ny= 1\n";
  const after = set(text, ["a", "x"], "changed");
  preserved(text, after);
  assert.ok(after.endsWith(" # outside\ny= 1\n"));
});
test("UTF16 ranges handle Unicode before and in value", () => {
  const text = '# 🐈\n"🐈" = "old🐈" # 🐈 tail\n';
  assert.equal(set(text, ["🐈"], "new"), text.replace('"old🐈"', '"new"'));
});
test("CRLF scalar update keeps exact bytes", () => {
  const text = "# lead\r\n[x]\r\na=1 # inline\r\nb=2\r\n";
  assert.equal(set(text, ["x", "a"], 3), text.replace("a=1", "a=3"));
});
test("CRLF insertion preserves original line endings", () => {
  const text = "# lead\r\n[x] # header\r\na=1 # inline\r\n[y]\r\nb=2\r\n";
  const after = set(text, ["x", "new"], true);
  assert.ok(after.includes("a=1 # inline\r\nnew = true\r\n[y]"));
  assert.ok(!/(?<!\r)\n/.test(after));
  preserved(text, after);
});
test("new implicit root field is inserted before later tables", () => {
  const text = "# lead\na.b=1 # existing\n[other]\nx=2\n";
  const after = set(text, ["a", "c"], 3);
  semantic(parse(after), { a: { b: 1, c: 3 }, other: { x: 2 } });
  preserved(text, after);
});
test("new field in empty table preserves header comment", () => {
  const text = "[x] # header\n\n[y]\na=1\n";
  const after = set(text, ["x", "new"], true);
  assert.ok(after.startsWith("[x] # header\nnew = true\n"));
  preserved(text, after);
});
test("new field after EOF comment cannot swallow the insertion", () => {
  const text = "[x]\na=1 # eof";
  const after = set(text, ["x", "new"], true);
  assert.ok(after.includes("# eof\nnew = true\n"));
  preserved(text, after);
});
test("new top level setting in comment-only file", () => {
  const text = "# comment only";
  const after = set(text, ["a"], 1);
  assert.equal(after, "# comment only\na = 1\n");
  preserved(text, after);
});
test("deletion retains leading inline and trailing comments", () => {
  const text = "# lead\nx = 1 # inline\n# trailing\ny = 2\n";
  const after = remove(text, ["x"]);
  semantic(parse(after), { y: 2 });
  preserved(text, after);
  assert.ok(after.endsWith("# trailing\ny = 2\n"));
});
test("deletion of commented multiline array keeps all comments", () => {
  const text = "x = [\n 1, # one\n # rationale\n 2, # two\n] # list\ny=3\n";
  const after = remove(text, ["x"]);
  semantic(parse(after), { y: 3 });
  preserved(text, after);
});
test("deletion of whole section keeps nested and header comments", () => {
  const text = "[a] # head\nx=1 # value\n[a.nested] # nested\ny=2\n[b]\nz=3\n";
  const after = remove(text, ["a"]);
  semantic(parse(after), { b: { z: 3 } });
  preserved(text, after);
});
test("array element value update preserves interior comments", () => {
  const text = 'a=[\n "old", # first\n "other" # second\n]\n';
  assert.equal(set(text, ["a", 0], "new"), text.replace('"old"', '"new"'));
});
for (const [name, text] of [
  ["comma", "a=[1, # one\n2, # two\n]\n"],
  ["no comma", "a=[1, # one\n2 # two\n]\n"],
  ["empty", "a=[# reason\n]\n"],
] as const)
  test(`array append ${name}`, () => {
    const after = appendArray(text, ["a"], 3);
    preserved(text, after);
    const expected = name === "empty" ? [3] : [1, 2, 3];
    semantic(parse(after), { a: expected });
  });
for (const index of [0, 1, 2])
  test(`remove array element ${String(index)} retains all comments`, () => {
    const text = "a=[\n 1, # one\n 2, # two\n 3 # three\n]\n";
    const after = remove(text, ["a", index]);
    semantic(parse(after), { a: [1, 2, 3].filter((_, i) => i !== index) });
    preserved(text, after);
  });
test("inline table keyed leaf update", () => {
  const text = 'a={ "a.b" = 1, b={x=2} } # outside\n';
  assert.equal(set(text, ["a", "b", "x"], 3), text.replace("x=2", "x=3"));
});
test("inline table insertion", () => {
  const text = "a={x=1} # outside\n";
  const after = set(text, ["a", "y"], 2);
  semantic(parse(after), { a: { x: 1, y: 2 } });
  preserved(text, after);
});
for (const key of ["a", "b", "c"])
  test(`inline table delete ${key}`, () => {
    const text = "v={ a=1, b=2, c=3 } # outside\n";
    const after = remove(text, ["v", key]);
    const expected: Record<string, number> = { a: 1, b: 2, c: 3 };
    Reflect.deleteProperty(expected, key);
    semantic(parse(after), { v: expected });
    preserved(text, after);
  });
test("TOML1.1 multiline inline-table comment edit and deletion", () => {
  const text = "v={\n a=1, # a\n b=2, # b\n} # outside\n";
  const after = remove(set(text, ["v", "b"], 3), ["v", "a"]);
  semantic(parse(after), { v: { b: 3 } });
  preserved(text, after);
});
test("TOML1.1 escape and optional seconds support", () => {
  const text = 'escape="\\e\\x41"\nwhen=1979-05-27T07:32Z\ntime=07:32\nx=1\n';
  const after = set(text, ["x"], 2);
  assert.equal(after, text.replace("x=1", "x=2"));
  preserved(text, after);
});
const collections =
  '# lead\n[unrelated]\nx=0x10 # keep exact\n\n[[collections.sources]] # alpha header\nid="alpha" # id alpha\nsha256="old" # trust alpha\nscopes=[\n ".", # root\n] # scope\n[collections.sources.extra] # nested alpha\nx=1 # extra alpha\n\n[[collections.sources]] # beta header\nid="beta" # id beta\nsha256="stable" # trust beta\n';
test("collection reconciliation changes selected identity only", () => {
  const index = collectionIndex(collections, "alpha");
  const after = set(collections, ["collections", "sources", index, "sha256"], "updated");
  assert.equal(after, collections.replace('sha256="old"', 'sha256="updated"'));
  preserved(collections, after);
});
test("collection removal includes nested tables and preserves comments", () => {
  const after = remove(collections, ["collections", "sources", collectionIndex(collections, "alpha")]);
  const expected = parse(collections);
  const group = expected.collections;
  assert.ok(group && typeof group === "object");
  Reflect.set(group, "sources", [{ id: "beta", sha256: "stable" }]);
  semantic(parse(after), expected);
  preserved(collections, after);
});
test("collection append retains all previous bytes", () => {
  const after = appendTable(collections, ["collections", "sources"], { id: "gamma", sha256: "next", scopes: ["."] });
  assert.ok(after.startsWith(collections));
  assert.equal(collectionIndex(after, "gamma"), 2);
  preserved(collections, after);
});
test("container type replacement retains interior comments before its declaration", () => {
  const text = "a=[1, # keep\n2]\n";
  const after = set(text, ["a"], true);
  semantic(parse(after), { a: true });
  preserved(text, after);
});
test("real repository configuration changes only declared field", () => {
  const text = readFileSync("workbench/config.toml", "utf8");
  assert.equal(set(text, ["markdown", "wrap_width"], 121), text.replace("wrap_width = 120", "wrap_width = 121"));
});
test("whole array patch preserves interior comments while removing and adding", () => {
  const text = "a=[\n 1, # one\n 2, # two\n 3 # three\n]\n";
  const after = patch(text, ["a"], [4, 5]);
  semantic(parse(after), { a: [4, 5] });
  preserved(text, after);
  const added = patch(after, ["a"], [4, 5, 6, 7]);
  semantic(parse(added), { a: [4, 5, 6, 7] });
  preserved(text, added);
});
test("collection reordering moves internal comments with their row", () => {
  const after = reorderTables(collections, ["collections", "sources"], ["beta", "alpha"]);
  assert.equal(collectionIndex(after, "beta"), 0);
  assert.equal(collectionIndex(after, "alpha"), 1);
  assert.ok(after.includes('[[collections.sources]] # alpha header\nid="alpha" # id alpha'));
  assert.deepEqual([...comments(after)].sort(), [...comments(collections)].sort());
});
test("explicit collection reordering keeps leading comments with their row", () => {
  const source = '# Document context\n\n# Alpha context\n[[rows]]\nid="alpha"\n# Beta context\n[[rows]]\nid="beta"\n';
  const result = reorderTables(source, ["rows"], ["beta", "alpha"]);
  assert.equal(
    result,
    '# Document context\n\n# Beta context\n[[rows]]\nid="beta"\n# Alpha context\n[[rows]]\nid="alpha"\n',
  );
});
test("explicit inline row reordering keeps adjacent comments with their row", () => {
  const source = 'rows=[\n# Alpha context\n{id="alpha"},\n# Beta context\n{id="beta"}\n]\n';
  const result = reorderTables(source, ["rows"], ["beta", "alpha"]);
  assert.equal(result, 'rows=[\n# Beta context\n{id="beta"},\n# Alpha context\n{id="alpha"}\n]\n');
});
test("collection edits can update values while explicitly reordering rows", () => {
  const after = patch(
    collections,
    ["collections", "sources"],
    [
      { id: "beta", sha256: "stable" },
      { id: "alpha", sha256: "updated", scopes: [".", "new"], extra: { x: 1 } },
    ],
  );
  const group = parse(after).collections;
  assert.ok(group && typeof group === "object");
  semantic(Reflect.get(group, "sources"), [
    { id: "beta", sha256: "stable" },
    { id: "alpha", sha256: "updated", scopes: [".", "new"], extra: { x: 1 } },
  ]);
  assert.deepEqual([...comments(after)].sort(), [...comments(collections)].sort());
});
test("collection reconciliation deletes an old identity and adds a new one", () => {
  const after = patch(
    collections,
    ["collections", "sources"],
    [
      { id: "beta", sha256: "stable" },
      { id: "gamma", sha256: "new", scopes: ["."] },
    ],
  );
  assert.equal(collectionIndex(after, "gamma"), 1);
  assert.deepEqual([...comments(after)].sort(), [...comments(collections)].sort());
});
test("collection reconciliation deletes last row and leaves explicit empty list", () => {
  const after = patch(collections, ["collections", "sources"], []);
  const group = parse(after).collections;
  assert.ok(group && typeof group === "object");
  semantic(Reflect.get(group, "sources"), []);
  preserved(collections, after);
});

test("collection reconciliation preserves interleaved unrelated tables", () => {
  const source =
    '[[collections.sources]] # alpha\nid="alpha"\n[unrelated] # preserve placement\nx=0x10\n[collections.sources.extra] # alpha extra\nx=1\n[[collections.sources]] # beta\nid="beta"\n';
  const result = reorderTables(source, ["collections", "sources"], ["beta", "alpha"]);
  assert.ok(result.includes("[unrelated] # preserve placement\nx=0x10\n"));
  semantic(parse(result), {
    collections: { sources: [{ id: "beta" }, { id: "alpha", extra: { x: 1 } }] },
    unrelated: { x: 16 },
  });
  assert.deepEqual([...comments(source)].sort(), [...comments(result)].sort());
});

test("identity reconciliation works with commented inline table arrays", () => {
  const source =
    'sources=[{\nid="alpha", # identity alpha\nsha="old",\n}, {\nid="beta", # identity beta\nsha="stable",\n}]\n';
  const result = patch(
    source,
    ["sources"],
    [
      { id: "beta", sha: "stable" },
      { id: "alpha", sha: "updated" },
    ],
  );
  semantic(parse(result), {
    sources: [
      { id: "beta", sha: "stable" },
      { id: "alpha", sha: "updated" },
    ],
  });
  assert.ok(result.includes('id="alpha", # identity alpha\nsha="updated"'));
  assert.deepEqual([...comments(source)].sort(), [...comments(result)].sort());
});

test("unchanged dates, numeric notation and table arrays remain byte identical", () => {
  const source =
    '# source\nx=0x10\ny=+inf\nz=nan\ndate=1979-05-27T07:32:00-07:00\nlocal=07:32:00\n[[rows]] # row\nname="first"\n';
  assert.equal(editToml(source, parse(source)), source);
});

test("root insertion preserves indentation of the following table", () => {
  const source = "  [other] # header\nx=1\n";
  const result = set(source, ["new"], true);
  assert.ok(result.endsWith(source));
});

test("array-table replacement by primitive array retains all comments", () => {
  const source = "[[rows]] # one\nx=1 # value\n[[rows]] # two\nx=2\n";
  const result = set(source, ["rows"], [1, 2]);
  semantic(parse(result), { rows: [1, 2] });
  preserved(source, result);
});

test("nested array-table additions remain attached to the selected parent", () => {
  const source =
    '[[parent]]\nid="one"\n[[parent.child]] # one child\nx=1\n[[parent]]\nid="two"\n[[parent.child]] # two child\nx=2\n';
  const result = appendArray(source, ["parent", 0, "child"], { x: 3 });
  semantic(parse(result), {
    parent: [
      { id: "one", child: [{ x: 1 }, { x: 3 }] },
      { id: "two", child: [{ x: 2 }] },
    ],
  });
  preserved(source, result);
});

test("deleting last dotted child retains a desired empty parent", () => {
  const source = "a.b=1 # reason\n";
  const result = remove(source, ["a", "b"]);
  semantic(parse(result), { a: {} });
  preserved(source, result);
});

test("implicit dotted objects inside inline tables delete their separators correctly", () => {
  const source = "value={\n a.b=1, # b\n a.c=2, # c\n remaining=3,\n} # value\n";
  const result = remove(source, ["value", "a"]);
  semantic(parse(result), { value: { remaining: 3 } });
  preserved(source, result);
});

test("new sections and collection rows use readable table syntax", () => {
  const result = editToml("# initial rationale\n", {
    collections: {
      sources: [
        { id: "first", scopes: ["."] },
        { id: "second", scopes: ["src"] },
      ],
    },
  });
  assert.ok(result.startsWith("# initial rationale\n[collections]\n"));
  assert.equal(result.match(/\[\[collections.sources\]\]/g)?.length, 2);
  semantic(parse(result), {
    collections: {
      sources: [
        { id: "first", scopes: ["."] },
        { id: "second", scopes: ["src"] },
      ],
    },
  });
});

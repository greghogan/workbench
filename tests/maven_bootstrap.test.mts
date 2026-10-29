import { expect, test } from "vitest";
import { SaxesParser } from "saxes";
import fc from "fast-check";
import { mavenInvocationPom } from "../src/maven-workspace.ts";
import { checkMavenAcquisitionPom } from "../src/maven-acquisition.ts";
import { mavenBootstrapPlugin, mavenBootstrapPom } from "../src/maven-bootstrap.ts";

const resolver = "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline";
const declaration = `<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-dependency-plugin</artifactId><version>3.11.0</version><dependencies><dependency><groupId>org.fixture</groupId><artifactId>replacement</artifactId><version>2</version></dependency></dependencies></plugin>`;

test.each([
  "<project/>",
  "<project><build/></project>",
  "<project><build><plugins/></build></project>",
  "<project><!-- keep 文😀 --><build><plugins><plugin><artifactId>unrelated</artifactId></plugin></plugins></build></project>",
  `<project><build><plugins>${declaration}</plugins></build></project>`,
])("metadata staging installs one resolver without disturbing unrelated XML: %s", (text) => {
  const plugin = mavenBootstrapPlugin(
    Buffer.from(`<project><build><plugins>${declaration}</plugins></build></project>`),
    resolver,
  );
  const output = mavenBootstrapPom(Buffer.from(text), plugin).toString();
  const parser = new SaxesParser({ xmlns: true });
  const names: string[] = [];
  parser.on("opentag", (tag) => {
    if (tag.local !== "project")
      expect(Object.keys(tag.attributes).filter((name) => name === "xmlns" || name.startsWith("xmlns:"))).toEqual([]);
  });
  parser.on("text", (value) => names.push(value));
  parser.write(output).close();
  expect(names.filter((name) => name === "maven-dependency-plugin")).toHaveLength(1);
  expect(names).toContain("replacement");
  if (text.includes("unrelated")) expect(names).toContain("unrelated");
  if (text.includes("<!-- keep 文😀 -->")) expect(output).toContain("<!-- keep 文😀 -->");
});

test("a copied resolver fragment retains inherited namespace bindings in a different source POM", () => {
  const text = `<m:project xmlns:m="http://maven.apache.org/POM/4.0.0" xmlns:option="urn:fixture"><m:build><m:plugins>${declaration.replaceAll("<", "<m:").replaceAll("<m:/", "</m:")}</m:plugins></m:build></m:project>`;
  const plugin = mavenBootstrapPlugin(Buffer.from(text), resolver);
  const output = mavenBootstrapPom(Buffer.from("<project/>"), plugin).toString();
  const parser = new SaxesParser({ xmlns: true });
  const plugins: string[] = [];
  parser.on("opentag", (tag) => {
    if (tag.local === "plugin") plugins.push(tag.uri);
  });
  parser.write(output).close();
  expect(plugins).toEqual(["http://maven.apache.org/POM/4.0.0"]);
});

test("resolver drift, duplicate declarations, and unresolved override versions fail before execution", () => {
  const pom = (plugin: string) => Buffer.from(`<project><build><plugins>${plugin}</plugins></build></project>`);
  expect(() => mavenBootstrapPlugin(pom(declaration.replace("3.11.0", "3.10.0")), resolver)).toThrow(/must match/);
  expect(() => mavenBootstrapPlugin(pom(declaration + declaration), resolver)).toThrow(/one pinned/);
  expect(() =>
    mavenBootstrapPlugin(pom(declaration.replace("<version>2</version>", "<version>${version}</version>")), resolver),
  ).toThrow(/literal pinned/);
  for (const version of ["LATEST", "RELEASE", "2-SNAPSHOT"])
    expect(() =>
      mavenBootstrapPlugin(pom(declaration.replace("<version>2</version>", `<version>${version}</version>`)), resolver),
    ).toThrow(/literal pinned/);
});

const xmlText = fc
  .array(fc.constantFrom("a", " ", "&", "<", ">", '"', "é", "😀", "\n", "\t"), { maxLength: 60 })
  .map((parts) => parts.join(""));
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
test("XML edits preserve unrelated bytes, retain values, and are idempotent across document shapes", () => {
  fc.assert(
    fc.property(xmlText, fc.boolean(), fc.boolean(), (value, prefix, hasProperties) => {
      const q = prefix ? "m:" : "",
        namespace = prefix ? ' xmlns:m="http://maven.apache.org/POM/4.0.0"' : "";
      const untouched = `<!-- preserve 😀 -->\n<${q}name>${escape(value)}</${q}name>`;
      const original = Buffer.from(
        `<${q}project${namespace}>${untouched}${hasProperties ? `<${q}properties><${q}workbench.build>old</${q}workbench.build></${q}properties>` : ""}</${q}project>`,
      );
      const bootstrap = mavenBootstrapPlugin(
        Buffer.from(`<project><build><plugins>${declaration}</plugins></build></project>`),
        resolver,
      );
      const staged = mavenBootstrapPom(original, bootstrap);
      expect(staged.toString()).toContain(untouched);
      expect(mavenBootstrapPom(staged, bootstrap)).toEqual(staged);
      const rewritten = mavenInvocationPom(staged, { "workbench.build": value });
      expect(rewritten.toString()).toContain(untouched);
      expect(mavenInvocationPom(rewritten, { "workbench.build": value })).toEqual(rewritten);
      const parser = new SaxesParser({ xmlns: true }),
        values: string[] = [];
      let selected = false,
        current = "";
      parser.on("opentag", (tag) => {
        if (tag.local === "workbench.build") {
          selected = true;
          current = "";
        }
      });
      parser.on("text", (text) => {
        if (selected) current += text;
      });
      parser.on("closetag", (tag) => {
        if (tag.local === "workbench.build") {
          values.push(current);
          selected = false;
        }
      });
      parser.write(rewritten.toString()).close();
      expect(values).toEqual([value]);
    }),
  );
});

test("standalone validation distinguishes Maven model extensions from opaque plugin configuration", () => {
  expect(() => {
    checkMavenAcquisitionPom(
      `<project><properties><parent>value</parent></properties><build><plugins><plugin><configuration><parent/><modules/><extensions/><systemPath/></configuration></plugin></plugins></build></project>`,
    );
  }).not.toThrow();
  for (const model of [
    "<parent/>",
    "<modules/>",
    "<profiles><profile><modules/></profile></profiles>",
    "<build><extensions/></build>",
    "<profiles><profile><build><plugins><plugin><extensions>true</extensions></plugin></plugins></build></profile></profiles>",
    "<dependencies><dependency><systemPath>/host/library.jar</systemPath></dependency></dependencies>",
  ])
    expect(() => {
      checkMavenAcquisitionPom(`<project>${model}</project>`);
    }).toThrow(/standalone POMs without/);
});

// Generated from native-host-requirements.mts; edit the TypeScript source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const markers = { rust: "rust-toolchain.toml", ruby: ".ruby-version", php: ".php-version", go: ".go-version" };
const packages = {
  linux: [
    "build-essential",
    "pkg-config",
    "libssl-dev",
    "libyaml-dev",
    "libffi-dev",
    "zlib1g-dev",
    "libxml2-dev",
    "libonig-dev",
    "libcurl4-openssl-dev",
    "autoconf"
  ],
  darwin: ["pkg-config", "openssl@3", "libyaml", "libffi", "oniguruma", "autoconf", "libxml2", "libiconv", "curl"],
  win32: ["mingw-w64-ucrt-x86_64-gcc", "mingw-w64-ucrt-x86_64-make", "make"]
};
const browserPackages = [
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libatk1.0-0t64",
  "libatk-bridge2.0-0t64",
  "libdbus-1-3",
  "libx11-6",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libexpat1",
  "libxcb1",
  "libxkbcommon0",
  "libudev1",
  "libasound2t64",
  "libatspi2.0-0t64",
  "fonts-liberation"
];
function nativeHostLanguages(roots, runtime = "") {
  const languages = Object.entries(markers).filter(
    ([language, marker]) => roots.some((root) => existsSync(join(root, marker))) || ["ruby", "php"].includes(language) && runtime === language
  ).map(([language]) => language);
  if (roots.some((root) => {
    const path = join(root, ".tool-versions");
    return existsSync(path) && /^[\t ]*chromium-headless-shell[\t ]/m.test(readFileSync(path, "utf8"));
  }))
    languages.push("browser");
  return languages;
}
function nativeHostRequirements(languages, platform = process.platform) {
  const goCompiler = platform === "win32" && languages.includes("go");
  const buildTools = languages.some((language) => language === "ruby" || language === "php") || goCompiler;
  return {
    commands: goCompiler ? ["gcc"] : platform === "darwin" && buildTools ? ["brew"] : [],
    packages: [
      .../* @__PURE__ */ new Set([
        ...buildTools && (platform === "linux" || platform === "darwin" || platform === "win32") ? packages[platform] : [],
        ...platform === "linux" && languages.includes("browser") ? browserPackages : []
      ])
    ],
    pkgConfigPackages: buildTools && platform === "darwin" ? ["openssl@3", "libyaml", "libffi", "oniguruma", "libxml2", "curl"] : [],
    msvcLinker: platform === "win32" && languages.includes("rust")
  };
}
export {
  nativeHostLanguages,
  nativeHostRequirements
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5hdGl2ZS1ob3N0LXJlcXVpcmVtZW50cy5tdHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IG1hcmtlcnMgPSB7IHJ1c3Q6IFwicnVzdC10b29sY2hhaW4udG9tbFwiLCBydWJ5OiBcIi5ydWJ5LXZlcnNpb25cIiwgcGhwOiBcIi5waHAtdmVyc2lvblwiLCBnbzogXCIuZ28tdmVyc2lvblwiIH07XG5jb25zdCBwYWNrYWdlcyA9IHtcbiAgbGludXg6IFtcbiAgICBcImJ1aWxkLWVzc2VudGlhbFwiLFxuICAgIFwicGtnLWNvbmZpZ1wiLFxuICAgIFwibGlic3NsLWRldlwiLFxuICAgIFwibGlieWFtbC1kZXZcIixcbiAgICBcImxpYmZmaS1kZXZcIixcbiAgICBcInpsaWIxZy1kZXZcIixcbiAgICBcImxpYnhtbDItZGV2XCIsXG4gICAgXCJsaWJvbmlnLWRldlwiLFxuICAgIFwibGliY3VybDQtb3BlbnNzbC1kZXZcIixcbiAgICBcImF1dG9jb25mXCIsXG4gIF0sXG4gIGRhcndpbjogW1wicGtnLWNvbmZpZ1wiLCBcIm9wZW5zc2xAM1wiLCBcImxpYnlhbWxcIiwgXCJsaWJmZmlcIiwgXCJvbmlndXJ1bWFcIiwgXCJhdXRvY29uZlwiLCBcImxpYnhtbDJcIiwgXCJsaWJpY29udlwiLCBcImN1cmxcIl0sXG4gIHdpbjMyOiBbXCJtaW5ndy13NjQtdWNydC14ODZfNjQtZ2NjXCIsIFwibWluZ3ctdzY0LXVjcnQteDg2XzY0LW1ha2VcIiwgXCJtYWtlXCJdLFxufTtcbmNvbnN0IGJyb3dzZXJQYWNrYWdlcyA9IFtcbiAgXCJsaWJnbGliMi4wLTB0NjRcIixcbiAgXCJsaWJuc3ByNFwiLFxuICBcImxpYm5zczNcIixcbiAgXCJsaWJhdGsxLjAtMHQ2NFwiLFxuICBcImxpYmF0ay1icmlkZ2UyLjAtMHQ2NFwiLFxuICBcImxpYmRidXMtMS0zXCIsXG4gIFwibGlieDExLTZcIixcbiAgXCJsaWJ4Y29tcG9zaXRlMVwiLFxuICBcImxpYnhkYW1hZ2UxXCIsXG4gIFwibGlieGV4dDZcIixcbiAgXCJsaWJ4Zml4ZXMzXCIsXG4gIFwibGlieHJhbmRyMlwiLFxuICBcImxpYmdibTFcIixcbiAgXCJsaWJleHBhdDFcIixcbiAgXCJsaWJ4Y2IxXCIsXG4gIFwibGlieGtiY29tbW9uMFwiLFxuICBcImxpYnVkZXYxXCIsXG4gIFwibGliYXNvdW5kMnQ2NFwiLFxuICBcImxpYmF0c3BpMi4wLTB0NjRcIixcbiAgXCJmb250cy1saWJlcmF0aW9uXCIsXG5dO1xuXG4vKiogQ0kgZGlzY292ZXJzIHRoZSBzYW1lIGxhbmd1YWdlIGlkZW50aXRpZXMgdXNlZCBieSBjaGVjayBlbnZpcm9ubWVudCBjb25zdHJ1Y3Rpb24uICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlSG9zdExhbmd1YWdlcyhyb290czogcmVhZG9ubHkgc3RyaW5nW10sIHJ1bnRpbWUgPSBcIlwiKTogc3RyaW5nW10ge1xuICBjb25zdCBsYW5ndWFnZXMgPSBPYmplY3QuZW50cmllcyhtYXJrZXJzKVxuICAgIC5maWx0ZXIoXG4gICAgICAoW2xhbmd1YWdlLCBtYXJrZXJdKSA9PlxuICAgICAgICByb290cy5zb21lKChyb290KSA9PiBleGlzdHNTeW5jKGpvaW4ocm9vdCwgbWFya2VyKSkpIHx8XG4gICAgICAgIChbXCJydWJ5XCIsIFwicGhwXCJdLmluY2x1ZGVzKGxhbmd1YWdlKSAmJiBydW50aW1lID09PSBsYW5ndWFnZSksXG4gICAgKVxuICAgIC5tYXAoKFtsYW5ndWFnZV0pID0+IGxhbmd1YWdlKTtcbiAgaWYgKFxuICAgIHJvb3RzLnNvbWUoKHJvb3QpID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSBqb2luKHJvb3QsIFwiLnRvb2wtdmVyc2lvbnNcIik7XG4gICAgICByZXR1cm4gZXhpc3RzU3luYyhwYXRoKSAmJiAvXltcXHQgXSpjaHJvbWl1bS1oZWFkbGVzcy1zaGVsbFtcXHQgXS9tLnRlc3QocmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKSk7XG4gICAgfSlcbiAgKVxuICAgIGxhbmd1YWdlcy5wdXNoKFwiYnJvd3NlclwiKTtcbiAgcmV0dXJuIGxhbmd1YWdlcztcbn1cblxuLyoqIEludGVybmFsIGhvc3QgU0RLIHJlcXVpcmVtZW50czsgc2VsZWN0ZWQgbGFuZ3VhZ2UvdG9vbCBwaW5zIHJlbWFpbiB0aGVpciBvd24gYXV0aG9yaXRpZXMuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlSG9zdFJlcXVpcmVtZW50cyhsYW5ndWFnZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBwbGF0Zm9ybTogTm9kZUpTLlBsYXRmb3JtID0gcHJvY2Vzcy5wbGF0Zm9ybSkge1xuICBjb25zdCBnb0NvbXBpbGVyID0gcGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBsYW5ndWFnZXMuaW5jbHVkZXMoXCJnb1wiKTtcbiAgY29uc3QgYnVpbGRUb29scyA9IGxhbmd1YWdlcy5zb21lKChsYW5ndWFnZSkgPT4gbGFuZ3VhZ2UgPT09IFwicnVieVwiIHx8IGxhbmd1YWdlID09PSBcInBocFwiKSB8fCBnb0NvbXBpbGVyO1xuICByZXR1cm4ge1xuICAgIGNvbW1hbmRzOiBnb0NvbXBpbGVyID8gW1wiZ2NjXCJdIDogcGxhdGZvcm0gPT09IFwiZGFyd2luXCIgJiYgYnVpbGRUb29scyA/IFtcImJyZXdcIl0gOiBbXSxcbiAgICBwYWNrYWdlczogW1xuICAgICAgLi4ubmV3IFNldChbXG4gICAgICAgIC4uLihidWlsZFRvb2xzICYmIChwbGF0Zm9ybSA9PT0gXCJsaW51eFwiIHx8IHBsYXRmb3JtID09PSBcImRhcndpblwiIHx8IHBsYXRmb3JtID09PSBcIndpbjMyXCIpXG4gICAgICAgICAgPyBwYWNrYWdlc1twbGF0Zm9ybV1cbiAgICAgICAgICA6IFtdKSxcbiAgICAgICAgLi4uKHBsYXRmb3JtID09PSBcImxpbnV4XCIgJiYgbGFuZ3VhZ2VzLmluY2x1ZGVzKFwiYnJvd3NlclwiKSA/IGJyb3dzZXJQYWNrYWdlcyA6IFtdKSxcbiAgICAgIF0pLFxuICAgIF0sXG4gICAgcGtnQ29uZmlnUGFja2FnZXM6XG4gICAgICBidWlsZFRvb2xzICYmIHBsYXRmb3JtID09PSBcImRhcndpblwiID8gW1wib3BlbnNzbEAzXCIsIFwibGlieWFtbFwiLCBcImxpYmZmaVwiLCBcIm9uaWd1cnVtYVwiLCBcImxpYnhtbDJcIiwgXCJjdXJsXCJdIDogW10sXG4gICAgbXN2Y0xpbmtlcjogcGxhdGZvcm0gPT09IFwid2luMzJcIiAmJiBsYW5ndWFnZXMuaW5jbHVkZXMoXCJydXN0XCIpLFxuICB9O1xufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLFlBQVk7QUFFckIsTUFBTSxVQUFVLEVBQUUsTUFBTSx1QkFBdUIsTUFBTSxpQkFBaUIsS0FBSyxnQkFBZ0IsSUFBSSxjQUFjO0FBQzdHLE1BQU0sV0FBVztBQUFBLEVBQ2YsT0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRLENBQUMsY0FBYyxhQUFhLFdBQVcsVUFBVSxhQUFhLFlBQVksV0FBVyxZQUFZLE1BQU07QUFBQSxFQUMvRyxPQUFPLENBQUMsNkJBQTZCLDhCQUE4QixNQUFNO0FBQzNFO0FBQ0EsTUFBTSxrQkFBa0I7QUFBQSxFQUN0QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUdPLFNBQVMsb0JBQW9CLE9BQTBCLFVBQVUsSUFBYztBQUNwRixRQUFNLFlBQVksT0FBTyxRQUFRLE9BQU8sRUFDckM7QUFBQSxJQUNDLENBQUMsQ0FBQyxVQUFVLE1BQU0sTUFDaEIsTUFBTSxLQUFLLENBQUMsU0FBUyxXQUFXLEtBQUssTUFBTSxNQUFNLENBQUMsQ0FBQyxLQUNsRCxDQUFDLFFBQVEsS0FBSyxFQUFFLFNBQVMsUUFBUSxLQUFLLFlBQVk7QUFBQSxFQUN2RCxFQUNDLElBQUksQ0FBQyxDQUFDLFFBQVEsTUFBTSxRQUFRO0FBQy9CLE1BQ0UsTUFBTSxLQUFLLENBQUMsU0FBUztBQUNuQixVQUFNLE9BQU8sS0FBSyxNQUFNLGdCQUFnQjtBQUN4QyxXQUFPLFdBQVcsSUFBSSxLQUFLLHVDQUF1QyxLQUFLLGFBQWEsTUFBTSxNQUFNLENBQUM7QUFBQSxFQUNuRyxDQUFDO0FBRUQsY0FBVSxLQUFLLFNBQVM7QUFDMUIsU0FBTztBQUNUO0FBR08sU0FBUyx1QkFBdUIsV0FBOEIsV0FBNEIsUUFBUSxVQUFVO0FBQ2pILFFBQU0sYUFBYSxhQUFhLFdBQVcsVUFBVSxTQUFTLElBQUk7QUFDbEUsUUFBTSxhQUFhLFVBQVUsS0FBSyxDQUFDLGFBQWEsYUFBYSxVQUFVLGFBQWEsS0FBSyxLQUFLO0FBQzlGLFNBQU87QUFBQSxJQUNMLFVBQVUsYUFBYSxDQUFDLEtBQUssSUFBSSxhQUFhLFlBQVksYUFBYSxDQUFDLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDbkYsVUFBVTtBQUFBLE1BQ1IsR0FBRyxvQkFBSSxJQUFJO0FBQUEsUUFDVCxHQUFJLGVBQWUsYUFBYSxXQUFXLGFBQWEsWUFBWSxhQUFhLFdBQzdFLFNBQVMsUUFBUSxJQUNqQixDQUFDO0FBQUEsUUFDTCxHQUFJLGFBQWEsV0FBVyxVQUFVLFNBQVMsU0FBUyxJQUFJLGtCQUFrQixDQUFDO0FBQUEsTUFDakYsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLG1CQUNFLGNBQWMsYUFBYSxXQUFXLENBQUMsYUFBYSxXQUFXLFVBQVUsYUFBYSxXQUFXLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDOUcsWUFBWSxhQUFhLFdBQVcsVUFBVSxTQUFTLE1BQU07QUFBQSxFQUMvRDtBQUNGOyIsIm5hbWVzIjpbXSwiZmlsZSI6InNjcmlwdHMvbmF0aXZlLWhvc3QtcmVxdWlyZW1lbnRzLm1qcyJ9

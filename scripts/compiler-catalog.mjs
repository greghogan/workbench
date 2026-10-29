// Generated from compiler-catalog.mts; edit the TypeScript source.
const compilerCatalog = {
  clang: {
    pin: ".llvm-version",
    executables: { c: "clang", cpp: "clang++" },
    platforms: ["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"],
    compatibilityOS: "linux",
    managed: true,
    standards: { c: ["90", "99", "11", "17", "23"], cpp: ["98", "11", "14", "17", "20", "23", "26"] },
    lto: ["off", "thin", "full"]
  },
  gcc: {
    pin: ".gcc-version",
    executables: { c: "gcc", cpp: "g++" },
    platforms: ["linux-x64", "linux-arm64"],
    compatibilityOS: "linux",
    managed: true,
    standards: { c: ["90", "99", "11", "17", "23"], cpp: ["98", "11", "14", "17", "20", "23", "26"] },
    lto: ["off", "full"]
  },
  mvsc: {
    pin: ".mvsc-version",
    executables: { c: "cl", cpp: "cl" },
    platforms: ["windows-x64"],
    compatibilityOS: "windows",
    managed: false,
    standards: { c: ["11", "17"], cpp: ["14", "17", "20"] },
    lto: ["off", "full"]
  }
};
const compilerFamilies = Object.keys(compilerCatalog);
const managedCompilerFamilies = compilerFamilies.filter((family) => compilerCatalog[family].managed);
const linuxCompilerFamilies = compilerFamilies.filter(
  (family) => compilerCatalog[family].platforms.some((platform) => platform.startsWith("linux-"))
);
function isCompilerFamily(value) {
  return typeof value === "string" && Object.hasOwn(compilerCatalog, value);
}
function compilerBaseline(family, version) {
  if (family !== "mvsc" || !version) return version;
  const [major, minor] = version.split(".");
  return `${String(Number(major) + 5)}.${minor ?? ""}`;
}
export {
  compilerBaseline,
  compilerCatalog,
  compilerFamilies,
  isCompilerFamily,
  linuxCompilerFamilies,
  managedCompilerFamilies
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNvbXBpbGVyLWNhdGFsb2cubXRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKiBTaGFyZWQgYnkgQ0xJIHNjaGVtYXMsIG5hdGl2ZSBzZWxlY3Rpb24sIGRlcGVuZGVuY3kgdG9vbGluZyBhbmQgc3RhbmRhbG9uZSBDSSBhZGFwdGVycy4gKi9cbmV4cG9ydCBjb25zdCBjb21waWxlckNhdGFsb2cgPSB7XG4gIGNsYW5nOiB7XG4gICAgcGluOiBcIi5sbHZtLXZlcnNpb25cIixcbiAgICBleGVjdXRhYmxlczogeyBjOiBcImNsYW5nXCIsIGNwcDogXCJjbGFuZysrXCIgfSxcbiAgICBwbGF0Zm9ybXM6IFtcImxpbnV4LXg2NFwiLCBcImxpbnV4LWFybTY0XCIsIFwibWFjb3MtYXJtNjRcIiwgXCJ3aW5kb3dzLXg2NFwiXSxcbiAgICBjb21wYXRpYmlsaXR5T1M6IFwibGludXhcIixcbiAgICBtYW5hZ2VkOiB0cnVlLFxuICAgIHN0YW5kYXJkczogeyBjOiBbXCI5MFwiLCBcIjk5XCIsIFwiMTFcIiwgXCIxN1wiLCBcIjIzXCJdLCBjcHA6IFtcIjk4XCIsIFwiMTFcIiwgXCIxNFwiLCBcIjE3XCIsIFwiMjBcIiwgXCIyM1wiLCBcIjI2XCJdIH0sXG4gICAgbHRvOiBbXCJvZmZcIiwgXCJ0aGluXCIsIFwiZnVsbFwiXSxcbiAgfSxcbiAgZ2NjOiB7XG4gICAgcGluOiBcIi5nY2MtdmVyc2lvblwiLFxuICAgIGV4ZWN1dGFibGVzOiB7IGM6IFwiZ2NjXCIsIGNwcDogXCJnKytcIiB9LFxuICAgIHBsYXRmb3JtczogW1wibGludXgteDY0XCIsIFwibGludXgtYXJtNjRcIl0sXG4gICAgY29tcGF0aWJpbGl0eU9TOiBcImxpbnV4XCIsXG4gICAgbWFuYWdlZDogdHJ1ZSxcbiAgICBzdGFuZGFyZHM6IHsgYzogW1wiOTBcIiwgXCI5OVwiLCBcIjExXCIsIFwiMTdcIiwgXCIyM1wiXSwgY3BwOiBbXCI5OFwiLCBcIjExXCIsIFwiMTRcIiwgXCIxN1wiLCBcIjIwXCIsIFwiMjNcIiwgXCIyNlwiXSB9LFxuICAgIGx0bzogW1wib2ZmXCIsIFwiZnVsbFwiXSxcbiAgfSxcbiAgbXZzYzoge1xuICAgIHBpbjogXCIubXZzYy12ZXJzaW9uXCIsXG4gICAgZXhlY3V0YWJsZXM6IHsgYzogXCJjbFwiLCBjcHA6IFwiY2xcIiB9LFxuICAgIHBsYXRmb3JtczogW1wid2luZG93cy14NjRcIl0sXG4gICAgY29tcGF0aWJpbGl0eU9TOiBcIndpbmRvd3NcIixcbiAgICBtYW5hZ2VkOiBmYWxzZSxcbiAgICBzdGFuZGFyZHM6IHsgYzogW1wiMTFcIiwgXCIxN1wiXSwgY3BwOiBbXCIxNFwiLCBcIjE3XCIsIFwiMjBcIl0gfSxcbiAgICBsdG86IFtcIm9mZlwiLCBcImZ1bGxcIl0sXG4gIH0sXG59IGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgQ29tcGlsZXJGYW1pbHkgPSBrZXlvZiB0eXBlb2YgY29tcGlsZXJDYXRhbG9nO1xuZXhwb3J0IGNvbnN0IGNvbXBpbGVyRmFtaWxpZXMgPSBPYmplY3Qua2V5cyhjb21waWxlckNhdGFsb2cpIGFzIENvbXBpbGVyRmFtaWx5W107XG5leHBvcnQgY29uc3QgbWFuYWdlZENvbXBpbGVyRmFtaWxpZXMgPSBjb21waWxlckZhbWlsaWVzLmZpbHRlcigoZmFtaWx5KSA9PiBjb21waWxlckNhdGFsb2dbZmFtaWx5XS5tYW5hZ2VkKTtcbmV4cG9ydCBjb25zdCBsaW51eENvbXBpbGVyRmFtaWxpZXMgPSBjb21waWxlckZhbWlsaWVzLmZpbHRlcigoZmFtaWx5KSA9PlxuICBjb21waWxlckNhdGFsb2dbZmFtaWx5XS5wbGF0Zm9ybXMuc29tZSgocGxhdGZvcm0pID0+IHBsYXRmb3JtLnN0YXJ0c1dpdGgoXCJsaW51eC1cIikpLFxuKTtcbmV4cG9ydCBmdW5jdGlvbiBpc0NvbXBpbGVyRmFtaWx5KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgQ29tcGlsZXJGYW1pbHkge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIE9iamVjdC5oYXNPd24oY29tcGlsZXJDYXRhbG9nLCB2YWx1ZSk7XG59XG5cbi8qKiBNU1ZDIHBpbnMgaWRlbnRpZnkgdGhlIHRvb2xzZXQgZGlyZWN0b3J5OyBDTWFrZSBhbmQgY2wgcmVwb3J0IHRoZSBjb21waWxlciB2ZXJzaW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXBpbGVyQmFzZWxpbmUoZmFtaWx5OiBDb21waWxlckZhbWlseSwgdmVyc2lvbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKGZhbWlseSAhPT0gXCJtdnNjXCIgfHwgIXZlcnNpb24pIHJldHVybiB2ZXJzaW9uO1xuICBjb25zdCBbbWFqb3IsIG1pbm9yXSA9IHZlcnNpb24uc3BsaXQoXCIuXCIpO1xuICByZXR1cm4gYCR7U3RyaW5nKE51bWJlcihtYWpvcikgKyA1KX0uJHttaW5vciA/PyBcIlwifWA7XG59XG4iXSwibWFwcGluZ3MiOiI7QUFDTyxNQUFNLGtCQUFrQjtBQUFBLEVBQzdCLE9BQU87QUFBQSxJQUNMLEtBQUs7QUFBQSxJQUNMLGFBQWEsRUFBRSxHQUFHLFNBQVMsS0FBSyxVQUFVO0FBQUEsSUFDMUMsV0FBVyxDQUFDLGFBQWEsZUFBZSxlQUFlLGFBQWE7QUFBQSxJQUNwRSxpQkFBaUI7QUFBQSxJQUNqQixTQUFTO0FBQUEsSUFDVCxXQUFXLEVBQUUsR0FBRyxDQUFDLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxJQUFJLEVBQUU7QUFBQSxJQUNoRyxLQUFLLENBQUMsT0FBTyxRQUFRLE1BQU07QUFBQSxFQUM3QjtBQUFBLEVBQ0EsS0FBSztBQUFBLElBQ0gsS0FBSztBQUFBLElBQ0wsYUFBYSxFQUFFLEdBQUcsT0FBTyxLQUFLLE1BQU07QUFBQSxJQUNwQyxXQUFXLENBQUMsYUFBYSxhQUFhO0FBQUEsSUFDdEMsaUJBQWlCO0FBQUEsSUFDakIsU0FBUztBQUFBLElBQ1QsV0FBVyxFQUFFLEdBQUcsQ0FBQyxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSSxFQUFFO0FBQUEsSUFDaEcsS0FBSyxDQUFDLE9BQU8sTUFBTTtBQUFBLEVBQ3JCO0FBQUEsRUFDQSxNQUFNO0FBQUEsSUFDSixLQUFLO0FBQUEsSUFDTCxhQUFhLEVBQUUsR0FBRyxNQUFNLEtBQUssS0FBSztBQUFBLElBQ2xDLFdBQVcsQ0FBQyxhQUFhO0FBQUEsSUFDekIsaUJBQWlCO0FBQUEsSUFDakIsU0FBUztBQUFBLElBQ1QsV0FBVyxFQUFFLEdBQUcsQ0FBQyxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsTUFBTSxNQUFNLElBQUksRUFBRTtBQUFBLElBQ3RELEtBQUssQ0FBQyxPQUFPLE1BQU07QUFBQSxFQUNyQjtBQUNGO0FBRU8sTUFBTSxtQkFBbUIsT0FBTyxLQUFLLGVBQWU7QUFDcEQsTUFBTSwwQkFBMEIsaUJBQWlCLE9BQU8sQ0FBQyxXQUFXLGdCQUFnQixNQUFNLEVBQUUsT0FBTztBQUNuRyxNQUFNLHdCQUF3QixpQkFBaUI7QUFBQSxFQUFPLENBQUMsV0FDNUQsZ0JBQWdCLE1BQU0sRUFBRSxVQUFVLEtBQUssQ0FBQyxhQUFhLFNBQVMsV0FBVyxRQUFRLENBQUM7QUFDcEY7QUFDTyxTQUFTLGlCQUFpQixPQUF5QztBQUN4RSxTQUFPLE9BQU8sVUFBVSxZQUFZLE9BQU8sT0FBTyxpQkFBaUIsS0FBSztBQUMxRTtBQUdPLFNBQVMsaUJBQWlCLFFBQXdCLFNBQXlCO0FBQ2hGLE1BQUksV0FBVyxVQUFVLENBQUMsUUFBUyxRQUFPO0FBQzFDLFFBQU0sQ0FBQyxPQUFPLEtBQUssSUFBSSxRQUFRLE1BQU0sR0FBRztBQUN4QyxTQUFPLEdBQUcsT0FBTyxPQUFPLEtBQUssSUFBSSxDQUFDLENBQUMsSUFBSSxTQUFTLEVBQUU7QUFDcEQ7IiwibmFtZXMiOltdLCJmaWxlIjoic2NyaXB0cy9jb21waWxlci1jYXRhbG9nLm1qcyJ9

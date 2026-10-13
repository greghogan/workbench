;; The channel's "cmake" package is older than cmake-minimal@4.3.3.
;; Switch back to "cmake" once it meets vcpkg's CMake version requirement.
(specifications->manifest
 '("bash" "coreutils" "git" "node" "nss-certs" "curl" "zip" "unzip" "pkg-config" "tar" "gzip" "bzip2" "xz" "sed" "grep" "gawk" "findutils" "clang-toolchain" "clang" "llvm" "lld" "cmake-minimal@4.3.3" "ninja"))

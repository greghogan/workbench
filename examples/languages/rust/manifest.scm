;; Optional user-invoked tools for the Rust reference project.
(use-modules (guix profiles) (guix packages) (gnu packages rust))

(concatenate-manifests
 (list
  (packages->manifest
   (list (load (string-append (dirname (current-filename)) "/coverage-tool.scm"))
         (lookup-package-input rust "llvm")))
  (specifications->manifest
   '("bash"
     "cargo-nextest"
     "coreutils"
     "docker-cli"
     "gcc-toolchain"
     "git"
     "node"
     "nss-certs"
     "rust"
     "rust:cargo"
     "rust:tools"))))

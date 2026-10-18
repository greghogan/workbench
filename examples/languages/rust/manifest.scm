;; Optional user-invoked tools for the Rust reference project.
;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (gnu packages) (guix profiles) (guix packages) (gnu packages rust))

(define development-inputs
  (package->development-manifest
   (load (string-append (dirname (current-filename)) "/package.scm"))))

(manifest-add
 (manifest-add
  development-inputs
  (manifest-entries
   (concatenate-manifests
    (list (packages->manifest
           (list (load (string-append
                        (dirname (current-filename))
                        "/coverage-tool.scm"))
                 (lookup-package-input rust "llvm")))
          (specifications->manifest
           '("bash"
             "cargo-nextest"
             "coreutils"
             "docker-cli"
             "gcc-toolchain"
             "gdb"
             "openssh"
             "rsync"
             "which"
             "less"
             "vim"
             "git"
             "node"
             "nss-certs"
             "rust"
             "rust:cargo"
             "rust:tools"))))))
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

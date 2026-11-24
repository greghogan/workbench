;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (guix packages) (guix profiles) (gnu packages))

(define toolchain-only? (equal? (getenv "WORKBENCH_ARTIFACT_KIND") "toolchain"))

(define development-inputs
  (if toolchain-only?
      (manifest '())
      (package->development-manifest
       (load (string-append (dirname (current-filename)) "/package.scm")))))

(manifest-add
 (manifest-add
  development-inputs
  (manifest-entries
   (concatenate-manifests
    ;; pnpm needs libgcc, but this environment does not need the compiler.
    (list (packages->manifest
           (list (list (lookup-package-input
                        (specification->package "gcc-toolchain")
                        "gcc")
                       "lib")))
          (specifications->manifest
           '("bash"
             "coreutils"
             "git"
             "node"
             "nss-certs"
             "openssh"
             "rsync"
             "which"
             "less"
             "vim"))))))
 (if toolchain-only?
     '()
     (list (package->manifest-entry
            (load (string-append (dirname (current-filename)) "/check-inputs.scm"))))))

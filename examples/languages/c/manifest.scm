;; The package owns build inputs; these additions serve checks and interactive development.
;; cmake-minimal@4.3.3 supplies a newer CMake than the channel's "cmake" package.
;; Switch back to "cmake" when the channel supplies the corresponding current release.
;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (guix packages) (guix profiles) (gnu packages))

(define development-package
  (load (string-append (dirname (current-filename)) "/package.scm")))

(define development-inputs (package->development-manifest development-package))

(manifest-add
 (manifest-add
  development-inputs
  (manifest-entries
   (concatenate-manifests
    (list (packages->manifest
           (list selected-clang-toolchain
                 selected-clang
                 selected-llvm
                 selected-lldb
                 (specification->package
                  (string-append "lld@" (package-version selected-clang)))))
          (specifications->manifest
           '("bash"
             "coreutils"
             "git"
             "node"
             "nss-certs"
             "curl"
             "zip"
             "unzip"
             "pkg-config"
             "tar"
             "gzip"
             "bzip2"
             "xz"
             "sed"
             "grep"
             "gawk"
             "findutils"
             "gdb"
             "openssh"
             "rsync"
             "which"
             "less"
             "vim"))))))
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

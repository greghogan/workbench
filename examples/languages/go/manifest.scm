;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (gnu packages) (guix packages) (guix profiles))

(define development-inputs
  (package->development-manifest
   (load (string-append (dirname (current-filename)) "/package.scm"))))

(manifest-add
 (manifest-add
  development-inputs
  (manifest-entries
   (specifications->manifest
    '("bash"
      "coreutils"
      "git"
      "node"
      "nss-certs"
      "gcc-toolchain"
      "gdb"
      "openssh"
      "rsync"
      "which"
      "less"
      "vim"))))
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (gnu packages) (guix packages) (guix profiles))

(define development-inputs
  (package->development-manifest
   (load (string-append (dirname (current-filename)) "/package.scm"))))

(manifest-add
 (manifest-add
  development-inputs
  (manifest-entries
   (concatenate-manifests
    (list (specifications->manifest
           '("bash"
             "coreutils"
             "git"
             "ruby@4.0"
             "node"
             "nss-certs"
             "gcc-toolchain"
             "make"
             "pkg-config"
             "openssl"
             "libyaml"))
          (specifications->manifest
           '("openssh" "rsync" "which" "less" "vim" "gdb"))))))
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

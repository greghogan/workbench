;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (gnu packages) (guix packages) (guix profiles))

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
    (list (specifications->manifest
           '("bash" "coreutils" "git" "gnupg" "php" "node" "nss-certs" "unzip"))
          (specifications->manifest '("openssh" "rsync" "which" "less" "vim"))))))
 (if toolchain-only?
     '()
     (list (package->manifest-entry
            (load (string-append (dirname (current-filename)) "/check-inputs.scm"))))))

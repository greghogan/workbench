(use-modules (gnu packages) (guix packages) (guix profiles))

(define toolchain-only? (equal? (getenv "WORKBENCH_ARTIFACT_KIND") "toolchain"))

;; Development tools for the Workbench source checkout.
(manifest-add
 (specifications->manifest
  '(
    "actionlint"
    "bash"
    "cargo-nextest"
    "coreutils"
    "curl"
    "direnv"
    "findutils"
    "gawk"
    "gcc-toolchain"
    "gdb"
    "grep"
    "gzip"
    "git"
    "gnupg"
    "make"
    "python"
    "nss-certs"
    "node"
    "ripgrep"
    "ruff"
    "rust"
    "rust:cargo"
    "rust:tools"
    "sed"
    "tar"
    "openssh"
    "rsync"
    "which"
    "less"
    "vim"
    "shellcheck"
    "shfmt"
    "xz"))
 (append
  (if toolchain-only?
      '()
      (list (package->manifest-entry
             (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))
  (list (package->manifest-entry
         (load (string-append (dirname (current-filename)) "/browser.scm"))))))

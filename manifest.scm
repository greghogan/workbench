(use-modules (gnu packages) (guix packages) (guix profiles))

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
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

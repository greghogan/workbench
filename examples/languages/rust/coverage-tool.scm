;; This channel lacks cargo-llvm-cov. Pin its upstream static release separately
;; from native tooling; Guix verifies the same published release digests as CI.
(use-modules (guix packages)
             (guix download)
             (guix build-system copy)
             (guix utils)
             (gcrypt base16)
             ((guix licenses) #:prefix license:))

(define asset
  (case (string->symbol (%current-system))
    ((x86_64-linux)
     '("x86_64-unknown-linux-musl"
       "e9fc23dbbdc502ee9267544f8c6e8e162c6d7df8fb2e3f62d8289a4c0bd240ce"))
    ((aarch64-linux)
     '("aarch64-unknown-linux-musl"
       "bc14a4551e633b12ec89bb15469e6099b4ddc998a5d1bcad0fd95320b148a40f"))
    (else (error "coverage tool has no verified release for this system"))))

(package
  (name "cargo-llvm-cov")
  (version "0.8.5")
  (source (origin
            (method url-fetch)
            (uri (string-append "https://github.com/taiki-e/cargo-llvm-cov/releases/download/v"
                                version "/cargo-llvm-cov-" (car asset) ".tar.gz"))
            (sha256 (base16-string->bytevector (cadr asset)))))
  (build-system copy-build-system)
  (arguments '(#:install-plan '(("cargo-llvm-cov" "bin/"))))
  (supported-systems '("x86_64-linux" "aarch64-linux"))
  (home-page "https://github.com/taiki-e/cargo-llvm-cov")
  (synopsis "Cargo interface to LLVM source coverage")
  (description "Pinned upstream static cargo-llvm-cov executable for the reference checks.")
  (license (list license:asl2.0 license:expat)))

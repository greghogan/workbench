(use-modules (guix packages) (guix gexp) (guix build-system cargo) (guix base16)
             ((guix licenses) #:prefix license:) (gnu packages))

(define crates
  (load (string-append (dirname (current-filename)) "/guix-crates.scm")))
(define checksums
  (map (lambda (entry)
         (let ((source (cadr entry)))
           (cons (origin-file-name source)
                 (bytevector->base16-string (content-hash-value (origin-hash source))))))
       crates))

(package
  (name "workbench-rust-reference")
  (version "0.1.0")
  (source (file-union "rust-reference-source"
                      `(("Cargo.toml" ,(local-file "Cargo.toml"))
                        ("Cargo.lock" ,(local-file "Cargo.lock"))
                        ("LICENSE" ,(local-file "LICENSE"))
                        ("src" ,(local-file "src" #:recursive? #t))
                        ("tests" ,(local-file "tests" #:recursive? #t)))))
  (build-system cargo-build-system)
  (arguments
   (list #:install-source? #f
         #:cargo-build-flags ''("--release" "--locked")
         #:cargo-test-flags ''("--release" "--locked")
         #:phases
         #~(modify-phases %standard-phases
             ;; Guix normally discards the lock; this project owns exact crate identities.
             (add-after 'configure 'restore-project-lock
               (lambda _
                 (copy-file #$(local-file "Cargo.lock") "Cargo.lock")))
             (add-after 'patch-cargo-checksums 'restore-locked-package-checksums
               (lambda _
                 (for-each
                  (lambda (entry)
                    (call-with-output-file
                        (string-append "guix-vendor/" (car entry) "/.cargo-checksum.json")
                      (lambda (port)
                        (format port "{\"files\":{},\"package\":\"~a\"}" (cdr entry)))))
                  '#$checksums))))))
  (inputs crates)
  (synopsis "Workbench Rust reference")
  (description "An independently packaged Rust example using its locked crate sources.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

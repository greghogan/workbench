(use-modules (guix packages)
             (guix gexp)
             (guix build-system gnu)
             (guix licenses)
             (gnu packages)
             (gnu packages bash))

(define source
  (file-union "go-reference-source"
              `(("go.mod" ,(local-file "go.mod"))
                ("LICENSE" ,(local-file "LICENSE"))
                ("go.sum" ,(local-file "go.sum"))
                ("count.go" ,(local-file "count.go"))
                ("count_test.go" ,(local-file "count_test.go"))
                ("cmd" ,(local-file "cmd" #:recursive? #t)))))

(define count
  (package
    (name "workbench-count")
    (version "0.1.0")
    (source source)
    (build-system gnu-build-system)
    (arguments
     (list #:strip-binaries? #f
           #:phases
           #~(modify-phases %standard-phases
               (delete 'configure)
               (replace 'unpack
                 (lambda _
                   (mkdir "source")
                   (chdir "source")
                   (copy-recursively #$source ".")))
               (replace 'build
                 (lambda _
                   (setenv "HOME" (getcwd))
                   (setenv "CGO_ENABLED" "0")
                   (setenv "GOTOOLCHAIN" "local")
                   (setenv "GOFLAGS" "-mod=readonly")
                   (invoke "go" "build" "-trimpath" "-ldflags=-s -w"
                           "-o" "count" "./cmd/count")))
               (replace 'check (lambda _ (invoke "go" "test" "./...")))
               (replace 'install
                 (lambda _ (install-file "count" (string-append #$output "/bin")))))))
    (native-inputs (list (specification->package "go")))
    (synopsis "Workbench byte-counting reference")
    (description "A static executable demonstrating managed release packaging.")
    (home-page "https://example.com/workbench")
    (license asl2.0)))

count

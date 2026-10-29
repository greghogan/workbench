(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "php"))

(package
  (name "workbench-php-reference")
  (version "0.1.0")
  (source (local-file "." "php-reference-source" #:recursive? #t
                        #:select? (lambda (file stat)
                                    (not (member (basename file)
                                                 '(".git" "node_modules" "build" "dist" "coverage"
                                                   ".venv" "__pycache__" "target"))))))
  (build-system gnu-build-system)
  (arguments
   (list #:phases
         #~(modify-phases %standard-phases
             (delete 'configure)
             (replace 'build (lambda _ #t))
             (replace 'check (lambda _
             (invoke "php" "-r"
                     "require 'src/Arithmetic.php'; if (WorkbenchReference\\Arithmetic::sum([20,22]) !== 42 || WorkbenchReference\\Arithmetic::countByte('banana',97) !== 3) exit(1);")))
             (replace 'install (lambda* (#:key inputs #:allow-other-keys)
               (copy-recursively "src" (string-append #$output "/src"))
               (mkdir-p (string-append #$output "/bin"))
               (copy-file "bin/count" (string-append #$output "/bin/count.php"))
               (call-with-output-file (string-append #$output "/bin/count")
                 (lambda (port)
                   (format port "#!~a~%exec ~a ~a/bin/count.php \"$@\"~%"
                           (search-input-file inputs "/bin/sh")
                           #$(file-append runtime "/bin/php") #$output)))
               (chmod (string-append #$output "/bin/count") #o755))))))
  (native-inputs (map specification->package '()))
  (propagated-inputs (list runtime))
  (synopsis "Workbench php reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "python-next@3.13"))

(package
  (name "workbench-python-reference")
  (version "0.1.0")
  (source (local-file "." "python-reference-source" #:recursive? #t
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
             (setenv "PYTHONPATH" (string-append (getcwd) "/src"))
             (invoke "python3" "-m" "unittest" "discover" "-s" "tests" "-v")))
             (replace 'install (lambda _
               (let ((destination (string-append #$output "/lib/python"
                                                #$(version-major+minor (package-version runtime))
                                                "/site-packages/workbench_python_reference")))
                 (mkdir-p (dirname destination))
                 (copy-recursively "src/workbench_python_reference" destination)))))))
  (native-inputs (map specification->package '()))
  (propagated-inputs (list runtime))
  (synopsis "Workbench python reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

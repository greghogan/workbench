(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "ruby@4.0"))

(package
  (name "workbench-ruby-reference")
  (version "0.1.0")
  (source (local-file "." "ruby-reference-source" #:recursive? #t
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
             (invoke "ruby" "-Ilib" "-rworkbench_ruby_reference" "-e"
                     "abort unless WorkbenchRubyReference.sum([20,22]) == 42; abort unless WorkbenchRubyReference.count_byte('banana',97) == 3")))
             (replace 'install (lambda* (#:key inputs #:allow-other-keys)
               (copy-recursively "lib" (string-append #$output "/lib"))
               (install-file "bin/count" (string-append #$output "/bin"))
               (wrap-program (string-append #$output "/bin/count")
                 `("RUBYLIB" prefix (,(string-append #$output "/lib")))))))))
  (native-inputs (map specification->package '()))
  (propagated-inputs (list runtime))
  (synopsis "Workbench ruby reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "openjdk"))

(package
  (name "workbench-java-reference")
  (version "0.1.0")
  (source (local-file "." "java-reference-source" #:recursive? #t
                        #:select? (lambda (file stat)
                                    (not (member (basename file)
                                                 '(".git" "node_modules" "build" "dist" "coverage"
                                                   ".venv" "__pycache__" "target"))))))
  (build-system gnu-build-system)
  (arguments
   (list #:phases
         #~(modify-phases %standard-phases
             (delete 'configure)
             (replace 'build (lambda _
             (invoke "node" "scripts/build-managed.mjs")))
             (replace 'check (lambda _
             (invoke "java" "-jar" "build/count.jar" "97" "banana")))
             (replace 'install (lambda* (#:key inputs #:allow-other-keys)
               (install-file "build/count.jar" (string-append #$output "/share/java"))
               (mkdir-p (string-append #$output "/bin"))
               (call-with-output-file (string-append #$output "/bin/count")
                 (lambda (port)
                   (format port "#!~a~%exec ~a -jar ~a/share/java/count.jar \"$@\"~%"
                           (search-input-file inputs "/bin/sh")
                           #$(file-append runtime "/bin/java") #$output)))
               (chmod (string-append #$output "/bin/count") #o755))))))
  (native-inputs `(("jdk" ,runtime "jdk") ("node" ,(specification->package "node"))))
  (propagated-inputs (list runtime))
  (synopsis "Workbench java reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

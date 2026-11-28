(use-modules (guix packages)
             (guix gexp)
             (guix build-system cmake)
             ((guix licenses) #:prefix license:)
             (gnu packages))
(include "guix-toolchain.scm")

(define yyjson-reference
  (let ((base (latest "yyjson")))
    (package/inherit base
      (arguments
       (substitute-keyword-arguments (package-arguments base)
         ;; CTest's parallel launch gate measures the host, including unrelated jobs.
         ((#:parallel-tests? _ #t) #f))))))

(define reference-package
  (with-selected-gcc
   (package
     (name "workbench-c-reference")
     (version "0.1.0")
     (source (file-union "c-reference-source"
                         `(("CMakeLists.txt" ,(local-file "CMakeLists.txt"))
                           ("README.md" ,(local-file "README.md"))
                        ("LICENSE" ,(local-file "LICENSE"))
                           ("src" ,(local-file "src" #:recursive? #t))
                           ("include" ,(local-file "include" #:recursive? #t))
                           ("tests" ,(local-file "tests" #:recursive? #t)))))
     (build-system cmake-build-system)
     (arguments
      (list #:generator "Ninja"
            #:cmake selected-cmake
            #:phases
            #~(modify-phases %standard-phases
                (replace 'check
                  (lambda _
                    ;; Unrelated host load must not stall these isolated tests.
                    (invoke "ctest" "--output-on-failure" "--no-tests=error"
                            "-j" (number->string (parallel-job-count))))))
            #:configure-flags
            #~(list "-DWORKBENCH_COMPILER_FAMILY=gcc"
                    "-DCMAKE_C_COMPILER=gcc" "-DCMAKE_CXX_COMPILER=g++"
                    "-DWORKBENCH_LTO=full")))
     (native-inputs (list selected-ninja))
     (inputs (list (with-selected-gcc yyjson-reference)))
     (synopsis "Workbench C byte-counting reference")
     (description "A C example with independently selectable managed packaging.")
     (home-page "https://github.com/greghogan/workbench")
     (license license:asl2.0))))

reference-package

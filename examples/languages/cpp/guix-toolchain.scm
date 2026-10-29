(use-modules (guix packages)
             (guix gexp)
             (guix utils)
             (guix build-system gnu)
             (gnu packages)
             (gnu packages llvm)
             (srfi srfi-1))

;; "Latest" is resolved within channels.scm, never from the host installation.
(define (latest name)
  (first (find-packages-by-name name)))

(define selected-gcc-toolchain (latest "gcc-toolchain"))
(define channel-gcc (lookup-package-input selected-gcc-toolchain "gcc"))

;; This channel's GCC 16.2 misdetects libc's C99 support while configuring libstdc++.
;; Isolate bootstrap headers as Guix already does for affected older GCC recipes.
;; Remove this variant after a channel update passes the installed-compiler check unchanged.
(define selected-gcc
  (if (string=? (package-version channel-gcc) "16.2.0")
      (package/inherit channel-gcc
        (arguments
         (substitute-keyword-arguments (package-arguments channel-gcc)
           ((#:phases phases)
            #~(modify-phases #$phases
               (add-after 'set-paths 'isolate-bootstrap-cxx-headers
                 (lambda* (#:key inputs #:allow-other-keys)
                   (let* ((libc (assoc-ref inputs "libc"))
                          (bootstrap (assoc-ref inputs "gcc"))
                          (excluded (list (string-append libc "/include")
                                          (string-append bootstrap "/include/c++")))
                          (paths (filter (lambda (path) (not (member path excluded)))
                                         (string-split (or (getenv "CPLUS_INCLUDE_PATH") "") #\:))))
                     (if (null? paths)
                         (unsetenv "CPLUS_INCLUDE_PATH")
                         (setenv "CPLUS_INCLUDE_PATH" (string-join paths ":"))))))
               (add-after 'install 'verify-installed-cxx-library
                 (lambda* (#:key outputs #:allow-other-keys)
                   (call-with-output-file "workbench-cxx-library.cpp"
                     (lambda (port)
                       (display "#include <cmath>\n#include <cstdlib>\nint main() { return std::isfinite(std::strtold(\"1\", nullptr)) ? 0 : 1; }\n" port)))
                   (invoke (string-append (assoc-ref outputs "out") "/bin/g++")
                           "-std=c++20" "workbench-cxx-library.cpp" "-o" "workbench-cxx-library")
                   (invoke "./workbench-cxx-library"))))))))
      channel-gcc))

(define (with-selected-gcc base)
  (package/inherit base
    (arguments
     (substitute-keyword-arguments (package-arguments base)
       ((#:implicit-inputs? _ #f) #f)))
    (inputs
     (append (modify-inputs (package-inputs base) (delete "gcc-lib"))
             `(("gcc" ,selected-gcc)
               ("gcc-lib" ,selected-gcc "lib"))
             (alist-delete "gcc" (standard-packages))))))

(define channel-clang (latest "clang"))
(define selected-clang
  (if (and (eq? selected-gcc (lookup-package-input channel-clang "gcc-lib"))
           (eq? selected-gcc (cadr (assoc "gcc" (standard-packages)))))
      channel-clang
      (with-selected-gcc channel-clang)))
(define selected-llvm (lookup-package-propagated-input selected-clang "llvm"))
(define selected-clang-toolchain
  (make-clang-toolchain selected-clang
                       (specification->package
                        (string-append "libomp@" (package-version selected-clang)))))
(define selected-lldb
  (with-selected-gcc
   ((package-input-rewriting `((,channel-clang . ,selected-clang)))
    (latest "lldb"))))

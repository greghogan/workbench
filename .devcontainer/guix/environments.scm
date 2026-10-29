;; Each channel group builds one graph; final assembly only combines already-realized store profiles.
(use-modules (guix packages) (guix profiles) (guix gexp) (guix build-system trivial)
             ((guix licenses) #:prefix license:) (json) (srfi srfi-1))

(define roots
  (vector->list (call-with-input-file (getenv "WORKBENCH_ROOTS_FILE") json->scm)))
(define declarations
  (and (getenv "WORKBENCH_GUIX_PROFILES_FILE")
       (vector->list (call-with-input-file (getenv "WORKBENCH_GUIX_PROFILES_FILE") json->scm))))
(define profiles
  (if declarations
      (map (lambda (entry) (assoc-ref entry "profile")) declarations)
      (map (lambda (root)
         (profile
          (content
           (save-module-excursion
            (lambda ()
              (set-current-module (make-fresh-user-module))
              (primitive-load (string-append (getcwd) "/" root "/manifest.scm")))))))
       roots)))
(define runtimes
  (if declarations
      (map (lambda (entry) (assoc-ref entry "runtime")) declarations)
      (map (lambda (_) (canonicalize-path (getenv "WORKBENCH_GUIX_TIME_MACHINE_PROFILE"))) roots)))

(package
  (name "workbench-environments")
  (version "1")
  (source #f)
  (build-system trivial-build-system)
  (arguments
   (list #:modules '((guix build utils))
         #:builder
         #~(begin
             (use-modules (guix build utils))
             (let ((directory (string-append #$output "/share/workbench/environments")))
               (mkdir-p directory)
               (mkdir-p (string-append directory "/runtimes"))
               (copy-file #$(local-file (getenv "WORKBENCH_ROOTS_FILE"))
                          (string-append directory "/roots.json"))
               (for-each
                (lambda (index profile runtime)
                  (symlink profile (string-append directory "/" (number->string index)))
                  (symlink runtime (string-append directory "/runtimes/" (number->string index))))
                (iota #$(length roots))
                (list #$@profiles)
                (list #$@runtimes))))))
  (home-page "https://github.com/greghogan/workbench")
  (synopsis "Declared project development environments")
  (description "Separate per-root profiles retained together as one managed dependency graph.")
  (license license:asl2.0))

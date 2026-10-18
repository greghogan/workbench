(use-modules (guix profiles))
(packages->manifest
 (list (load (string-append (dirname (current-filename)) "/package.scm"))))

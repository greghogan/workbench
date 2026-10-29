(use-modules (guix profiles) (gnu packages bash))
(packages->manifest
 (list (load (string-append (dirname (current-filename)) "/package.scm")) bash-minimal))

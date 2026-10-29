;; Add interactive tools without retaining duplicate implicit build inputs.

(use-modules (gnu packages) (guix packages) (guix profiles))

(define development-inputs
  (package->development-manifest
   (load (string-append (dirname (current-filename)) "/package.scm"))))

(manifest-add
 (manifest-add
  ;; The JRE output also supplies bin/java and would shadow the JDK's compiler modules.
  (manifest-remove development-inputs
                   (list (manifest-pattern (name "openjdk") (output "out"))))
  (manifest-entries
   (concatenate-manifests
    (list (specifications->manifest
           '("bash"
             "coreutils"
             "git"
             "maven"
             "openjdk:jdk"
             "node"
             "nss-certs"))
          (specifications->manifest '("openssh" "rsync" "which" "less" "vim"))))))
 (list (package->manifest-entry
        (load (string-append (dirname (current-filename)) "/check-inputs.scm")))))

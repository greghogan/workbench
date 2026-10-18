(use-modules (guix packages) (guix profiles) (guix gexp) (guix build-system trivial)
             (gnu packages) ((guix licenses) #:prefix license:))

(define environments
  (load (string-append (dirname (current-filename)) "/environments.scm")))
(define bootstrap
  (profile
   (content (specifications->manifest
             '("bash" "coreutils" "findutils" "grep" "sed" "git" "gnupg"
               "node" "nss-certs" "tar" "gzip" "xz" "which")))))
(define runtime (canonicalize-path (getenv "WORKBENCH_GUIX_TIME_MACHINE_PROFILE")))
(define libc (specification->package "glibc"))

(define layout
  (package
    (name "workbench-container-layout")
    (version "1")
    (source #f)
    (build-system trivial-build-system)
    (arguments
     (list #:modules '((guix build utils))
           #:builder
           #~(begin
               (use-modules (guix build utils))
               (let ((bin (string-append #$output "/bin"))
                     (etc (string-append #$output "/etc")))
                 (mkdir-p bin)
                 (mkdir-p etc)
                 (mkdir-p (string-append #$output "/usr"))
                 (symlink (string-append #$bootstrap "/bin") (string-append #$output "/usr/bin"))
                 (call-with-output-file (string-append etc "/passwd")
                   (lambda (port)
                     (display "root:x:0:0:root:/root:/bin/bash\nworkbench:x:1000:1000:Workbench:/home/workbench:/bin/bash\n" port)
                     (do ((index 1 (+ index 1))) ((> index 64))
                       (format port "guixbuilder~a:x:~a:30000:Guix builder:/var/empty:/bin/false~%" index (+ 30000 index)))))
                 (call-with-output-file (string-append etc "/group")
                   (lambda (port)
                     (display "root:x:0:\nworkbench:x:1000:\nguixbuild:x:30000:" port)
                     (do ((index 1 (+ index 1))) ((> index 64))
                       (format port "~aguixbuilder~a" (if (= index 1) "" ",") index))
                     (newline port)))
                 (call-with-output-file (string-append etc "/os-release")
                   (lambda (port) (display "ID=guix\nNAME=\"Guix development container\"\n" port)))
                 (mkdir-p (string-append #$output "/lib64"))
                 (for-each (lambda (file)
                             (symlink file (string-append #$output "/lib64/" (basename file))))
                           (find-files (string-append #$libc "/lib") "^ld-linux.*\\.so\\.[0-9]+$"))
                 (mkdir-p (string-append #$output "/opt"))
                 (symlink #$runtime (string-append #$output "/opt/workbench-guix"))
                 (symlink (string-append #$environments "/share/workbench/environments")
                          (string-append #$output "/opt/workbench-environments"))
                 (call-with-output-file (string-append bin "/workbench-start")
                   (lambda (port)
                     (format port "#!~a/bin/bash~%set -eu~%" #$bootstrap)
                     (display "mkdir -p /tmp /home/workbench /root /opt/workbench/cache /opt/workbench/data /opt/workbench/state /var/empty\nchmod 1777 /tmp\nchown -R 1000:1000 /home/workbench /opt/workbench/cache /opt/workbench/data /opt/workbench/state\nulimit -n 65536\nexec /opt/workbench-guix/bin/guix-daemon --build-users-group=guixbuild\n" port)))
                 (chmod (string-append bin "/workbench-start") #o755)))))
    (home-page "https://github.com/greghogan/workbench")
    (synopsis "Guix development container layout")
    (description "Bootstrap tools, account files, and separate project profiles for a Guix development image.")
    (license license:asl2.0)))

(manifest-add (profile-content bootstrap) (list (package->manifest-entry layout)))

;; The same verified upstream engine as native, with a Guix-owned runtime closure.
(use-modules (gnu packages) (guix packages) (guix download) (guix gexp)
             ((gnu packages gcc) #:prefix cc:)
             (guix base16) (guix utils) (guix build-system trivial)
             ((guix licenses) #:prefix license:) (json) (ice-9 regex) (ice-9 rdelim))

(let* ((root (dirname (current-filename)))
       (version (call-with-input-file (string-append root "/.tool-versions")
                  (lambda (port)
                    (let loop ((line (read-line port)))
                      (if (eof-object? line) (error "Missing Headless Shell pin")
                          (let ((match (string-match "^[ \t]*chromium-headless-shell[ \t]+([0-9.]+)[ \t]*(#.*)?$" line)))
                            (if match (match:substring match 1) (loop (read-line port)))))))))
       (platform (cond ((string=? (%current-system) "x86_64-linux") "linux-x64")
                       ((string=? (%current-system) "aarch64-linux") "linux-arm64")
                       (else (error "Headless Shell requires Linux x64 or ARM64"))))
       (asset (assoc-ref (assoc-ref (assoc-ref
                       (call-with-input-file (string-append root "/scripts/native-assets.json") json->scm)
                       "chromium-headless-shell") version) platform))
       (libraries (map specification->package
                       '("glib" "nspr" "nss" "dbus" "at-spi2-core"
                         "mesa" "expat" "libxkbcommon" "eudev" "alsa-lib" "fontconfig"
                         "libx11" "libxcomposite" "libxdamage" "libxext" "libxfixes" "libxrandr" "libxcb")))
       (libc (specification->package "glibc"))
       (compiler cc:gcc)
       (fonts (specification->package "font-dejavu"))
       (source (origin
                 (method url-fetch)
                 (uri (assoc-ref asset "url"))
                 (sha256 (base16-string->bytevector (assoc-ref asset "sha256"))))))
  (package
    (name "workbench-headless-shell")
    (version version)
    (source source)
    (build-system trivial-build-system)
    (arguments
     (list #:modules '((guix build utils) (srfi srfi-1) (ice-9 ftw))
           #:builder
           #~(begin
               (use-modules (guix build utils) (srfi srfi-1) (ice-9 ftw))
               (let* ((destination (string-append #$output "/libexec/workbench-headless-shell"))
                      (binary (string-append destination "/chrome-headless-shell"))
                      (paths (append (append-map (lambda (package)
                                                   (list (string-append package "/lib")
                                                         (string-append package "/lib/nss")))
                                                '#$libraries)
                                     (list (string-append #$libc "/lib")
                                           (string-append #$compiler:lib "/lib"))))
                      (rpath (string-join paths ":"))
                      (loader (car (find-files (string-append #$libc "/lib") "^ld-linux.*\\.so\\.[0-9]+$"))))
                 (setenv "PATH" (string-append #$(specification->package "unzip") "/bin:"
                                               #$(specification->package "patchelf") "/bin"))
                 (invoke "unzip" "-q" #$source "-d" "unpacked")
                 (mkdir-p (dirname destination))
                 (copy-recursively (car (find-files "unpacked" "^chrome-headless-shell-" #:directories? #t)) destination)
                 (chmod binary #o755)
                 (invoke "patchelf" "--set-interpreter" loader "--set-rpath" rpath binary)
                 (for-each (lambda (file) (invoke "patchelf" "--set-rpath" rpath file))
                           (find-files destination "\\.so$"))
                 (mkdir-p (string-append #$output "/bin"))
                 (let ((config (string-append #$output "/fonts.conf")))
                   (call-with-output-file config
                     (lambda (port)
                       (format port "<fontconfig><include>~a/etc/fonts/fonts.conf</include><dir>~a/share/fonts</dir><cachedir prefix=\"xdg\">fontconfig</cachedir></fontconfig>"
                               #$(specification->package "fontconfig") #$fonts)))
                   (call-with-output-file (string-append #$output "/bin/chrome-headless-shell")
                     (lambda (port)
                       (format port "#!~a/bin/sh\nexport FONTCONFIG_FILE=~s\nexport LD_LIBRARY_PATH=~s\nexec ~s \"$@\"\n"
                               #$(specification->package "bash-minimal") config rpath binary))))
                 (chmod (string-append #$output "/bin/chrome-headless-shell") #o755)))))
    (home-page "https://developer.chrome.com/docs/chromium/headless")
    (synopsis "Pinned browser engine for Workbench browser integration tests")
    (description "Chrome Headless Shell with a Guix runtime closure, without the desktop Chrome user interface.")
    (license (list license:bsd-3 license:lgpl2.1+ license:mpl2.0))))

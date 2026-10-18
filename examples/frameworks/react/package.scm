(use-modules (guix packages) (guix gexp) (guix download)
             (guix build-system gnu) (guix base64) (json)
             ((guix licenses) #:prefix license:) (gnu packages))

(define runtime-inputs
  (map (lambda (entry)
         (let ((name (assoc-ref entry "name"))
               (version (assoc-ref entry "version")))
           (list name
                 (origin
                   (method url-fetch)
                   (uri (assoc-ref entry "url"))
                   (file-name (string-append name "-" version ".tgz"))
                   (hash (content-hash
                          (base64-decode (substring (assoc-ref entry "integrity") 7))
                          sha512))))))
       (vector->list
        (call-with-input-file
            (string-append (dirname (current-filename)) "/managed-dependencies.json")
          json->scm))))

(package
  (name "workbench-react-example")
  (version "0.1.0")
  (source (local-file "." "react-example-source" #:recursive? #t
                      #:select? (lambda (file stat)
                                  (not (member (basename file)
                                               '("node_modules" "build" "dist" "coverage" ".git"))))))
  (build-system gnu-build-system)
  (arguments
   (list
    ;; The release verifier exercises the built site in a fresh DOM outside the builder.
    #:tests? #f
    #:phases
    #~(modify-phases %standard-phases
        (delete 'configure)
        (add-before 'build 'unpack-runtime-dependencies
          (lambda* (#:key inputs #:allow-other-keys)
            (for-each
             (lambda (name)
               (let ((destination (string-append "node_modules/" name)))
                 (mkdir-p destination)
                 (invoke "tar" "xzf" (assoc-ref inputs name)
                         "--strip-components=1" "-C" destination)))
             '("react" "react-dom" "scheduler"))))
        (replace 'build (lambda _ (invoke "node" "scripts/build-managed.mjs")))
        (replace 'install
          (lambda _
            (copy-recursively "build" (string-append #$output "/share/site")))))))
  (native-inputs
   `(("node" ,(specification->package "node"))
     ("esbuild" ,(specification->package "esbuild"))
     ,@runtime-inputs))
  (synopsis "Workbench React static site")
  (description "A production static site with runtime sources pinned by pnpm-lock.yaml.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))

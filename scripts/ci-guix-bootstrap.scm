;; Use the bootstrap's native channel authentication and inferior cache layout.
(use-modules (guix channels) (guix inferior) (guix store) (ice-9 match))

(match (cdr (command-line))
  (("cache-directory")
   (display (%inferior-cache-directory)))
  (("register-root" path)
   (with-store store (add-indirect-root store path)))
  (("register-roots" paths ...)
   (with-store store (for-each (lambda (path) (add-indirect-root store path)) paths)))
  (("profile" channels cpus)
   (with-store store
     (set-build-options store #:build-cores (string->number cpus)
                        #:max-build-jobs 1)
     (display (cached-channel-instance store (load channels)))))
  (_ (error "expected cache-directory, register-root PATH, or profile CHANNELS CPUS")))
